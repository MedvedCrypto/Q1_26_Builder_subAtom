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
const programId = new PublicKey("FisvpEC1NDf4kZtzJY3cBvA6xJnohVxjD3WvzxJk5jRu");

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
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
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
    amount: number | string | BN,
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
        nftAta: nftAta,
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
    await mintTokens(paymentMint, userToken, 1000 * 10**6);

    const nftMint = Keypair.generate();
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    const userSub = await program.account.userSubscription.fetch(userSubPda);
    assert(userSub.totalDepositAmount.eq(new BN(1000 * 10**6)));
    assert(userSub.isActive);

    const vaultAccount = await provider.connection.getTokenAccountBalance(vaultPda);
    // 80% goes to vault (20% upfront)
    assert.equal(vaultAccount.value.amount, (800 * 10**6).toString());

    const nftAta = getAssociatedTokenAddressSync(nftMint.publicKey, user.publicKey);
    const nftBalance = await provider.connection.getTokenAccountBalance(nftAta);
    assert.equal(nftBalance.value.amount, "1");
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
    await mintTokens(paymentMint, userToken, 2000 * 10**6);

    const nftMint = Keypair.generate();
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];

    await program.methods
      .renewSubscription(new BN(500 * 10**6))
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
    assert(userSub.totalDepositAmount.eq(new BN(1500 * 10**6)));
  });

it("claim tokens success", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 10; // Увеличим до 10 секунд для точности
    const planSeed = "claim_test_" + Math.random();

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    const amount = 1000 * 10**6;
    await mintTokens(paymentMint, userToken, amount);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, amount, "NFT", "SYM", "uri", paymentMint, creatorToken);

    // Спим 2 секунды (это 20% от 10 секунд вестинга)
    await sleep(2000);

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
    const claimed = userSub.claimedByCreatorAmount.toNumber();

    // Проверяем диапазон: за 2 секунды должно начислиться минимум 15-20% (150-250 токенов)
    // Это гораздо надежнее, чем ждать ровно 500
    assert.isAtLeast(claimed, 150 * 10**6, "Должно быть начислено минимум 15%");
    assert.isAtMost(claimed, 400 * 10**6, "Не должно быть начислено слишком много");

    const creatorBalance = await provider.connection.getTokenAccountBalance(creatorToken);
    assert.equal(creatorBalance.value.amount, claimed.toString());
  });

it("close subscription success", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    // 1. Объявляем nftCollection, которой не хватало
    const nftCollection = Keypair.generate().publicKey; 
    const upfrontPercentage = 0;
    // 2. Ставим вестинг 1000 секунд, чтобы за время теста ничего не успело "сгореть"
    const vestingDuration = 1000; 
    const planSeed = "close_test_" + Math.random(); // Уникальный сид

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    const depositAmount = 1000 * 10**6; // 1000 токенов
    await mintTokens(paymentMint, userToken, depositAmount);

    const nftMint = Keypair.generate();
    
    // Покупаем подписку
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, depositAmount, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];
    const nftAta = getAssociatedTokenAddressSync(nftMint.publicKey, user.publicKey);

    // Закрываем сразу же, без sleep, чтобы гарантировать возврат
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
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Проверяем, что аккаунт подписки удален
    try {
      await program.account.userSubscription.fetch(userSubPda);
      assert.fail("User subscription should be closed");
    } catch (e) {
      // Это ожидаемое поведение
    }

    const userBalance = await provider.connection.getTokenAccountBalance(userToken);
    const creatorBalance = await provider.connection.getTokenAccountBalance(creatorToken);
    
    // 3. Самая надежная проверка: сумма того, что вернулось юзеру и ушло создателю, 
    // должна быть равна изначальному депозиту.
    const totalReturned = Number(userBalance.value.amount) + Number(creatorBalance.value.amount);
    assert.equal(totalReturned, depositAmount, "Сумма средств должна совпадать с депозитом");

    console.log("User balance after close:", userBalance.value.amount);
    console.log("Creator balance after close:", creatorBalance.value.amount);
    
    // Так как закрыли почти мгновенно, юзер должен получить назад почти всё (> 95%)
    assert.isAbove(Number(userBalance.value.amount), depositAmount * 0.95, "Юзер должен получить большую часть рефанда");
  });

  it("query unvested balance", async () => {
    const paymentMint = await createMint(6);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 20;
    const vestingDuration = 2;
    const planSeed = "query_test";

    console.log(nftCollection)

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000 * 10**6);

    const nftMint = Keypair.generate();
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1100);

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

    // 20% upfront + 40% vested (half of remaining 80%) = 60% vested
    // 40% unvested
    assert.approximately(unvested / 10**6, 400, 50);
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
    await mintTokens(paymentMint, userToken, 1000 * 10**6);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1100);

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
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
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
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have failed");
    } catch (e: any) {
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
    await mintTokens(paymentMint, userAToken, 1000 * 10**6);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, userA, userAToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

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
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([userB])
        .rpc();
      assert.fail("Should have failed");
    } catch (e: any) {
      assert(e.message.includes("Unauthorized") || e.message.includes("ConstraintHasOne") || e.message.includes("constraint was violated"));
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
    await mintTokens(paymentMint, userToken, 1000 * 10**6);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    await sleep(1100);

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
    } catch (e: any) {
      assert(e.message.includes("Unauthorized") || e.message.includes("constraint was violated"));
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
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(attacker.publicKey, LAMPORTS_PER_SOL)
    );
    const attackerToken = await createTokenAccount(paymentMint, attacker.publicKey);

    const transferIx = createTransferInstruction(vaultPda, attackerToken, attacker.publicKey, 100n, [], TOKEN_PROGRAM_ID);
    const tx = new anchor.web3.Transaction().add(transferIx);

    try {
      await provider.sendAndConfirm(tx, [attacker]);
      assert.fail("Should have failed");
    } catch (e: any) {
      assert(e.message.includes("0x1") || e.message.includes("Owner mismatch") || e.message.includes("signature"));
    }
  });

  it("edge case zero upfront", async () => {
    const paymentMint = await createMint(6);
    const creatorToken = await createTokenAccount(paymentMint, payer.publicKey);
    const nftCollection = Keypair.generate().publicKey;
    const upfrontPercentage = 0;
    const vestingDuration = 2;
    const planSeed = "zero_upfront_" + Math.random();

    const { planPda, vaultPda } = await createPlan(paymentMint, nftCollection, upfrontPercentage, vestingDuration, planSeed);

    const user = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    const userToken = await createTokenAccount(paymentMint, user.publicKey);
    await mintTokens(paymentMint, userToken, 1000 * 10**6);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

    const userSubPda = findUserSubscriptionPda(planPda, user.publicKey)[0];

    // Claim immediately - should get 0
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
    assert.equal(userSub.claimedByCreatorAmount.toNumber(), 0, "Immediately after start, claimed should be 0");

    // Ждем ДОЛЬШЕ чем vesting_duration (3 секунды вместо 2.1)
    await sleep(3000);

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
    
    // Проверяем что claimed >= 99% от депозита (с допуском на погрешность)
    const claimed = userSub.claimedByCreatorAmount.toNumber();
    const expected = 1000 * 10**6;
    assert.isAtLeast(claimed, expected * 0.99, "After vesting completes, should have ~100% claimed");
    assert.isAtMost(claimed, expected, "Claimed should not exceed deposit");
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
    await mintTokens(paymentMint, userToken, 1000 * 10**6);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

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
    assert(userSub.claimedByCreatorAmount.eq(new BN(1000 * 10**6)));
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
    await mintTokens(paymentMint, userToken, 1000 * 10**6);

    const nftMint = Keypair.generate();
    await buySubscription(planPda, vaultPda, user, userToken, nftMint, 1000 * 10**6, "NFT Name", "SYM", "uri", paymentMint, creatorToken);

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
    assert(userSub.claimedByCreatorAmount.eq(new BN(1000 * 10**6)));
  });

});