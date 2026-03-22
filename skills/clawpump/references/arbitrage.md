# clawpump — Arbitrage Intelligence API for AI Agents

Scan cross-DEX price differences on Solana. Get ready-to-sign transaction bundles. You handle execution.

Base URL: `https://clawpump.tech`

---

## How It Works

The Arbitrage Intelligence API compares prices for the same token across multiple Solana DEXes simultaneously. When one DEX offers a better buy price and another offers a better sell price, the API identifies the spread, evaluates profitability after fees, and builds unsigned transaction bundles you can sign and submit.

```
1. You send token pair(s) + your wallet address
2. API queries Jupiter for DEX-specific quotes (10 supported DEXes)
3. API finds best buy/sell DEX combination
4. Evaluates roundtrip profit using worst-case (post-slippage) amounts
5. Deducts network fees, platform fee, and safety margin
6. If still profitable: builds unsigned tx bundle (leg1: buy, leg2: sell)
7. You sign both transactions and submit to Solana
```

**You control execution.** The API never touches your private key. You decide when, how, and whether to submit transactions. Use your own RPC, Jito bundles, priority fees, or any execution strategy you prefer.

### Profit Calculation

The API uses **pessimistic estimates** to ensure quoted profits survive real execution:

- **Worst-case amounts**: Uses `otherAmountThreshold` (minimum output after slippage), not the optimistic `outAmount`
- **Network fees**: Estimates ~0.003 SOL for 2 swap transactions (base fees + priority fees + potential ATA creation). For non-SOL outputs, this is converted to the output token using the quote rate.
- **Safety margin**: Deducts an additional 1% (100 bps) of trade amount to account for execution variance (quote staleness, on-chain slippage beyond estimates)
- **Platform fee**: 5% of net profit, deducted only from profitable bundles

If the API says a trade is profitable, it should be profitable on-chain (barring extreme market moves between quote and execution).

---

## Quick Start

### Step 1 — Scan for Opportunities

```
POST https://clawpump.tech/api/agents/arbitrage
Content-Type: application/json

{
  "userPublicKey": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "pairs": [{
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "1000000000",
    "strategy": "roundtrip",
    "dexes": ["raydium", "orca", "meteora", "solfi", "goonfi"],
    "slippageBps": 50,
    "minProfitLamports": "100000"
  }],
  "maxBundles": 1
}
```

Response when profitable:
```json
{
  "scannedPairs": 1,
  "profitablePairs": 1,
  "bundlesReturned": 1,
  "bundles": [{
    "index": 0,
    "mode": "roundtrip",
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "1000000000",
    "txBundle": ["AQAAAAA...", "AQAAAAA..."],
    "refreshedOpportunity": {
      "buyDex": "solfi",
      "sellDex": "goonfi",
      "grossProfitLamports": "5137000",
      "estimatedNetProfitLamports": "1137000",
      "bridgeAmount": "86374933",
      "finalAmount": "1001137000"
    },
    "legRoutes": ["SolFi V2", "GoonFi V2"],
    "platformFee": {
      "feeBps": 500,
      "feeLamports": "56850",
      "feeWallet": "3ZGgmBgEMTSgcVGLXZWpus5Vx41HNuhq6H6Yg6p3z6uv",
      "txIncluded": true
    },
    "note": "Unsigned tx bundle. Agent signs/sends in order: leg1, leg2, fee."
  }],
  "results": [{
    "index": 0,
    "mode": "roundtrip",
    "profitable": true,
    "selectedOpportunity": {
      "buyDex": "solfi",
      "sellDex": "goonfi",
      "estimatedNetProfitLamports": "1137000",
      "grossProfitLamports": "5137000"
    },
    "forwardQuotes": [
      { "dex": "raydium", "outAmount": "86350000" },
      { "dex": "orca", "outAmount": "86340000" },
      { "dex": "solfi", "outAmount": "86374933" },
      { "dex": "goonfi", "outAmount": "86320000" }
    ],
    "bundleReady": true
  }]
}
```

Response when not profitable (most common):
```json
{
  "scannedPairs": 1,
  "profitablePairs": 0,
  "bundlesReturned": 0,
  "bundles": [],
  "results": [{
    "index": 0,
    "mode": "roundtrip",
    "profitable": false,
    "reason": "Best opportunity net profit -1142857 is below threshold 100000",
    "selectedOpportunity": {
      "buyDex": "goonfi",
      "sellDex": "solfi",
      "estimatedNetProfitLamports": "-1142857",
      "grossProfitLamports": "-4747138"
    },
    "forwardQuotes": [
      { "dex": "raydium", "outAmount": "42428192" },
      { "dex": "orca", "outAmount": "42420778" },
      { "dex": "solfi", "outAmount": "42447749" },
      { "dex": "goonfi", "outAmount": "42445694" }
    ],
    "bundleReady": false
  }]
}
```

### Step 2 — Sign and Submit

Each item in `txBundle` is a base64-encoded unsigned `VersionedTransaction`. Sign and submit them **in order**:

```js
import { VersionedTransaction, Connection, Keypair } from "@solana/web3.js";

const connection = new Connection("YOUR_RPC_URL", "confirmed");

async function signAndSend(wallet, txBase64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  // Wait for confirmation before sending next leg
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// Execute in sequence: leg1 → leg2 → fee
for (const tx of bundle.txBundle) {
  const sig = await signAndSend(wallet, tx);
  console.log("Confirmed:", sig);
}
```

### Step 3 — Check Quote History

```
GET https://clawpump.tech/api/arbitrage/history?agentId=my-agent
```

---

## Strategies

### Roundtrip (default)

Buy token on the cheapest DEX, sell on the most expensive. Classic two-leg arbitrage.

```
SOL → Token (buy on DEX A) → SOL (sell on DEX B)
```

Best for: Major pairs with deep liquidity on multiple DEXes (SOL/USDC, SOL/JitoSOL).

### Bridge

Three-leg path through an intermediate token. Finds opportunities that don't exist in simple roundtrips.

```
SOL → Token A (DEX X) → Token B (DEX Y) → SOL (DEX Z)
```

Best for: Finding inefficiencies in triangular paths. Set `bridgeMints` to control which intermediate tokens to try.

### Auto

API evaluates both roundtrip and bridge strategies and returns whichever scores higher.

```json
{
  "strategy": "auto",
  "bridgeMints": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
}
```

---

## API Reference

### Scan Pairs & Build Bundles (Primary Endpoint)

**POST** `/api/agents/arbitrage`

This is the main endpoint for AI agents. Scans one or more token pairs, evaluates arbitrage opportunities, and returns ready-to-sign transaction bundles.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userPublicKey` | string | Yes | Your Solana wallet address (the signer) |
| `agentId` | string | No | Your agent identifier (for rate limiting & history) |
| `maxBundles` | number | No | Max bundles to return (default: 3, max: 20) |
| `pairs` | array | Yes | Array of pair objects (1-20 pairs) |

**Pair object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `inputMint` | string | Yes | Input token mint address |
| `outputMint` | string | Yes | Output token mint address |
| `amount` | string | Yes | Amount in smallest unit (lamports for SOL) |
| `strategy` | string | No | `"roundtrip"`, `"bridge"`, or `"auto"` (default: `"roundtrip"`) |
| `dexes` | string[] | No | DEX filter — e.g. `["raydium", "orca"]` or `["all"]` |
| `bridgeMints` | string[] | No | Intermediate tokens for bridge strategy |
| `maxBridgeMints` | number | No | Max bridge mints to try (default: 6) |
| `slippageBps` | number | No | Slippage tolerance in basis points (default: 50) |
| `minProfitLamports` | string | No | Minimum net profit to qualify (default: "100000" = 0.0001 SOL) |
| `maxPriceImpactPct` | number | No | Max price impact % (default: 3) |
| `allowSameDex` | boolean | No | Allow buy/sell on same DEX (default: false) |

**Response fields:**

| Field | Description |
|-------|-------------|
| `scannedPairs` | Number of pairs evaluated |
| `profitablePairs` | Number with profitable opportunities |
| `bundlesReturned` | Number of tx bundles built |
| `bundles` | Array of tx bundles (base64 unsigned transactions) |
| `results` | Detailed per-pair evaluation results |

**Bundle object:**

| Field | Description |
|-------|-------------|
| `txBundle` | Array of base64 unsigned transactions. Execute in order: leg1, leg2, [fee] |
| `refreshedOpportunity` | Fresh quotes using pessimistic (post-slippage) amounts |
| `legRoutes` | Human-readable route labels (e.g. "Raydium CLMM", "SolFi V2") |
| `platformFee` | Fee details: `feeBps`, `feeLamports`, `feeWallet`, `txIncluded` |

### Quick Price Check

**GET** `/api/arbitrage/prices?mints=MINT1,MINT2`

Fast price comparison across DEXes for up to 5 token mints. No bundles built.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `mints` | string | Yes | Comma-separated mint addresses (max 5) |

### Multi-DEX Quote

**POST** `/api/arbitrage/quote`

Get detailed multi-DEX quotes for a single pair. Includes spread calculation and arb opportunity breakdown.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `inputMint` | string | Yes | Input token mint |
| `outputMint` | string | Yes | Output token mint |
| `amount` | string | Yes | Amount in smallest unit |
| `agentId` | string | No | Your agent identifier |

### Query History

**GET** `/api/arbitrage/history?agentId=my-agent&limit=50`

Returns past quote queries and aggregate statistics. Omit `agentId` for platform-wide stats.

### Capabilities

**GET** `/api/agents/arbitrage/capabilities`

Returns supported DEXes, strategies, fee structure, and default configuration.

---

## Supported DEXes

10 DEXes across 3 tiers:

| Tier | DEXes | Notes |
|------|-------|-------|
| **Tier 1** (Major) | Raydium, Orca, Meteora, Phoenix | Deep liquidity, tight spreads |
| **Tier 2** (Mid) | FluxBeam, Saros | Moderate liquidity, wider bid-ask |
| **Tier 3** (Niche) | Stabble, Aldrin, SolFi, GoonFi | Wider spreads possible |

Pass `dexes: ["all"]` to scan all, or specify a subset: `dexes: ["raydium", "orca", "solfi", "goonfi"]`.

Fewer DEXes = faster scan. More DEXes = more opportunities to discover.

**Important:** Large forward spreads from Tier 2/3 DEXes often reflect wide bid-ask spreads on those DEXes, not exploitable price dislocations. The API accounts for this by evaluating full roundtrip profitability — a DEX offering a great buy rate may have a terrible sell rate, making the roundtrip unprofitable.

---

## Common Token Mints

| Token | Mint Address | Decimals |
|-------|-------------|----------|
| SOL (Wrapped) | `So11111111111111111111111111111111111111112` | 9 |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 |
| JitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` | 9 |
| mSOL | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` | 9 |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` | 6 |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | 5 |
| WIF | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` | 6 |

**Amount units:** Always use the smallest unit. For SOL: 1 SOL = `1000000000` lamports. For USDC: 1 USDC = `1000000`.

---

## Platform Fee

- **5% of net profit** (500 bps), deducted only when a profitable bundle is built
- Fee is calculated on the pessimistic net profit (after slippage, network fees, and safety margin)
- Fee transaction is included in the `txBundle` array (third element) when fee can be expressed in SOL
- If no profitable opportunity is found, no fee applies
- Check current fee: `GET /api/agents/arbitrage/capabilities`

---

## Rate Limits

- **30 requests per minute** per `agentId` or IP address
- Applies to `/api/agents/arbitrage` and `/api/arbitrage/quote`
- Read endpoints (`/prices`, `/history`, `/capabilities`) are not rate limited

---

## Risks and Realistic Expectations

Arbitrage on Solana is extremely competitive. This API provides intelligence — **you are responsible for execution and risk management.**

### The Reality of API-Based Arbitrage

Professional MEV bots dominate Solana arbitrage. They use on-chain programs, Jito bundles, and sub-100ms execution. An API-based approach (quote → sign → submit) has inherent latency of several seconds, which means:

- **Most opportunities will be captured by faster participants** before your transaction lands
- **Major pairs (SOL/USDC) rarely have exploitable spreads** — typically 5-30 bps cross-DEX, which is below execution cost for roundtrips
- **Consistent profits require catching volatile moments** — large trades, liquidations, or news events that temporarily create wider spreads

This API is best used as an **intelligence layer** — understanding cross-DEX pricing, identifying which DEXes offer the best rates, and detecting unusual spreads that may signal larger opportunities.

### Execution Risk

- **Transactions are NOT atomic.** Leg1 and leg2 are separate transactions. If leg1 succeeds and leg2 fails, you hold intermediate tokens that must be recovered.
- **Quotes expire.** Prices change constantly. A profitable quote can become unprofitable within seconds. Execute quickly after receiving a bundle.
- **Slippage is real.** The API uses `otherAmountThreshold` (worst-case after slippage) for profit calculations. Actual execution can still vary.
- **MEV bots compete.** Professional arbitrageurs with sub-millisecond execution and custom Solana programs will capture most opportunities before API-based agents can act.

### Cost Breakdown

A roundtrip arbitrage trade costs approximately:

| Cost Component | Estimate |
|----------------|----------|
| Base tx fee (2 swaps) | ~0.00001 SOL |
| Priority fees (2 swaps) | ~0.002-0.006 SOL |
| Swap fees (~0.25% per leg) | ~0.5% of trade amount |
| Slippage (50 bps per leg) | up to ~1% of trade amount |
| Safety margin | 1% of trade amount |
| **Total overhead** | **~2.5% of trade amount** |

For a roundtrip to be profitable, the cross-DEX spread must exceed ~2.5% after all costs. On liquid pairs this is rare; on illiquid pairs the spread may be wide but the bid-ask spread of the DEX itself prevents profitable roundtrips.

### Recommendations

1. **Use a dedicated wallet.** Don't use your main wallet for arbitrage. Fund a separate wallet with only what you're willing to risk.

2. **Always verify on-chain results.** Compare real P&L against quoted P&L after each trade. The API's profit estimates are conservative but not guaranteed.

3. **Build recovery logic.** If leg2 fails, swap the intermediate tokens back immediately:
   ```js
   // If you hold intermediate tokens after a failed leg2:
   // 1. Get a Jupiter quote for Token → SOL
   // 2. Build and submit a recovery swap
   // 3. Accept wider slippage (200-500 bps) to ensure recovery succeeds
   ```

4. **Use Jito bundles for atomic execution.** Submit both legs as a Jito bundle to guarantee they execute in the same block. This eliminates the timing gap between legs.

5. **Scan during volatility.** Cross-DEX spreads widen during large price moves, liquidation cascades, and major token events. Focus scanning during these windows.

6. **Larger trades amortize fixed costs.** Network fees (~0.003 SOL) are a smaller percentage of larger trades. But price impact increases with size — test to find your optimal amount.

7. **Check `priceImpactPct`** in forward quotes. Impact above 1% means thin liquidity — the quoted spread may not survive execution.

8. **Don't hold intermediate tokens.** Complete the roundtrip or recover immediately. Token prices can move against you while holding.

### What the API Is Good For

- **Price intelligence**: See which DEXes offer the best rates for any token pair
- **Spread monitoring**: Track cross-DEX price differences over time
- **Opportunity detection**: Get alerted when spreads are unusually wide
- **Bundle construction**: Pre-built unsigned transactions save development time
- **Risk filtering**: Pessimistic profit calculation prevents executing losing trades

---

## Example: Continuous Scanner

```js
const API = "https://clawpump.tech";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function scan(walletPublicKey) {
  const res = await fetch(`${API}/api/agents/arbitrage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userPublicKey: walletPublicKey,
      pairs: [{
        inputMint: SOL,
        outputMint: USDC,
        amount: "1000000000",       // 1 SOL
        strategy: "roundtrip",
        dexes: ["raydium", "orca", "meteora", "solfi", "goonfi"],
        slippageBps: 50,
        minProfitLamports: "100000", // 0.0001 SOL minimum net profit
      }],
      maxBundles: 1,
    }),
  });

  const data = await res.json();

  if (data.bundles.length > 0) {
    const bundle = data.bundles[0];
    const opp = bundle.refreshedOpportunity;
    const netSOL = parseInt(opp.estimatedNetProfitLamports) / 1e9;
    console.log(`Opportunity: ${opp.buyDex} → ${opp.sellDex}, net: +${netSOL.toFixed(6)} SOL`);
    console.log(`Bundle has ${bundle.txBundle.length} transactions ready to sign`);
    // Sign and submit bundle.txBundle[0], then [1], then [2] if present
  } else {
    // Log the reason — useful for understanding market conditions
    const reason = data.results?.[0]?.reason || "Unknown";
    console.log(`No opportunity: ${reason}`);
  }

  return data;
}

// Scan every 10 seconds
setInterval(() => scan("YOUR_WALLET_ADDRESS"), 10_000);
```

---

## Combine with Other ClawPump APIs

- **Launch a token** → earn trading fees → use arbitrage to grow your SOL: [skill.md](https://clawpump.tech/skill.md)
- **Swap tokens** → convert arbitrage profits to USDC or other tokens: [swap.md](https://clawpump.tech/swap.md)
- **Sniper alerts** → get notified when new tokens launch, then scan for arb: [sniper.md](https://clawpump.tech/sniper.md)
- **Domains** → register a domain for your agent: [domains.md](https://clawpump.tech/domains.md)
- **Trading Intelligence** → time your arb entries with macro signals and technical indicators: [trading-intelligence.md](https://clawpump.tech/trading-intelligence.md)
- **Deploy via X** — launch tokens by tweeting @clawpumptech: [deploy-via-x.md](https://clawpump.tech/deploy-via-x.md)
- **SAID Identity** — on-chain agent identity badges: [said-verification.md](https://clawpump.tech/said-verification.md)
- **All skills:** [skills-directory.md](https://clawpump.tech/skills-directory.md)
