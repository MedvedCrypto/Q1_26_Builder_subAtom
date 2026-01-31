// use std::ops::Rem;

use anchor_lang::prelude::*;
use mpl_core::{
    instructions::{RemovePluginV1CpiBuilder, UpdatePluginV1CpiBuilder},
    types::{FreezeDelegate, Plugin, PluginType},
    ID as CORE_PROGRAM_ID,
};

use crate::{
    errors::StakeError,
    state::{StakeAccount, StakeConfig, UserAccount},
};

#[derive(Accounts)]
pub struct Unstake<'info> {
//TODO
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
    /// CHECK: Asset account to be unstaked (Mutable because we remove a plugin)
    pub asset: UncheckedAccount<'info>,

    #[account(mut)] 
    /// CHECK: Verified by mpl-core. Mutable just in case Core needs to write to it.
    pub collection: UncheckedAccount<'info>,

    #[account(
        mut,
        close = user,
        seeds = [b"stake".as_ref(), config.key().as_ref(), asset.key().as_ref()],
        bump = stake_account.bump,
        constraint = stake_account.owner == user.key() @ StakeError::NotOwner,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(address = CORE_PROGRAM_ID)]
    /// CHECK: Verified by address constraint
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> Unstake<'info> {
    pub fn unstake(&mut self) -> Result<()> {
        let clock: Clock = Clock::get()?;

        // Check if freeze period has passed
        let stake_time = self.stake_account.staked_at;
        let freeze_period = self.config.freeze_period as i64;

        if clock.unix_timestamp < stake_time + freeze_period {
            return Err(StakeError::FreezePeriodNotPassed.into());
        }

        let time_elapsed = (clock.unix_timestamp - stake_time) as u32;
        let points_earned = time_elapsed * self.config.points_per_stake as u32;
        self.user_account.points += points_earned;

        let config_key = self.config.key();
        let asset_key = self.asset.key();
        let bump = self.stake_account.bump;
        
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"stake",
            config_key.as_ref(),
            asset_key.as_ref(),
            &[bump],
        ]];
        
        //Update the FreezeDelegate plugin to unfreeze the asset
        UpdatePluginV1CpiBuilder::new(&self.core_program.to_account_info())
            .asset(&self.asset.to_account_info())
            .collection(Some(&self.collection.to_account_info()))
            .payer(&self.user.to_account_info())
            .authority(Some(&self.stake_account.to_account_info()))
            .system_program(&self.system_program.to_account_info())
            .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: false }))
            .invoke_signed(signer_seeds)?;

        // Remove FreezeDelegate plugin from the staked asset
        RemovePluginV1CpiBuilder::new(&self.core_program.to_account_info())
            .asset(&self.asset.to_account_info())
            .collection(Some(&self.collection.to_account_info()))
            .payer(&self.user.to_account_info())
            //No authority needed to remove FreezeDelegate plugin
            .authority(None)
            .system_program(&self.system_program.to_account_info())
            .plugin_type(PluginType::FreezeDelegate)
            .invoke_signed(signer_seeds)?;




        // Update amount staked in user account
        self.user_account.amount_staked -= 1;

        Ok(())
    }
}
