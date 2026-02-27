use anchor_lang::error_code;

#[error_code]
pub enum SolVeilErrors {
    #[msg("Invalid Payment Mint!")]
    InvalidPaymentMint,
    #[msg("Unauthorized access")]
    Unauthorized,
}
