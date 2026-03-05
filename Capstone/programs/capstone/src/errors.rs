use anchor_lang::prelude::*;

#[error_code]
pub enum SolVeilErrors {
    #[msg("Plan seed too long")]
    PlanSeedTooLong,
    #[msg("Invalid upfront percentage")]
    InvalidUpfrontPercentage,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Name too long")]
    NameTooLong,
    #[msg("Symbol too long")]
    SymbolTooLong,
    #[msg("URI too long")]
    UriTooLong,
    #[msg("Invalid payment mint")]
    InvalidPaymentMint,
    #[msg("Invalid NFT mint")]
    InvalidNftMint,
    #[msg("Invalid NFT amount")]
    InvalidNftAmount,
    #[msg("Subscription not active")]
    SubscriptionNotActive,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid plan")]
    InvalidPlan,
    #[msg("Already claimed")]
    AlreadyClaimed,
}