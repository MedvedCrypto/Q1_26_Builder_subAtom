use anchor_lang::prelude::*;

mod errors;
use crate::errors::SolVeilErrors;

use anchor_spl::{
    associated_token::AssociatedToken,
    metadata::{
        create_master_edition_v3, create_metadata_accounts_v3, mpl_token_metadata::types::DataV2,
        CreateMasterEditionV3, CreateMetadataAccountsV3,
    },
    token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn, CloseAccount},
};
use mpl_token_metadata::accounts::{MasterEdition, Metadata as MetadataAccount};

declare_id!("FisvpEC1NDf4kZtzJY3cBvA6xJnohVxjD3WvzxJk5jRu");

#[program]
pub mod solvency {
    use super::*;
    use mpl_token_metadata::types::Collection;

    pub fn create_plan(
        ctx: Context<CreatePlan>,
        plan_seed: String,
        upfront_percentage: u8,
        vesting_duration: u64,
        nft_collection: Pubkey,
    ) -> Result<()> {
        if plan_seed.len() > 32 {
            return err!(SolVeilErrors::PlanSeedTooLong);
        }
        require!(upfront_percentage <= 100, SolVeilErrors::InvalidUpfrontPercentage);
        
        let plan = &mut ctx.accounts.plan;
        plan.creator = ctx.accounts.creator.key();
        plan.upfront_percentage = upfront_percentage;
        plan.vesting_duration = vesting_duration;
        plan.payment_mint = ctx.accounts.payment_mint.key();
        plan.nft_collection = nft_collection;
        plan.creation_timestamp = Clock::get()?.unix_timestamp as u64;
        plan.bump = ctx.bumps.plan;
        plan.seed = plan_seed.into_bytes();
        Ok(())
    }

    pub fn buy_subscription(
        ctx: Context<BuySubscription>,
        amount: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let plan = &ctx.accounts.plan;
        
        require!(amount > 0, SolVeilErrors::InvalidAmount);
        require!(name.len() <= 32, SolVeilErrors::NameTooLong);
        require!(symbol.len() <= 10, SolVeilErrors::SymbolTooLong);
        require!(uri.len() <= 200, SolVeilErrors::UriTooLong);

        let upfront = ((plan.upfront_percentage as u128 * amount as u128) / 100) as u64;
        let remaining = amount.saturating_sub(upfront);

        // Transfer upfront to creator if any
        if upfront > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token.to_account_info(),
                        to: ctx.accounts.creator_token.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                upfront,
            )?;
        }

        // Transfer remaining to vault
        if remaining > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                remaining,
            )?;
        }

        // Verify metadata and edition PDAs
        let (metadata_pda, _) = MetadataAccount::find_pda(&ctx.accounts.nft_mint.key());
        require_keys_eq!(metadata_pda, ctx.accounts.metadata.key());
        let (edition_pda, _) = MasterEdition::find_pda(&ctx.accounts.nft_mint.key());
        require_keys_eq!(edition_pda, ctx.accounts.master_edition.key());

        // Mint NFT
        // Bind temporaries first
        let plan_key = plan.key();  // Pubkey is Copy, so this is fine
        let user_key = ctx.accounts.user.key();
        let bump = [ctx.bumps.user_subscription];  // [u8; 1]

        // Now create the owned array
        let sub_seeds_inner_array = [
            b"user_subscription" as &[u8],
            plan_key.as_ref(),
            user_key.as_ref(),
            &bump,
        ];

        // Slice it
        let sub_seeds_inner: &[&[u8]] = &sub_seeds_inner_array;

        // Wrap for CPI (multiple signers, even if one)
        let sub_seeds: &[&[&[u8]]] = &[sub_seeds_inner];
        
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    to: ctx.accounts.nft_ata.to_account_info(),
                    authority: ctx.accounts.user_subscription.to_account_info(),
                },
                sub_seeds,
            ),
            1,
        )?;

        // Create metadata
        let data_v2 = DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: Some(Collection {
                verified: false,
                key: ctx.accounts.plan.nft_collection,
            }),
            uses: None,
        };
        
        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    mint_authority: ctx.accounts.user_subscription.to_account_info(),
                    payer: ctx.accounts.user.to_account_info(),
                    update_authority: ctx.accounts.user_subscription.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                sub_seeds,
            ),
            data_v2,
            true,
            true,
            None,
        )?;

        // Create master edition
        create_master_edition_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMasterEditionV3 {
                    edition: ctx.accounts.master_edition.to_account_info(),
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    update_authority: ctx.accounts.user_subscription.to_account_info(),
                    mint_authority: ctx.accounts.user_subscription.to_account_info(),
                    payer: ctx.accounts.user.to_account_info(),
                    metadata: ctx.accounts.metadata.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                sub_seeds,
            ),
            Some(0),
        )?;

        // Initialize user subscription
        let user_sub = &mut ctx.accounts.user_subscription;
        user_sub.plan = ctx.accounts.plan.key();
        user_sub.subscription_mint = ctx.accounts.nft_mint.key();
        user_sub.start_time = Clock::get()?.unix_timestamp as u64;
        user_sub.total_deposit_amount = amount;
        user_sub.claimed_by_creator_amount = upfront;
        user_sub.refund_token_amount = 0;
        user_sub.is_active = true;
        user_sub.bump = ctx.bumps.user_subscription;

        Ok(())
    }

    pub fn close_subscription(ctx: Context<CloseSubscription>) -> Result<()> {
        let plan = &ctx.accounts.plan;
        let user_sub = &ctx.accounts.user_subscription;
        let current_time = Clock::get()?.unix_timestamp as u64;
        
        require!(user_sub.is_active, SolVeilErrors::SubscriptionNotActive);
        
        let elapsed = current_time.saturating_sub(user_sub.start_time);
        let upfront = ((plan.upfront_percentage as u128 * user_sub.total_deposit_amount as u128)
            / 100) as u64;
        let remaining = user_sub.total_deposit_amount.saturating_sub(upfront);
        let vested_linear = if plan.vesting_duration == 0 || elapsed >= plan.vesting_duration {
            remaining
        } else {
            ((remaining as u128 * elapsed as u128) / plan.vesting_duration as u128) as u64
        };
        let vested = upfront + vested_linear;
        let refundable = user_sub.total_deposit_amount.saturating_sub(vested);
        let unclaimed = vested.saturating_sub(user_sub.claimed_by_creator_amount);

        let plan_seeds_inner: &[&[u8]] = &[
            b"plan",
            plan.creator.as_ref(),
            &plan.seed,
            &[plan.bump],
        ];
        let plan_seeds: &[&[&[u8]]] = &[plan_seeds_inner];

        // Claim unclaimed vested to creator
        if unclaimed > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.creator_token.to_account_info(),
                        authority: ctx.accounts.plan.to_account_info(),
                    },
                    plan_seeds,
                ),
                unclaimed,
            )?;
        }

        // Refund unvested to user
        if refundable > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.user_token.to_account_info(),
                        authority: ctx.accounts.plan.to_account_info(),
                    },
                    plan_seeds,
                ),
                refundable,
            )?;
        }

        // Burn NFT
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    from: ctx.accounts.nft_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            1,
        )?;

        // Close NFT ATA
        token::close_account(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.nft_ata.to_account_info(),
                    destination: ctx.accounts.user.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            )
        )?;

        Ok(())
    }

    pub fn renew_subscription(ctx: Context<RenewSubscription>, amount: u64) -> Result<()> {
        require!(amount > 0, SolVeilErrors::InvalidAmount);
        
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let user_sub = &mut ctx.accounts.user_subscription;
        user_sub.total_deposit_amount = user_sub.total_deposit_amount.checked_add(amount)
            .ok_or(SolVeilErrors::MathOverflow)?;

        Ok(())
    }

    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        let plan = &ctx.accounts.plan;
        let user_sub = &mut ctx.accounts.user_subscription;
        let current_time = Clock::get()?.unix_timestamp as u64;
        
        require!(user_sub.is_active, SolVeilErrors::SubscriptionNotActive);
        
        let elapsed = current_time.saturating_sub(user_sub.start_time);
        let upfront = ((plan.upfront_percentage as u128 * user_sub.total_deposit_amount as u128)
            / 100) as u64;
        let remaining = user_sub.total_deposit_amount.saturating_sub(upfront);
        let vested_linear = if plan.vesting_duration == 0 || elapsed >= plan.vesting_duration {
            remaining
        } else {
            ((remaining as u128 * elapsed as u128) / plan.vesting_duration as u128) as u64
        };
        let vested = upfront + vested_linear;
        let claimable = vested.saturating_sub(user_sub.claimed_by_creator_amount);

        let plan_seeds_inner: &[&[u8]] = &[
            b"plan",
            plan.creator.as_ref(),
            &plan.seed,
            &[plan.bump],
        ];
        let plan_seeds: &[&[&[u8]]] = &[plan_seeds_inner];

        if claimable > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.creator_token.to_account_info(),
                        authority: ctx.accounts.plan.to_account_info(),
                    },
                    plan_seeds,
                ),
                claimable,
            )?;
            user_sub.claimed_by_creator_amount = user_sub.claimed_by_creator_amount
                .checked_add(claimable)
                .ok_or(SolVeilErrors::MathOverflow)?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(plan_seed: String)]
pub struct CreatePlan<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + SubscriptionPlan::LEN,
        seeds = [b"plan", creator.key().as_ref(), plan_seed.as_bytes()],
        bump
    )]
    pub plan: Box<Account<'info, SubscriptionPlan>>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub payment_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    #[account(
        init,
        payer = creator,
        seeds = [b"vault", plan.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = plan
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BuySubscription<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"plan", plan.creator.as_ref(), plan.seed.as_ref()],
        bump = plan.bump
    )]
    pub plan: Box<Account<'info, SubscriptionPlan>>,
    pub payment_mint: Account<'info, Mint>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = user,
        constraint = payment_mint.key() == plan.payment_mint @ SolVeilErrors::InvalidPaymentMint
    )]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = plan.creator
    )]
    pub creator_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = user,
        space = 8 + UserSubscription::LEN,
        seeds = [b"user_subscription", plan.key().as_ref(), user.key().as_ref()],
        bump
    )]
pub user_subscription: Box<Account<'info, UserSubscription>>,
    #[account(
        init,
        payer = user,
        mint::decimals = 0,
        mint::authority = user_subscription,
        mint::freeze_authority = user_subscription
    )]
pub nft_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = user,
        associated_token::mint = nft_mint,
        associated_token::authority = user
    )]
    pub nft_ata: Account<'info, TokenAccount>,
    /// CHECK: Verified in code against MetadataAccount::find_pda
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: Verified in code against MasterEdition::find_pda
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_metadata_program: Program<'info, anchor_spl::metadata::Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CloseSubscription<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"plan", plan.creator.as_ref(), plan.seed.as_ref()],
        bump = plan.bump
    )]
    pub plan: Box<Account<'info, SubscriptionPlan>>,
    #[account(
        mut,
        has_one = plan,
        seeds = [b"user_subscription", plan.key().as_ref(), user.key().as_ref()],
        bump = user_subscription.bump,
        close = user
    )]
    pub user_subscription: Box<Account<'info, UserSubscription>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = plan.payment_mint,
        token::authority = user
    )]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = plan.payment_mint,
        token::authority = plan.creator
    )]
    pub creator_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_subscription.subscription_mint == nft_mint.key() @ SolVeilErrors::InvalidNftMint
    )]
    pub nft_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = user,
        constraint = nft_ata.amount == 1 @ SolVeilErrors::InvalidNftAmount
    )]
    pub nft_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RenewSubscription<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"plan", plan.creator.as_ref(), plan.seed.as_ref()],
        bump = plan.bump
    )]
    pub plan: Account<'info, SubscriptionPlan>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = plan.payment_mint,
        token::authority = user
    )]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        has_one = plan,
        constraint = user_subscription.is_active @ SolVeilErrors::SubscriptionNotActive,
        seeds = [b"user_subscription", plan.key().as_ref(), user.key().as_ref()],
        bump = user_subscription.bump
    )]
    pub user_subscription: Account<'info, UserSubscription>,
    pub payment_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(
        seeds = [b"plan", plan.creator.as_ref(), plan.seed.as_ref()],
        bump = plan.bump
    )]
    pub plan: Account<'info, SubscriptionPlan>,
    #[account(
        mut,
        has_one = plan,
        constraint = user_subscription.is_active @ SolVeilErrors::SubscriptionNotActive,
    )]
    pub user_subscription: Account<'info, UserSubscription>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = plan.payment_mint,
        token::authority = plan.creator
    )]
    pub creator_token: Account<'info, TokenAccount>,
    #[account(mut, signer, constraint = plan.creator == creator.key() @ SolVeilErrors::Unauthorized)]
    pub creator: Signer<'info>,
    pub payment_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct SubscriptionPlan {
    pub creator: Pubkey,
    pub upfront_percentage: u8,
    pub vesting_duration: u64,
    pub payment_mint: Pubkey,
    pub nft_collection: Pubkey,
    pub creation_timestamp: u64,
    pub bump: u8,
    pub seed: Vec<u8>,
}

impl SubscriptionPlan {
    const LEN: usize = 32 + 1 + 8 + 32 + 32 + 8 + 1 + 4 + 32;
}

#[account]
pub struct UserSubscription {
    pub plan: Pubkey,
    pub subscription_mint: Pubkey,
    pub start_time: u64,
    pub total_deposit_amount: u64,
    pub claimed_by_creator_amount: u64,
    pub refund_token_amount: u64,
    pub is_active: bool,
    pub bump: u8,
}

impl UserSubscription {
    const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
}