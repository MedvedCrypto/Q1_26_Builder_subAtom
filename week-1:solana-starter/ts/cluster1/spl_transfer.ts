import { Commitment, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import wallet from "../turbin3-wallet.json"
import { getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";
import CONST from "./CONSTANTS.json"

const MINT = CONST.MINT_ADDRESS;
// We're going to import our keypair from the wallet file
const keypair = Keypair.fromSecretKey(new Uint8Array(wallet));

//Create a Solana devnet connection
const commitment: Commitment = "confirmed";
const connection = new Connection("https://api.devnet.solana.com", commitment);

// Mint address
const mint = new PublicKey(MINT);

// Recipient address
const to = new PublicKey("4aPycKEbgz5tpFozhX3M22vdhPKumM4dpLwFXoFyR8WW");

(async () => {
    try {
        // Get the token account of the fromWallet address, and if it does not exist, create it

        const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            keypair, // i payer ! :))
            mint,
            keypair.publicKey //my wallet
        );

        console.log(`From Token Account: ${fromTokenAccount.address.toBase58()}`);

        // Get the token account of the toWallet address, and if it does not exist, create it

        const toTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            keypair,
            mint,
            to // recipient wallet
        );

        console.log(`To Token Account: ${toTokenAccount.address.toBase58()}`);

        // Transfer the new token to the "toTokenAccount" we just created

        const signature = await transfer(
            connection,
            keypair,
            fromTokenAccount.address,
            toTokenAccount.address,
            keypair.publicKey,
            1_000_000n// amount to transfer. It`s 1 token because our mint has 6 decimals
        );

        console.log(`Transfer tx signature: ${signature}`);
        console.log(`Link: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    } catch(e) {
        console.error(`Oops, something went wrong: ${e}`)
    }
})();