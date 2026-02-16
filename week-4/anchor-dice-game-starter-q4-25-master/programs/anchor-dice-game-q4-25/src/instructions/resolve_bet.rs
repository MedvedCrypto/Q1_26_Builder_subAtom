use anchor_lang::prelude::*;
use anchor_instruction_sysvar::Ed25519InstructionSignatures;
use anchor_lang::system_program::{Transfer, transfer};
use solana_program::ed25519_program;
use solana_program::hash::hash;
use solana_program::sysvar::instructions::{ load_current_index_checked, load_instruction_at_checked};
use crate::Bet;
use crate::errors::DiceError;

const HOUSE_EDGE_BPS: u16 = 150;

#[derive(Accounts)]
#[instruction(sig: Vec<u8>, seed: u128)]
pub struct ResolveBet<'info> {
    #[account(
        mut
    )]
   /// CHECK: verified via ed25519 signature
    pub house: UncheckedAccount<'info>,

    /// CHECK: Player address is validated against bet.player account constraint
    #[account(
        mut,
        address = bet.player @ DiceError::InvalidPlayer
    )]
    pub player: UncheckedAccount<'info>,
    
    #[account(
        mut,
        seeds = [b"vault", house.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    #[account(
        mut,
        has_one = player,
        close = player,
        seeds = [b"bet", vault.key().as_ref(), seed.to_le_bytes().as_ref()],
        bump = bet.bump,
    )]
    pub bet: Account<'info, Bet>,
    #[account(
        address = solana_program::sysvar::instructions::ID @ DiceError::SysvarNotFound
    )]
    /// CHECK: Instructions sysvar account
    pub instruction_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> ResolveBet<'info> {

    pub fn verify_ed25519_signature(&mut self, sig: &[u8]) -> Result<()> {
        let cur_index = load_current_index_checked(&self.instruction_sysvar.to_account_info())? as usize;
        let ix = load_instruction_at_checked(
            cur_index.checked_sub(1).ok_or(DiceError::Overflow)?, 
            &self.instruction_sysvar.to_account_info()
        )?;

        require_eq!(ix.program_id, ed25519_program::ID, DiceError::Ed25519Program);
        require_eq!(ix.accounts.len(), 0, DiceError::Ed25519Accounts);
        
        let signatures = Ed25519InstructionSignatures::unpack(&ix.data).map_err(|_| DiceError::Ed25519Signature)?.0;
        
        require_eq!(signatures.len(), 1, DiceError::Ed25519SignatureMustBeOne);

        let signature = &signatures[0];

        require!(&signature.is_verifiable, DiceError::Ed25519Header);

        require_keys_eq!(signature.public_key.ok_or(DiceError::Ed25519Pubkey)?, self.house.key(), DiceError::Ed25519Pubkey);

        require!(signature.signature.ok_or(DiceError::Ed25519Pubkey)?.eq(sig), DiceError::Ed25519Signature);

        let binding = self.bet.to_account_info();
        let bet_data = binding.data.borrow();
        require!(
            signature.message.as_ref().unwrap().eq(&bet_data[8..]), 
            DiceError::Ed25519Message
        );

        // require!(signature.message.as_ref().unwrap().eq(self.bet.to_slice().as_slice()), DiceError::Ed25519Message);

        Ok(())
    }


    pub fn resolve_bet(&mut self, sig: &[u8], bumps: &ResolveBetBumps) -> Result<()> {
        let _hash = hash(sig).to_bytes();

        let mut hash_16 = [0; 16];
        hash_16.copy_from_slice(&_hash[0..16]);
        let lower = u128::from_le_bytes(hash_16);

        hash_16.copy_from_slice(&_hash[16..32]);
        let upper = u128::from_le_bytes(hash_16);

        let roll = lower
            .wrapping_add(upper)
            .wrapping_rem(100) as u8 + 1;

        if self.bet.roll > roll {
            let bps = (10000 - HOUSE_EDGE_BPS) as u128;
            let payout = (self.bet.amount as u128)
                .checked_mul(bps as u128).ok_or(DiceError::Overflow)?
                .checked_div(self.bet.roll as u128 - 1).ok_or(DiceError::Overflow)?
                .checked_div(100).ok_or(DiceError::Overflow)?;

            let signer_seeds: &[&[&[u8]]; 1] =
                &[&[b"vault", &self.house.key().to_bytes(), &[bumps.vault]]];

            let accounts = Transfer{
                from: self.vault.to_account_info(),
                to: self.player.to_account_info()
            };

            let ctx = CpiContext::new_with_signer(
                self.system_program.to_account_info(), 
                accounts, 
                signer_seeds
            );

            transfer(ctx, payout as u64)?;
        }

        Ok(())
    }


}