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

declare_id!("2s6CLnLvfbYe1ubUFVrjWwEC3s86jQfEyqhpqkvLe23B");

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
            return err!(ErrorCode::PlanSeedTooLong);
        }
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
        let decimals = ctx.accounts.payment_mint.decimals;

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
        let sub_seeds = &[
            b"user_subscription",
            ctx.accounts.plan.to_account_info().key.as_ref(),
            ctx.accounts.user.to_account_info().key.as_ref(),
            &[ctx.bumps.user_subscription],
        ];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    to: ctx.accounts.nft_ata.to_account_info(),
                    authority: ctx.accounts.user_subscription.to_account_info(),
                },
                &[sub_seeds],
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
                &[sub_seeds],
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
                &[sub_seeds],
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

        let plan_seeds: &[&[u8]] = &[
            b"plan",
            plan.creator.as_ref(),
            plan.seed.as_ref(),
            &[plan.bump],
        ];

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
                    &[plan_seeds],
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
                    &[plan_seeds],
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
        token::close_account(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.nft_ata.to_account_info(),
                destination: ctx.accounts.user.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ))?;

        Ok(())
    }

    pub fn renew_subscription(ctx: Context<RenewSubscription>, amount: u64) -> Result<()> {
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
        user_sub.total_deposit_amount += amount;

        Ok(())
    }

    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        let plan = &ctx.accounts.plan;
        let user_sub = &mut ctx.accounts.user_subscription;
        let current_time = Clock::get()?.unix_timestamp as u64;
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

        let plan_seeds: &[&[u8]] = &[
            b"plan",
            plan.creator.as_ref(),
            plan.seed.as_ref(),
            &[plan.bump],
        ];

        if claimable > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.creator_token.to_account_info(),
                        authority: ctx.accounts.plan.to_account_info(),
                    },
                    &[plan_seeds],
                ),
                claimable,
            )?;
            user_sub.claimed_by_creator_amount += claimable;
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
        space = SubscriptionPlan::LEN,
        seeds = [b"plan", creator.key().as_ref(), plan_seed.as_bytes()],
        bump
    )]
    pub plan: Account<'info, SubscriptionPlan>,
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
}

impl SubscriptionPlan {
    const LEN: usize = 8 + 32 + 1 + 8 + 32 + 32 + 8 + 1 + 4 + 32; // discriminator + fields + Vec<u8> max 32
}

#[derive(Accounts)]
pub struct BuySubscription<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"plan", plan.creator.as_ref(), plan.seed.as_ref()],
        bump = plan.bump
    )]
    pub plan: Account<'info, SubscriptionPlan>,
    pub payment_mint: Account<'info, Mint>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
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
        space = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1,
        seeds = [b"user_subscription", plan.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_subscription: Account<'info, UserSubscription>,
    #[account(
        init,
        payer = user,
        mint::decimals = 0,
        mint::authority = user_subscription,
        mint::freeze_authority = user_subscription
    )]
    pub nft_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = nft_mint,
        associated_token::authority = user
    )]
    pub nft_ata: Account<'info, TokenAccount>,
    /// CHECK: Verified in code
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: Verified in code
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
    #[account(mut, token::mint = plan.payment_mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = plan.payment_mint, token::authority = plan.creator)]
    pub creator_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_subscription.subscription_mint == nft_mint.key()
    )]
    pub nft_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = nft_mint,
        token::authority = user,
        constraint = nft_ata.amount == 1
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
    #[account(mut, token::mint = plan.payment_mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        has_one = plan,
        constraint = user_subscription.is_active,
        seeds = [b"user_subscription", plan.key().as_ref(), user.key().as_ref()],
        bump = user_subscription.bump
    )]
    pub user_subscription: Account<'info, UserSubscription>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(
        seeds = [b"plan", plan.creator.as_ref(), plan.seed.as_ref()],
        bump = plan.bump
    )]
    pub plan: Account<'info, SubscriptionPlan>,
    #[account(mut)]
    pub user_subscription: Account<'info, UserSubscription>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = plan.payment_mint, token::authority = plan.creator)]
    pub creator_token: Account<'info, TokenAccount>,
    #[account(mut, signer, constraint = plan.creator == creator.key() @ SolVeilErrors::Unauthorized)]
    /// CHECK:
    pub creator: AccountInfo<'info>,
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

#[error_code]
pub enum ErrorCode {
    #[msg("Plan seed too long")]
    PlanSeedTooLong,
}