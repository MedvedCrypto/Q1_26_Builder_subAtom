<p align="center">
  <img src="https://via.placeholder.com/1200x400/1e40af/ffffff?text=Subscription+NFT+Protocol" alt="Subscription NFT Protocol" width="800"/>
  <br><br>
  <h1>Subscription NFT Protocol</h1>
  <h3>A Solana-based protocol for NFT-powered recurring subscriptions with vesting & instant refunds</h3>
</p>

<p align="center">
  <a href="https://solana.com">
    <img src="https://img.shields.io/badge/Built%20on-Solana-9945FF?logo=solana&logoColor=white" alt="Solana">
  </a>
</p>

---

**Subscription NFT Protocol** enables creators to offer recurring subscription services natively on Solana using non-transferable NFTs.

Users deposit tokens → receive an NFT proving active subscription → creator gradually claims funds over time via linear vesting.

Subscribers can **burn** the NFT at any moment to instantly reclaim all unvested funds.

### ✨ Features

#### For Subscribers
- Mint subscription NFT + deposit tokens in **one transaction**
- Check current unvested / refundable balance
- Burn NFT → instant refund of unvested portion
- Renew or upgrade subscription by depositing more tokens (vested amount can roll over)

#### For Creators
- Deploy customizable subscription plans (upfront %, vesting duration, token, NFT metadata)
- Claim vested funds at any time
- Monitor active subscriptions and refunded users
- Gate content/services by verifying NFT ownership on-chain

### 🧠 How It Works

1. **Creator** deploys a Plan → creates Plan PDA + Vault token account
2. **User** buys subscription → tokens go to Vault, NFT is minted, UserSubscription PDA tracks deposit & vesting
3. **Creator** claims vested portion → protocol calculates vested amount and transfers tokens
4. **User** closes subscription → burns NFT → receives unvested tokens back → PDA closed/inactivated
5. **User** renews → adds more tokens to same vault & subscription record (NFT unchanged)

### 🏗 Architecture

| Account              | Description                                                                 |
|----------------------|-----------------------------------------------------------------------------|
| **Plan PDA**         | Stores plan config: vesting duration, upfront %, payment mint, NFT collection, vault address |
| **Vault**            | Token account holding all deposits for the plan (owned by program PDA)      |
| **UserSubscription PDA** | Per-user data: owner, total deposit, vesting start, claimed amount         |
| **Subscription NFT** | Non-transferable NFT from the plan’s collection — proves active subscription |

All token transfers and NFT mint/burn operations are done via CPI to **SPL Token** and **Metaplex** programs.

### 📜 Core Instructions

| Instruction            | Caller   | Description                                          |
|------------------------|----------|------------------------------------------------------|
| `create_plan`          | Creator  | Initialize plan + vault                              |
| `buy_subscription`     | User     | Deposit tokens → mint NFT → create subscription PDA  |
| `claim_tokens`         | Creator  | Withdraw vested portion from vault                   |
| `close_subscription`   | User     | Burn NFT → refund unvested tokens                    |
| `renew_subscription`   | User     | Add tokens to existing subscription                  |

### 🔒 Security Highlights

- NFT ownership checked on every refund / access operation
- All token & NFT actions via audited SPL + Metaplex programs
- Vault & subscription accounts only modifiable by authorized parties
- Burning NFT prevents reuse / double-spending

### PDA Derivation

```rust
// Plan PDA
seeds = [b"plan", creator_key.as_ref(), plan_id.as_ref()]

// UserSubscription PDA
seeds = [b"user_sub", plan_key.as_ref(), user_key.as_ref()]

// Vault (associated token account seeds can be derived normally)
