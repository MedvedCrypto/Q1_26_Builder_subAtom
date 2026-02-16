use anchor_lang::prelude::*;

#[account]
#[derive(Debug, InitSpace)]
pub struct Vote {
    pub authority: Pubkey,
    pub vote_type: u8, // 0 for Yes and 1 for No
    pub vote_credits: u64,
    pub bump: u8,
}