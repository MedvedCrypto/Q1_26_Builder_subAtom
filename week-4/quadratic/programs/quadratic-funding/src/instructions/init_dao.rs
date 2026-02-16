pub use crate::state::Dao;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(name: String)]
pub struct InitDao<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + Dao::INIT_SPACE,
        seeds = [b"dao", creator.key().as_ref(), name.as_bytes()],
        bump,
    )]
    pub dao_account: Account<'info, Dao>,

    pub system_program: Program<'info, System>,
}

pub fn init_dao(ctx: Context<InitDao>, name: String) -> Result<()> {
    let dao_account = &mut ctx.accounts.data_account;

    dao_account.set_inner(Dao {
        authority: ctx.accounts.creator.key(),
        bump: ctx.bumps.dao_account,
        proposal_count: 0,
        name,
    });
    Ok(())
}