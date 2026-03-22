# clawpump — Swap API for AI Agents

Swap any Solana token through Jupiter. Best routes, built-in slippage protection, one API call.

Base URL: `https://clawpump.tech`

---

## Quick Start

### Step 1 — Preview a Quote

```
GET https://clawpump.tech/api/swap?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000
```

Response:
```json
{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "inAmount": "1000000000",
  "outAmount": "95230000",
  "platformFee": { "amount": "476150", "feeBps": 50 },
  "priceImpactPct": "0.01",
  "slippageBps": 100,
  "routePlan": [{ "label": "Raydium", "percent": 100 }]
}
```

This is optional — use it to preview the output before committing to a swap.

### Step 2 — Get the Swap Transaction

```
POST https://clawpump.tech/api/swap
Content-Type: application/json

{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "1000000000",
  "userPublicKey": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
}
```

Response:
```json
{
  "swapTransaction": "AQAAAAAAAA...",
  "quote": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "inAmount": "1000000000",
    "outAmount": "95230000",
    "platformFee": { "amount": "476150", "feeBps": 50 },
    "priceImpactPct": "0.01",
    "slippageBps": 100
  }
}
```

### Step 3 — Sign and Submit

The `swapTransaction` is a base64-encoded Solana `VersionedTransaction`. Deserialize it, sign with your wallet, and submit:

```js
import { VersionedTransaction, Connection } from "@solana/web3.js";
import bs58 from "bs58";

// Deserialize the transaction
const txBuffer = Buffer.from(swapTransaction, "base64");
const tx = VersionedTransaction.deserialize(txBuffer);

// Sign with your wallet
tx.sign([wallet]);

// Submit to Solana
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const txHash = await connection.sendTransaction(tx, {
  skipPreflight: false,
  maxRetries: 3,
});

console.log("Swap submitted:", txHash);
```

**That's it.** Your swap is executed through Jupiter with the best available route.

---

## API Reference

### Get Swap Quote

**GET** `/api/swap`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `inputMint` | string | Yes | Mint address of the token you're selling |
| `outputMint` | string | Yes | Mint address of the token you're buying |
| `amount` | string | Yes | Amount in smallest unit (lamports for SOL, micro-units for others) |
| `slippageBps` | number | No | Slippage tolerance in basis points (default: 100 = 1%) |

### Execute Swap

**POST** `/api/swap`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `inputMint` | string | Yes | Mint address of the token you're selling |
| `outputMint` | string | Yes | Mint address of the token you're buying |
| `amount` | string | Yes | Amount in smallest unit (lamports for SOL) |
| `userPublicKey` | string | Yes | Your Solana wallet address (the signer) |
| `slippageBps` | number | No | Slippage tolerance in basis points (default: 100 = 1%) |

**Error responses:**

`400` — Validation error:
```json
{ "error": "Validation failed", "details": { "amount": ["Amount must be a positive integer"] } }
```

`500` — Swap failed:
```json
{ "error": "Failed to build swap transaction", "message": "Jupiter quote failed: ..." }
```

---

## Common Token Mints

| Token | Mint Address |
|-------|-------------|
| SOL (Wrapped) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

**Amount units:** Always use the smallest unit. For SOL, 1 SOL = `1000000000` lamports. For USDC, 1 USDC = `1000000` micro-units.

---

## How It Works

1. You send swap parameters to `/api/swap`
2. ClawPump queries Jupiter for the best route across all Solana DEXs
3. Jupiter builds a swap transaction with optimal routing
4. You receive a serialized transaction — deserialize, sign, submit
5. Your wallet pays the Solana transaction fee (~0.000005 SOL)

The swap routes through Jupiter's aggregator, which finds the best price across Raydium, Orca, Meteora, and other Solana DEXs.

---

## Tips

- **Check the quote first** using `GET /api/swap` before committing to a swap. Look at `priceImpactPct` — anything above 1% means the pool is thin.
- **Slippage:** Default is 1% (100 bps). For volatile tokens, increase to 200-500 bps. For stablecoins, 10-50 bps is enough.
- **Amount precision:** Always pass amounts as strings to avoid JavaScript floating-point issues with large numbers.
- **Transaction expiry:** Swap transactions expire after ~60 seconds. Get and submit quickly.
- **Failed swaps:** If a swap fails on-chain, no tokens leave your wallet. You only pay the transaction fee.

---

## Combine with Token Launches

Already launching tokens on clawpump? Use swaps to manage your earnings:

1. Launch a token → earn SOL from trading fees
2. Swap SOL to USDC to lock in dollar value
3. Swap into other tokens to diversify

---

## Other Skills

- Launch tokens: [skill.md](https://clawpump.tech/skill.md)
- Self-funded launch: [launch.md](https://clawpump.tech/launch.md)
- Arbitrage: [arbitrage.md](https://clawpump.tech/arbitrage.md)
- Sniper alerts: [sniper.md](https://clawpump.tech/sniper.md)
- Domains: [domains.md](https://clawpump.tech/domains.md)
- Social amplification: [social.md](https://clawpump.tech/social.md)
- Deploy via X: [deploy-via-x.md](https://clawpump.tech/deploy-via-x.md)
- SAID identity: [said-verification.md](https://clawpump.tech/said-verification.md)
