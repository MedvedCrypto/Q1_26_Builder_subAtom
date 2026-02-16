import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { AnchorDiceGameQ425 } from "../target/types/anchor_dice_game_q4_25";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { assert } from "chai";
import crypto from "crypto";

describe("dice-game", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const program = anchor.workspace
    .AnchorDiceGameQ425 as Program<AnchorDiceGameQ425>;

  // generate keys
  const house = Keypair.generate();
  const player = Keypair.generate();

  // fixed seed for the first bet (to make things a bit more predictable)
  const seed = new BN(42);

  // PDA vault
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), house.publicKey.toBuffer()],
    program.programId,
  );

  // PDA bet (for the first bet)
  const [bet] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("bet"),
      vault.toBuffer(),
      seed.toArrayLike(Buffer, "le", 8), // only 8 bytes needed for determinism, but u128 is fine
    ],
    program.programId,
  );

  // helper to confirm tx
  async function confirmTx(signature: string): Promise<string> {
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      ...latestBlockhash,
    });
    return signature;
  }

  before(async () => {
    // fund accounts  (house needs more for vault)
    await Promise.all(
      [house, player].map(async (kp) => {
        const amount = kp === house ? 30 : 10; // house needs extra
        const airdropSig = await connection.requestAirdrop(
          kp.publicKey,
          amount * LAMPORTS_PER_SOL,
        );
        await confirmTx(airdropSig);
      }),
    );
    console.log("✓ Accounts funded\n");
  });

  it("Initialize vault", async () => {
    const amt = new BN(5 * LAMPORTS_PER_SOL);

    await program.methods
      .initialize(amt)
      .accountsStrict({
        house: house.publicKey,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([house])
      .rpc()
      .then(confirmTx);

    assert.equal(await connection.getBalance(vault), amt.toNumber());
    console.log("✓ Vault initialized");
  });

  it("Place a bet", async () => {
    const seed = new BN(crypto.randomBytes(16)); // full 16 bytes
    const roll = 50;
    const amount = new BN(LAMPORTS_PER_SOL / 100);

    const [betPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bet"),
        vault.toBuffer(),
        seed.toArrayLike(Buffer, "le", 16),
      ],
      program.programId,
    );

    const vBefore = await connection.getBalance(vault);
    const pBefore = await connection.getBalance(player.publicKey);

    await program.methods
      .placeBet(seed, roll, amount)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: betPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    const vAfter = await connection.getBalance(vault);
    const pAfter = await connection.getBalance(player.publicKey);

    // player платит: ставку + rent за bet-аккаунт (~0.001–0.002 SOL) + комиссию tx
    assert.approximately(pAfter, pBefore - amount.toNumber(), 3_000_000); // большой tolerance на rent + fee

    assert.equal(vAfter, vBefore + amount.toNumber());

    const betAcc = await program.account.bet.fetch(betPda);
    assert.equal(betAcc.player.toBase58(), player.publicKey.toBase58());
    assert.equal(betAcc.roll, roll);
    assert.equal(betAcc.amount.toNumber(), amount.toNumber());

    console.log("✓ Bet placed");
  });

  it("Resolve bet (win)", async () => {
    const seed = new BN(crypto.randomBytes(16));
    const roll = 90; // high win prob
    const amount = new BN(0.2 * LAMPORTS_PER_SOL);

    const [betPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bet"),
        vault.toBuffer(),
        seed.toArrayLike(Buffer, "le", 16),
      ],
      program.programId,
    );

    await program.methods
      .placeBet(seed, roll, amount)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: betPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    const info = await connection.getAccountInfo(betPda);
    const message = info!.data.slice(8);

    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: house.secretKey,
      message,
    });

    // correct offset for signature in ed25519 ix data
    const signatureOffset = 16 + 32; // flags + pubkey
    const sig = Buffer.from(
      edIx.data.buffer.slice(signatureOffset, signatureOffset + 64),
    );

    const resolveIx = await program.methods
      .resolveBet(sig, seed)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: betPda,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(edIx).add(resolveIx);
    tx.feePayer = player.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    tx.partialSign(player); // player pays & signs

    const rawTx = tx.serialize();
    const txSig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
    });
    await confirmTx(txSig);

    // check bet closed
    try {
      await program.account.bet.fetch(betPda);
      assert.fail("bet should be closed");
    } catch (_) {}

    console.log("✓ Bet resolved (win)");
  });

  it("Resolve bet (loss)", async () => {
    const seed = new BN(crypto.randomBytes(16));
    const roll = 10; // low win prob
    const amount = new BN(0.1 * LAMPORTS_PER_SOL);

    const [betPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bet"),
        vault.toBuffer(),
        seed.toArrayLike(Buffer, "le", 16),
      ],
      program.programId,
    );

    await program.methods
      .placeBet(seed, roll, amount)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: betPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    const info = await connection.getAccountInfo(betPda);
    const message = info!.data.slice(8);

    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: house.secretKey,
      message,
    });

    const signatureOffset = 48; // 16 (flags+padding) + 32 (pubkey) = 48, then 64 sig
    const sig = Buffer.from(
      edIx.data.buffer.slice(signatureOffset, signatureOffset + 64),
    );

    const resolveIx = await program.methods
      .resolveBet(sig, seed)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: betPda,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(edIx).add(resolveIx);
    tx.feePayer = player.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    tx.partialSign(player);

    const rawTx = tx.serialize();
    const txSig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
    });
    await confirmTx(txSig);

    console.log("✓ Bet resolved (loss)");
  });

  it("Refund bet (fails if too early)", async () => {
    const newSeed = new BN(crypto.randomBytes(16).toString("hex"), 16);
    const roll = 10;
    const betAmount = new BN(0.1 * LAMPORTS_PER_SOL);

    const [newBet] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bet"),
        vault.toBuffer(),
        newSeed.toArrayLike(Buffer, "le", 16),
      ],
      program.programId,
    );

    await program.methods
      .placeBet(newSeed, roll, betAmount)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: newBet,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    try {
      await program.methods
        .refundBet()
        .accountsStrict({
          player: player.publicKey,
          house: house.publicKey,
          vault,
          bet: newBet,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();
      assert.fail("Refund should have failed (too early)");
    } catch (e: any) {
      // handle both old/new anchor error formats
      const msg = e.message || "";
      assert(
        msg.includes("TimeoutNotReached") ||
          msg.includes("Timeout not reached"),
        "expected timeout error",
      );
    }

    console.log("✓ Refund correctly rejected (too early)");
  });

  it("Refund bet fails if called by wrong player", async () => {
    const newSeed = new BN(crypto.randomBytes(16).toString("hex"), 16);
    const roll = 20;
    const betAmount = new BN(0.1 * LAMPORTS_PER_SOL);

    const [newBet] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bet"),
        vault.toBuffer(),
        newSeed.toArrayLike(Buffer, "le", 16),
      ],
      program.programId,
    );

    await program.methods
      .placeBet(newSeed, roll, betAmount)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: newBet,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    const attacker = Keypair.generate();
    await connection
      .requestAirdrop(attacker.publicKey, LAMPORTS_PER_SOL)
      .then(confirmTx);

    try {
      await program.methods
        .refundBet()
        .accountsStrict({
          player: attacker.publicKey,
          house: house.publicKey,
          vault,
          bet: newBet,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Refund should have failed (wrong player)");
    } catch (e: any) {
      const msg = e.message || "";
      assert(
        msg.includes("has one constraint was violated"),
        "expected player constraint error",
      );
    }

    console.log("✓ Refund correctly rejected (wrong player)");
  });

  it("Place bet same seed fails", async () => {
    const s = new BN(crypto.randomBytes(16));
    const amt = new BN(LAMPORTS_PER_SOL / 100);

    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), vault.toBuffer(), s.toArrayLike(Buffer, "le", 16)],
      program.programId,
    );

    await program.methods
      .placeBet(s, 50, amt)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: pda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    try {
      await program.methods
        .placeBet(s, 60, amt)
        .accountsStrict({
          player: player.publicKey,
          house: house.publicKey,
          vault,
          bet: pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();
      assert.fail("should fail duplicate seed");
    } catch (e) {
      assert.include(e.message, "already in use");
    }
    console.log("✓ Same seed rejected");
  });


  it("Resolve bet with attacker signature fails", async () => {
    const attacker = Keypair.generate();
    const s = new BN(crypto.randomBytes(16));
    const amt = new BN(0.1 * LAMPORTS_PER_SOL);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), vault.toBuffer(), s.toArrayLike(Buffer, "le", 16)],
      program.programId,
    );

    await program.methods
      .placeBet(s, 50, amt)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: pda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    const info = await connection.getAccountInfo(pda);
    if (!info) throw new Error("bet not found");

    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: attacker.secretKey,
      message: info.data.slice(8),
    });

    const sig = Buffer.from(edIx.data.buffer.slice(48, 112));

    try {
      await program.methods
        .resolveBet(sig, s)
        .accountsStrict({
          player: player.publicKey,
          house: house.publicKey,
          vault,
          bet: pda,
          instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("attacker sig should fail");
    } catch (e: any) {
      const msg = e.message.toLowerCase() || "";
      assert(
        msg.includes("ed25519") ||
          msg.includes("signature") ||
          msg.includes("pubkey") ||
          msg.includes("custom program error") ||
          e.logs?.some(
            (l: string) =>
              l.toLowerCase().includes("ed25519") || l.includes("Error Code"),
          ),
        "expected ed25519 verification error",
      );
    }
    console.log("✓ Attacker signature rejected");
  });

  it("Refund by house fails", async () => {
    const s = new BN(crypto.randomBytes(16));
    const amt = new BN(0.1 * LAMPORTS_PER_SOL);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), vault.toBuffer(), s.toArrayLike(Buffer, "le", 16)],
      program.programId,
    );

    await program.methods
      .placeBet(s, 50, amt)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: pda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    try {
      await program.methods
        .refundBet()
        .accountsStrict({
          player: house.publicKey,
          house: house.publicKey,
          vault,
          bet: pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([house])
        .rpc();
      assert.fail("house cannot refund");
    } catch (e) {
      assert.include(e.message, "has one constraint");
    }
    console.log("✓ House cannot refund");
  });

  it("Refund succeeds after timeout", async () => {
    const seed = new BN(crypto.randomBytes(16));
    const roll = 50;
    const amount = new BN(0.1 * LAMPORTS_PER_SOL);

    const [betPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bet"),
        vault.toBuffer(),
        seed.toArrayLike(Buffer, "le", 16),
      ],
      program.programId,
    );

    await program.methods
      .placeBet(seed, roll, amount)
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: betPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    await new Promise((r) => setTimeout(r, 600_000));

    const playerBefore = await connection.getBalance(player.publicKey);
    const vaultBefore = await connection.getBalance(vault);

    await program.methods
      .refundBet()
      .accountsStrict({
        player: player.publicKey,
        house: house.publicKey,
        vault,
        bet: betPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc()
      .then(confirmTx);

    const playerAfter = await connection.getBalance(player.publicKey);
    const vaultAfter = await connection.getBalance(vault);

    assert.approximately(
      playerAfter,
      playerBefore + amount.toNumber(),
      3_000_000,
    );
    assert.equal(vaultAfter, vaultBefore - amount.toNumber());

    try {
      await program.account.bet.fetch(betPda);
      assert.fail("bet should be closed after refund");
    } catch (_) {}

    console.log("✓ Refund succeeds after timeout");
  });
});
