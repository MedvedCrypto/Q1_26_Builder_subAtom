import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { QuadraticFunding } from "../target/types/quadratic_funding";

describe("quadratic-funding", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.quadraticFunding as Program<QuadraticFunding>;

  it("Is initialized!", async () => {
    const tx = await program.methods.initialize().rpc();
    console.log("Your transaction signature", tx);
  });
});
