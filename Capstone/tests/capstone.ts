import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import { Solvency } from "../target/types/solvency";

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const programId = new PublicKey("2s6CLnLvfbYe1ubUFVrjWwEC3s86jQfEyqhpqkvLe23B");

const provider = anchor.AnchorProvider.local("http://127.0.0.1:8899");
anchor.setProvider(provider);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function findPlanPda(creator: PublicKey, seed: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("plan"), creator.toBuffer(), Buffer.from(seed)],
    programId
  );
}

function findVaultPda(planPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), planPda.toBuffer()],
    programId
  );
}

function findUserSubscriptionPda(planPda: PublicKey, user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_subscription"), planPda.toBuffer(), user.toBuffer()],
    programId
  );
}

function findMetadataPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
}

function findMasterEditionPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from("edition"),
    ],
    METADATA_PROGRAM_ID
  );
}

describe("solvency", () => {
  const program = anchor.workspace.Solvency as Program<Solvency>;
  const payer = provider.wallet as anchor.Wallet;

  async function createMint(decimals: number): Promise<PublicKey> {
    const mintKp = Keypair.generate();
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(82);
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKp.publicKey,
        lamports,
        space: 82,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mintKp.publicKey, decimals, payer.publicKey, null)
    );
    await provider.sendAndConfirm(tx, [mintKp]);
    return mintKp.publicKey;
  }

  async function createTokenAccount(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const tx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, []);
    return ata;
  }

  async function mintTokens(mint: PublicKey, destination: PublicKey, amount: number | bigint) {
    const tx = new anchor.web3.Transaction().add(
      createMintToInstruction(mint, destination, payer.publicKey, BigInt(amount), [], TOKEN_PROGRAM_ID)
    );
    await provider.sendAndConfirm(tx, []);
  }

  async function createPlan(
    paymentMint: PublicKey,
    nftCollection: PublicKey,
    upfrontPercentage: number,
    vestingDuration: number,
    planSeed: string
  ): Promise<{ planPda: PublicKey; vaultPda: PublicKey }> {
    const creator = payer.publicKey;
    const [planPda] = findPlanPda(creator, planSeed);
    const [vaultPda] = findVaultPda(planPda);

    await program.methods
      .createPlan(planSeed, upfrontPercentage, new BN(vestingDuration), nftCollection)
      .accounts({
        plan: planPda,
        creator,
        paymentMint,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { planPda, vaultPda };
  }

  async function buySubscription(
    planPda: PublicKey,
    vaultPda: PublicKey,
    user: Keypair,
    userTokenAccount: PublicKey,
    nftMint: Keypair,
    amount: number,
    name: string,
    symbol: string,
    uri: string,
    paymentMint: PublicKey,
    creatorToken: PublicKey
  ) {
    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    const nftAta = getAssociatedTokenAddressSync(nftMint.publicKey, user.publicKey);
    const [metadataPda] = findMetadataPda(nftMint.publicKey);
    const [masterEditionPda] = findMasterEditionPda(nftMint.publicKey);

    await program.methods
      .buySubscription(new BN(amount), name, symbol, uri)
      .accounts({
        user: user.publicKey,
        plan: planPda,
        vault: vaultPda,
        userToken: userTokenAccount,
        userSubscription: userSubPda,
        nftMint: nftMint.publicKey,
        nftToken: nftAta,
        metadata: metadataPda,
        masterEdition: masterEditionPda,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenMetadataProgram: METADATA_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        creatorToken
      })
      .signers([user, nftMint])
      .rpc();
  }

  it("create plan success", async () => {
    const paymentMint = await createMint(6);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 20;
    const vestingDuration = 86400;
    const planSeed = "test_plan";

    const { planPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const plan = await program.account.subscriptionPlan.fetch(planPda);
    assert(plan.creator.equals(payer.publicKey));
    assert(plan.upfrontPercentage === upfrontPercentage);
    assert(plan.vestingDuration.eq(new BN(vestingDuration)));
    assert(plan.paymentMint.equals(paymentMint));
    assert(plan.nftCollection.equals(nftCollection));
  });

  it("buy subscription success", async () => {
    const paymentMint = await createMint(6);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 20;
    const vestingDuration = 86400;
    const planSeed = "buy_test";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    const userSub = await program.account.userSubscription.fetch(userSubPda);
    assert(userSub.totalDepositAmount.eq(new BN(1000)));
    assert(userSub.isActive);

    const vaultAccount = await provider.connection.getTokenAccountBalance(vaultPda);
    assert(vaultAccount.value.amount === "1000");

    const nftAta = getAssociatedTokenAddressSync(nftMint.publicKey, user.publicKey);
    const nftBalance = await provider.connection.getTokenAccountBalance(nftAta);
    assert(nftBalance.value.amount === "1");
  });

  it("renew subscription success", async () => {
    const paymentMint = await createMint(6);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 20;
    const vestingDuration = 86400;
    const planSeed = "renew_test";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 2000);

    const nftMint = Keypair.generate();
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];

    await program.methods
      .renewSubscription(new BN(500))
      .accounts({
        user: user.publicKey,
        plan: planPda,
        vault: vaultPda,
        userToken,
        userSubscription: userSubPda,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userSub = await program.account.userSubscription.fetch(userSubPda);
    assert(userSub.totalDepositAmount.eq(new BN(1500)));
  });

  it("claim tokens success", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 2;
    const planSeed = "claim_test";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1000);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    await program.methods
      .claimTokens()
      .accounts({
        plan: planPda,
        userSubscription: userSubPda,
        vault: vaultPda,
        creatorToken,
        creator: payer.publicKey,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userSub = await program.account.userSubscription.fetch(userSubPda);
    assert(userSub.claimedByCreatorAmount.eq(new BN(500)));

    const creatorBalance = await provider.connection.getTokenAccountBalance(creatorToken);
    assert(creatorBalance.value.amount === "500");
  });

  it("close subscription success", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 2;
    const planSeed = "close_test";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1000);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    const nftAta = getAssociatedTokenAddressSync(nftMint.publicKey, user.publicKey);

    await program.methods
      .closeSubscription()
      .accounts({
        user: user.publicKey,
        plan: planPda,
        userSubscription: userSubPda,
        vault: vaultPda,
        userToken,
        creatorToken,
        nftMint: nftMint.publicKey,
        nftAta,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    try {
      await program.account.userSubscription.fetch(userSubPda);
      assert.fail("User subscription should be closed");
    } catch (e) {}

    const userBalance = await provider.connection.getTokenAccountBalance(userToken);
    assert(userBalance.value.amount === "500");

    const creatorBalance = await provider.connection.getTokenAccountBalance(creatorToken);
    assert(creatorBalance.value.amount === "500");

    const nftMintInfo = await provider.connection.getAccountInfo(nftMint.publicKey);
    assert(nftMintInfo === null);
  });

  it("query unvested balance", async () => {
    const paymentMint = await createMint(6);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 20;
    const vestingDuration = 2;
    const planSeed = "query_test";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1000);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    const userSub = await program.account.userSubscription.fetch(userSubPda);
    const plan = await program.account.subscriptionPlan.fetch(planPda);

    const currentTime = Math.floor(Date.now() / 1000);
    const elapsed = currentTime - userSub.startTime.toNumber();
    const upfront = (plan.upfrontPercentage * userSub.totalDepositAmount.toNumber()) / 100;
    const remaining = userSub.totalDepositAmount.toNumber() - upfront;
    const vestedLinear = (remaining * elapsed) / plan.vestingDuration.toNumber();
    const vested = upfront + vestedLinear;
    const unvested = userSub.totalDepositAmount.toNumber() - vested;

    assert.approximately(unvested, 400, 1);
  });

  it("prevent double spend after burn", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 2;
    const planSeed = "double_spend";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1000);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    const nftAta = getAssociatedTokenAddressSync(nftMint.publicKey, user.publicKey);

    await program.methods
      .closeSubscription()
      .accounts({
        user: user.publicKey,
        plan: planPda,
        userSubscription: userSubPda,
        vault: vaultPda,
        userToken,
        creatorToken,
        nftMint: nftMint.publicKey,
        nftAta,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    try {
      await program.methods
        .closeSubscription()
        .accounts({
          user: user.publicKey,
          plan: planPda,
          userSubscription: userSubPda,
          vault: vaultPda,
          userToken,
          creatorToken,
          nftMint: nftMint.publicKey,
          nftAta,
          paymentMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have failed");
    } catch (e) {
      assert(e.message.includes("AccountNotInitialized") || e.message.includes("does not exist"));
    }
  });

  it("cannot close without ownership", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 2;
    const planSeed = "ownership";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const userA = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(userA.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userAToken = await createTokenAccount(paymentMint, userA.publicKey);
    await mintTokens(paymentMint, userAToken, 1000);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, userA, userAToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, userA.publicKey)[0];
    const nftAta = getAssociatedTokenAddressSync(nftMint.publicKey, userA.publicKey);

    const userB = Keypair.generate();
    const userBToken = await createTokenAccount(paymentMint, userB.publicKey);

    try {
      await program.methods
        .closeSubscription()
        .accounts({
          user: userB.publicKey,
          plan: planPda,
          userSubscription: userSubPda,
          vault: vaultPda,
          userToken: userBToken,
          creatorToken,
          nftMint: nftMint.publicKey,
          nftAta,
          paymentMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userB])
        .rpc();
      assert.fail("Should have failed");
    } catch (e) {
      assert(e.message.includes("Unauthorized") || e.message.includes("ConstraintHasOne"));
    }
  });

  it("cannot claim if not creator", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 2;
    const planSeed = "claim_auth";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1000);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    const wrongCreator = Keypair.generate();
    const wrongCreatorToken = await createTokenAccount(paymentMint, wrongCreator.publicKey);

    try {
      await program.methods
        .claimTokens()
        .accounts({
          plan: planPda,
          userSubscription: userSubPda,
          vault: vaultPda,
          creatorToken: wrongCreatorToken,
          creator: wrongCreator.publicKey,
          paymentMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wrongCreator])
        .rpc();
      assert.fail("Should have failed");
    } catch (e) {
      assert(e.message.includes("Unauthorized") || e.message.includes("ConstraintHasOne"));
    }
  });

  it("unauthorized vault access", async () => {
    const paymentMint = await createMint(6);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 20;
    const vestingDuration = 86400;
    const planSeed = "vault_auth";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const attacker = Keypair.generate();
    const attackerToken = await createTokenAccount(paymentMint, attacker.publicKey);

    const transferIx = createTransferInstruction(vaultPda, attackerToken, attacker.publicKey, 100n, [], TOKEN_PROGRAM_ID);
    const tx = new anchor.web3.Transaction().add(transferIx);

    try {
      await provider.sendAndConfirm(tx, [attacker]);
      assert.fail("Should have failed");
    } catch (e) {
      assert(e.message.includes("0x1") || e.message.includes("Owner mismatch"));
    }
  });

  it("edge case zero upfront", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 2;
    const planSeed = "zero_upfront";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];

    await program.methods
      .claimTokens()
      .accounts({
        plan: planPda,
        userSubscription: userSubPda,
        vault: vaultPda,
        creatorToken,
        creator: payer.publicKey,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    let userSub = await program.account.userSubscription.fetch(userSubPda);
    assert(userSub.claimedByCreatorAmount.eq(new BN(0)));

    await sleep(2000);

    await program.methods
      .claimTokens()
      .accounts({
        plan: planPda,
        userSubscription: userSubPda,
        vault: vaultPda,
        creatorToken,
        creator: payer.publicKey,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    userSub = await program.account.userSubscription.fetch(userSubPda);
    assert(userSub.claimedByCreatorAmount.eq(new BN(1000)));
  });

  it("edge case full upfront", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 100;
    const vestingDuration = 2;
    const planSeed = "full_upfront";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];

    await program.methods
      .claimTokens()
      .accounts({
        plan: planPda,
        userSubscription: userSubPda,
        vault: vaultPda,
        creatorToken,
        creator: payer.publicKey,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userSub = await program.account.userSubscription.fetch(userSubPda);
    assert(userSub.claimedByCreatorAmount.eq(new BN(1000)));
  });

  it("edge case zero duration", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 0;
    const planSeed = "zero_duration";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];

    await program.methods
      .claimTokens()
      .accounts({
        plan: planPda,
        userSubscription: userSubPda,
        vault: vaultPda,
        creatorToken,
        creator: payer.publicKey,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userSub = await program.account.userSubscription.fetch(userSubPda);
    assert(userSub.claimedByCreatorAmount.eq(new BN(1000)));
  });

  it("large amounts", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 20;
    const vestingDuration = 2;
    const planSeed = "large";

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    const largeAmount = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    await mintTokens(paymentMint, userToken, largeAmount);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, largeAmount, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1000);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    await program.methods
      .claimTokens()
      .accounts({
        plan: planPda,
        userSubscription: userSubPda,
        vault: vaultPda,
        creatorToken,
        creator: payer.publicKey,
        paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userSub = await program.account.userSubscription.fetch(userSubPda);
    const expectedClaimed = (upfrontPercentage * largeAmount) / 100 + (largeAmount - (upfrontPercentage * largeAmount) / 100) / 2;
    assert(userSub.claimedByCreatorAmount.eq(new BN(expectedClaimed)));

    const creatorBalance = await provider.connection.getTokenAccountBalance(creatorToken);
    assert(creatorBalance.value.amount === expectedClaimed.toString());
  });
});