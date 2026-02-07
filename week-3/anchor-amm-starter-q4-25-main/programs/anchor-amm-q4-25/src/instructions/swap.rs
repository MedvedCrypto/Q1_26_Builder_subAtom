use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};
use constant_product_curve::{ConstantProduct, LiquidityPair};

use crate::{
    errors::AmmError,
    // instructions::{deposit, withdraw},
    state::Config,
};

#[derive(Accounts)]
pub struct Swap<'info> {
    // TODO: Write the accounts struct
    #[account(mut)]
    pub user: Signer<'info>,
    pub mint_x: Account<'info, Mint>,
    pub mint_y: Account<'info, Mint>,
    #[account(
        has_one = mint_x,
        has_one = mint_y,
        seeds = [b"config", config.seed.to_le_bytes().as_ref()],
        bump = config.config_bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"lp", config.seed.to_le_bytes().as_ref()],
        bump = config.lp_bump,
    )]
    pub mint_lp: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = config,
    )]
    pub vault_x: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_y,
        associated_token::authority = config,
    )]
    pub vault_y: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = user,
    )]
    pub user_x: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_y,
        associated_token::authority = user,
    )]
    pub user_y: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Swap<'info> {
    pub fn swap(&mut self, is_x: bool, amount: u64, min: u64) -> Result<()> {
        // select the pair based on the is_x parameter
        let pair = if is_x {
            LiquidityPair::X
        } else {
            LiquidityPair::Y
        };

        // create curve instance with current vault balances and 0 fee (for simplicity)
        let mut curve = ConstantProduct::init(
            self.vault_x.amount,
            self.vault_y.amount,
            self.mint_lp.supply,
            self.config.fee,    // fee in basis points, e.g. 30 for 0.3%
            None, 
        )
        .map_err(|_| AmmError::CurveError)?;

        // вычисляем результат свапа
        let result = curve
            .swap(pair, amount, min)
            .map_err(|_| AmmError::SlippageExceeded)?;

        // CHECK: result.withdraw >= min — already checked in curve.swap() method, so we can be sure that this swap won't fail due to slippage

        // 1st: user deposits the required amount into the pool
        self.deposit_tokens(is_x, result.deposit)?;

        // second: user withdraws the required amount from the pool
        self.withdraw_tokens(!is_x, result.withdraw)?;

        Ok(())
    }

    pub fn deposit_tokens(&mut self, is_x: bool, amount: u64) -> Result<()> {
        //  TODO deposit tokens from the user to the vault, depending on the is_x parameter
        let (from, to) = match is_x {
            true => (
                self.user_x.to_account_info(),
                self.vault_x.to_account_info(),
            ),
            false => (
                self.user_y.to_account_info(),
                self.vault_y.to_account_info(),
            ),
        };

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from,
            to,
            authority: self.user.to_account_info(),
        };

        let ctx = CpiContext::new(cpi_program, cpi_accounts);

        transfer(ctx, amount)?;
        Ok(())
    }

    pub fn withdraw_tokens(&mut self, is_x: bool, amount: u64) -> Result<()> {
        // TODO
        let (from, to) = match is_x {
            true => (
                self.vault_x.to_account_info(),
                self.user_x.to_account_info(),
            ),
            false => (
                self.vault_y.to_account_info(),
                self.user_y.to_account_info(),
            ),
        };

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from,
            to,
            authority: self.config.to_account_info(),
        };

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"config",
            &self.config.seed.to_le_bytes(),
            &[self.config.config_bump],
        ]];

        let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        transfer(ctx, amount)?;
        Ok(())
    }
}
