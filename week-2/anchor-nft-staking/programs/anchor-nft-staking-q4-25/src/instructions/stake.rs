// use std::ops::Add;

use anchor_lang::prelude::*;
use mpl_core::{
    instructions::AddPluginV1CpiBuilder,
    types::{FreezeDelegate, Plugin, PluginAuthority},
    ID as CORE_PROGRAM_ID,
};

use crate::{
    errors::StakeError,
    state::{StakeAccount, StakeConfig, UserAccount},
};

#[derive(Accounts)]
pub struct Stake<'info> {
// TODO : define accounts needed for staking
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user".as_ref(), user.key().as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, UserAccount>,

    #[account(
        mut,
        seeds = [b"config".as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, StakeConfig>,

    #[account(mut)]
    /// CHECK: Asset account to be staked (Mutable because we add a plugin)
    pub asset: UncheckedAccount<'info>,

    #[account(mut)] 
    /// CHECK: Verified by mpl-core. Mutable just in case Core needs to write to it.
    pub collection: UncheckedAccount<'info>,

    #[account(
        init,
        payer = user,
        seeds = [b"stake".as_ref(), config.key().as_ref(), asset.key().as_ref()],
        bump,
        space = StakeAccount::DISCRIMINATOR.len() + StakeAccount::INIT_SPACE,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(address = CORE_PROGRAM_ID)]
    /// CHECK: Verified by address constraint
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,

}

impl<'info> Stake<'info> {
    pub fn stake(&mut self, bumps: &StakeBumps) -> Result<()> {
    // TODO : implement stake logic
        let clock: Clock = Clock::get()?;   

        require_keys_eq!(
            *self.asset.owner,
            CORE_PROGRAM_ID,
            StakeError::InvalidAsset
        );

        require_keys_eq!(
            *self.collection.owner,
            CORE_PROGRAM_ID,
            StakeError::InvalidCollection
        );

        //Check max stake limit
        if self.user_account.amount_staked >= self.config.max_stake as u8 {
            return err!(StakeError::MaxStakeReached);
        }

        // Initialize the stake account
        self.stake_account.set_inner(StakeAccount {
            owner: self.user.key(),
            mint: self.asset.key(),
            staked_at: clock.unix_timestamp as i64,
            bump: bumps.stake_account,
        });    

        // Add FreezeDelegate plugin to the staked asset
        AddPluginV1CpiBuilder::new(&self.core_program.to_account_info())
            .asset(&self.asset.to_account_info())
            .collection(Some(&self.collection.to_account_info()))
            .payer(&self.user.to_account_info())
            .authority(Some(&self.user.to_account_info())) // User is the authority
            .system_program(&self.system_program.to_account_info())
            .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: true }))
            // PDA authority for the plugin
            .init_authority(PluginAuthority::Address { 
                address: self.stake_account.key() 
            })
            .invoke()?;
        
        // Update amount staked in user account
        self.user_account.amount_staked += 1;

        Ok(())
    }
}
