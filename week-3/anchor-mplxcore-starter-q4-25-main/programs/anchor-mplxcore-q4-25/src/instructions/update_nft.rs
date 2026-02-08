use anchor_lang::prelude::*;
use mpl_core::{
    instructions::UpdateV2CpiBuilder,
    ID as CORE_PROGRAM_ID,
};

use crate::{error::MPLXCoreError, state::CollectionAuthority};

#[derive(Accounts)]
pub struct UpdateNft<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    /// CHECK: it is checked in the core program, and it needs to be mutable because we will update the asset state in this instruction
    pub asset: UncheckedAccount<'info>,
    #[account(
        seeds = [b"collection_authority", collection.key().as_ref()],
        bump = collection_authority.bump,
        constraint = collection_authority.creator == authority.key() @ MPLXCoreError::NotAuthorized
    )]
    pub collection_authority: Account<'info, CollectionAuthority>,
    /// CHECK: it is checked in the core program, but it doesn't need to be mutable because we won't update the collection state in this instruction
    pub collection: UncheckedAccount<'info>,
    #[account(address = CORE_PROGRAM_ID)]
    /// CHECK: it is checked in the core program
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> UpdateNft<'info> {
    pub fn update_nft(&mut self, new_name: String) -> Result<()> {
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"collection_authority",
            &self.collection.key().to_bytes(),
            &[self.collection_authority.bump],
        ]];

        // CPI to the core program to update the asset's name. V2 because we want to update the name, which is not possible with V1
        UpdateV2CpiBuilder::new(&self.core_program.to_account_info())
            .asset(&self.asset.to_account_info())
            .collection(Some(&self.collection.to_account_info()))
            .payer(&self.authority.to_account_info())
            .authority(Some(&self.collection_authority.to_account_info()))
            .new_name(new_name)
            .system_program(&self.system_program.to_account_info())
            .invoke_signed(signer_seeds)?;

        Ok(())
    }
}