import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { AnchorAmmQ425 } from "../target/types/anchor_amm_q4_25";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";

describe("anchor-amm-q4-25", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorAmmQ425 as Program<AnchorAmmQ425>;

  const decimals = 6;
  const payer = provider.wallet;
  const user = payer; // for simplicity, we use the same wallet as user

  // Parameters
  const seed = new BN(Date.now());
  const feeBps = 30; // 0.3%

  let mintX: PublicKey;
  let mintY: PublicKey;
  let mintLp: PublicKey;

  let configPDA: PublicKey;
  let configBump: number;

  let vaultX: PublicKey;
  let vaultY: PublicKey;

  let userX: PublicKey;
  let userY: PublicKey;
  let userLp: PublicKey;

  // Helper: fetch LP mint supply as number
  async function fetchLpSupply(): Promise<number> {
    const resp = await provider.connection.getTokenSupply(mintLp);
    // resp.value.amount is a string; safe to convert to Number for our test sizes
    return Number(resp.value.amount);
  }

  before(async () => {
    // create mints
    mintX = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6,
    );

    mintY = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6,
    );

    // PDA config
    [configPDA, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

    // LP mint PDA.
    [mintLp] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), seed.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

    // Vault ATAs (associated token accounts for the config PDA)
    vaultX = getAssociatedTokenAddressSync(mintX, configPDA, true);
    vaultY = getAssociatedTokenAddressSync(mintY, configPDA, true);

    // User ATAs
    userX = getAssociatedTokenAddressSync(mintX, user.publicKey);
    userY = getAssociatedTokenAddressSync(mintY, user.publicKey);
    userLp = getAssociatedTokenAddressSync(mintLp, user.publicKey);

    // Create user token accounts
    await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintX,
      user.publicKey,
    );

    await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintY,
      user.publicKey,
    );

    // mint tokens to user
    await mintTo(
      provider.connection,
      payer.payer,
      mintX,
      userX,
      payer.publicKey,
      1e12, // 1,000,000 X (scaled by decimals)
    );

    await mintTo(
      provider.connection,
      payer.payer,
      mintY,
      userY,
      payer.publicKey,
      1e12, // 1,000,000 Y (scaled by decimals)
    );
  });

  it("1. Initializes the AMM pool successfully", async () => {
    await program.methods
      .initialize(seed, feeBps, null)
      .accounts({
        initializer: user.publicKey,
        mintX,
        mintY,
        mintLp,
        vaultX,
        vaultY,
        config: configPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configData = await program.account.config.fetch(configPDA);
    assert.equal(configData.seed.toNumber(), seed.toNumber());
    assert.equal(configData.fee, feeBps);
    assert.equal(configData.locked, false);
    assert.equal(configData.mintX.toBase58(), mintX.toBase58());
    assert.equal(configData.mintY.toBase58(), mintY.toBase58());

    // LP supply should be zero on initialization
    const lpSupply = await fetchLpSupply();
    assert.equal(lpSupply, 0, "LP supply must be 0 after init");
  });

  it("2. Performs initial deposit (first liquidity provider)", async () => {
    const maxX = new BN(1_000 * 10 ** decimals); // 1000 X (scaled)
    const maxY = new BN(1_000 * 10 ** decimals); // 1000 Y (scaled)
    const amountLp = new BN(1_000 * 1_000 * 10 ** decimals); // maxX * maxY LP (current contract logic)

    // capture lp before deposit
    const lpBefore = await fetchLpSupply();

    await program.methods
      .deposit(amountLp, maxX, maxY)
      .accounts({
        user: user.publicKey,
        mintX,
        mintY,
        config: configPDA,
        mintLp,
        vaultX,
        vaultY,
        userX,
        userY,
        userLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultXAcc = await getAccount(provider.connection, vaultX);
    const vaultYAcc = await getAccount(provider.connection, vaultY);
    const userLpAcc = await getAccount(provider.connection, userLp);

    assert.equal(Number(vaultXAcc.amount), 1_000 * 10 ** decimals);
    assert.equal(Number(vaultYAcc.amount), 1_000 * 10 ** decimals);
    assert.equal(Number(userLpAcc.amount), 1_000 * 1_000 * 10 ** decimals);

    // check lp mint supply updated by deposit
    const lpAfter = await fetchLpSupply();
    const expectedLpMinted = Number(amountLp.toNumber());
    assert.equal(
      lpAfter,
      lpBefore + expectedLpMinted,
      "LP supply should increase by minted LP after initial deposit",
    );
  });

  it("3. Performs a swap X → Y", async () => {
    const amountIn = new BN(100_000_000); // 100 X (scaled)
    const minOut = new BN(90_000_000); // expect at least ~99 (without fee) -> comment translated

    const vaultXBefore = (await getAccount(provider.connection, vaultX)).amount;
    const vaultYBefore = (await getAccount(provider.connection, vaultY)).amount;
    const lpBefore = await fetchLpSupply();

    await program.methods
      .swap(true, amountIn, minOut) // is_x = true
      .accounts({
        user: user.publicKey,
        mintX,
        mintY,
        config: configPDA,
        vaultX,
        vaultY,
        userX: userX,
        userY: userY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultXAfter = (await getAccount(provider.connection, vaultX)).amount;
    const vaultYAfter = (await getAccount(provider.connection, vaultY)).amount;
    const lpAfter = await fetchLpSupply();

    assert.equal(Number(vaultXAfter), Number(vaultXBefore) + 100_000_000);
    assert.isBelow(Number(vaultYAfter), Number(vaultYBefore));
    assert.isAbove(
      Number(vaultYAfter),
      Number(vaultYBefore) - 100_000_000,
      "Vault Y should not decrease by more than the input amount (sanity)",
    );

    // LP supply must NOT change during swaps
    assert.equal(
      lpAfter,
      lpBefore,
      "LP supply must not change during swap X->Y",
    );
  });

  it("4. Performs a swap Y → X", async () => {
    const amountIn = new BN(50_000_000); // 50 Y
    const minOut = new BN(45_000_000);

    const lpBefore = await fetchLpSupply();
    const userXAccBefore = await getAccount(provider.connection, userX);

    await program.methods
      .swap(false, amountIn, minOut) // is_x = false
      .accounts({
        user: user.publicKey,
        mintX,
        mintY,
        config: configPDA,
        vaultX,
        vaultY,
        userX: userX,
        userY: userY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Simply check that transaction succeeded and balances changed
    const userXAcc = await getAccount(provider.connection, userX);
    assert.isAbove(Number(userXAcc.amount), Number(userXAccBefore.amount));

    // LP supply must remain unchanged after swap
    const lpAfter = await fetchLpSupply();
    assert.equal(lpAfter, lpBefore, "LP supply must not change during swap Y->X");
  });

  it("5. Adds more liquidity (second deposit)", async () => {
    const amountLp = new BN(600 * 600 * 10 ** decimals); // want X * Y LP
    const maxX = new BN(600 * 10 ** decimals); // want at most 600 X
    const maxY = new BN(600 * 10 ** decimals); // want at most 600 Y

    const userLpBefore = (await getAccount(provider.connection, userLp)).amount;
    const lpBefore = await fetchLpSupply();

    await program.methods
      .deposit(amountLp, maxX, maxY)
      .accounts({
        user: user.publicKey,
        mintX,
        mintY,
        config: configPDA,
        mintLp,
        vaultX,
        vaultY,
        userX: userX,
        userY: userY,
        userLp: userLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const userLpAfter = (await getAccount(provider.connection, userLp)).amount;
    assert.equal(
      Number(userLpAfter),
      Number(userLpBefore) + 600 * 600 * 10 ** decimals,
    );

    // check LP mint supply increased by the expected LP minted amount
    const lpAfter = await fetchLpSupply();
    const expectedNewLp = Number(amountLp.toNumber());
    assert.equal(
      lpAfter,
      lpBefore + expectedNewLp,
      "LP supply must increase by the LP minted amount on second deposit",
    );
  });

  it("6. Withdraws liquidity", async () => {
    const lpAmount = new BN(100 * 100 * 10 ** decimals); // burn X * Y LP
    const minX = new BN(100 * 10 ** decimals); // want at least 100 X
    const minY = new BN(100 * 10 ** decimals); // want at least 100 Y

    const userXBefore = (await getAccount(provider.connection, userX)).amount;
    const userYBefore = (await getAccount(provider.connection, userY)).amount;
    const lpBefore = await fetchLpSupply();
    const userLpBefore = (await getAccount(provider.connection, userLp)).amount;

    await program.methods
      .withdraw(lpAmount, minX, minY)
      .accounts({
        user: user.publicKey,
        mintX,
        mintY,
        config: configPDA,
        mintLp,
        vaultX,
        vaultY,
        userX: userX,
        userY: userY,
        userLp: userLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userXAfter = (await getAccount(provider.connection, userX)).amount;
    const userYAfter = (await getAccount(provider.connection, userY)).amount;
    const lpAfter = await fetchLpSupply();
    const userLpAfter = (await getAccount(provider.connection, userLp)).amount;

    assert.isAbove(Number(userXAfter), Number(userXBefore));
    assert.isAbove(Number(userYAfter), Number(userYBefore));

    // LP supply must be reduced by burned amount
    const expectedBurn = Number(lpAmount.toNumber());
    assert.equal(
      lpAfter,
      lpBefore - expectedBurn,
      "LP supply must decrease by the burned LP amount on withdraw",
    );

    // user's LP token balance must decrease by burned amount
    assert.equal(
      Number(userLpAfter),
      Number(userLpBefore) - expectedBurn,
      "User's LP token account must be debited by the burned amount",
    );
  });

  it("7. Fails on too high min amount out (slippage protection)", async () => {
    const amountIn = new BN(1e10);
    const minOutTooHigh = new BN(1e12); // not realistic given the pool state

    const lpBefore = await fetchLpSupply();
    let failed = false;
    try {
      await program.methods
        .swap(true, amountIn, minOutTooHigh)
        .accounts({
          user: user.publicKey,
          mintX,
          mintY,
          config: configPDA,
          vaultX,
          vaultY,
          userX: userX,
          userY: userY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (err) {
      failed = true;
      assert.include(err.message, "SlippageExceeded");
    }

    // LP supply should remain unchanged after failed swap attempt
    const lpAfter = await fetchLpSupply();
    assert.isTrue(failed, "Transaction should have failed due to slippage");
    assert.equal(lpAfter, lpBefore, "LP supply must not change on failed swap");
  });
});
