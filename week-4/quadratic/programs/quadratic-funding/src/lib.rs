pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("AhGoWa11Pn52CD2ey4ZNShTENisKaSpcRh2gBPqfVCVd");

#[program]
pub mod quadratic_funding {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        init_dao::handler(ctx)
    }
}
