use anchor_lang::prelude::*;

#[account]
#[derive(Debug, InitSpace)]
pub struct Proposal {
    pub authority: Pubkey,
    #[max_len(500)]
    pub metadata: String,
    pub yes_vote_count: u64,
    pub no_vote_count: u64,
    pub bump: u8,
}