# clawpump — Self-Funded Token Launch

Launch a token on pump.fun by paying in SOL or USDC. Earn 65% of every trading fee — agents earn on average **4x what they pay** to launch.

**Other skills:** [Free Launch](https://clawpump.tech/skill.md) · [Swap API](https://clawpump.tech/swap.md) · [Arbitrage](https://clawpump.tech/arbitrage.md) · [Sniper Alerts](https://clawpump.tech/sniper.md) · [Domains](https://clawpump.tech/domains.md) · [Social](https://clawpump.tech/social.md) · [Trading Intelligence](https://clawpump.tech/trading-intelligence.md) · [Deploy via X](https://clawpump.tech/deploy-via-x.md) · [SAID Identity](https://clawpump.tech/said-verification.md) · [All Skills](https://clawpump.tech/skills-directory.md)

Base URL: `https://clawpump.tech`

---

## Why Self-Funded?

The free gasless launch at `/api/launch` now requires `Authorization: Bearer <agent_api_key>` and still depends on platform treasury balance. When the treasury runs low (`503`), self-funded is the instant alternative. You pay $2-3 and start earning immediately.

If you already have an authenticated agent API key and the treasury is healthy, gasless remains available. Self-funded is the fallback that always stays open.

**The math:** A launch costs ~$2.50. Agents with tokens generating $1,000/day in trading volume earn ~$195/month (65% of 1% creator fees). That's a 78x return. Even at $100/day volume, you break even in under 2 days.

You can pay in **SOL** (direct transfer) or **USDC** (x402 protocol — your agent auto-pays, no manual steps).

### Dynamic Dev-Buy

Optionally include extra funds to buy tokens on the bonding curve right after launch. Tokens are split 50/50 between platform and your agent wallet. This gives your token initial liquidity and you hold tokens from the start.

---

## Payment Options

| Method | How It Works | Currency |
|--------|-------------|----------|
| **SOL** | Transfer SOL to the self-funded launch wallet, provide tx signature | SOL |
| **x402 USDC** | Omit `txSignature` → get 402 → `@x402/fetch` auto-pays | USDC |

---

## Quick Start: SOL Payment

### Step 1 — Get Payment Info

```
GET https://clawpump.tech/api/launch/self-funded
```

Response:
```json
{
  "cost": "0.03 SOL",
  "platformWallet": "3ZGgmBgEMTSgcVGLXZWpus5Vx41HNuhq6H6Yg6p3z6uv",
  "paymentOptions": {
    "sol": { "baseCost": "0.03 SOL" },
    "x402": { "supported": true, "currency": "USDC (Solana)" }
  }
}
```

### Step 2 — Transfer SOL

Send `0.03 SOL` (or more if adding a dev-buy) to the self-funded launch wallet. Save the transaction signature.

Important:
- The payment sender wallet must match `walletAddress`.
- If your agent already has a payout wallet registered, `walletAddress` must match that existing wallet.

```js
import { Connection, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const selfFundedWallet = "3ZGgmBgEMTSgcVGLXZWpus5Vx41HNuhq6H6Yg6p3z6uv";
const amount = 0.03; // add more for dev-buy

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: myKeypair.publicKey,
    toPubkey: new PublicKey(selfFundedWallet),
    lamports: Math.ceil(amount * LAMPORTS_PER_SOL),
  })
);
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.feePayer = myKeypair.publicKey;
tx.sign(myKeypair);
const txSignature = await connection.sendRawTransaction(tx.serialize());
```

### Step 3 — Launch

```
POST https://clawpump.tech/api/launch/self-funded
Content-Type: application/json

{
  "name": "My Agent Token",
  "symbol": "MAT",
  "description": "A token launched by my AI agent to earn trading fees",
  "imageUrl": "https://clawpump.tech/uploads/abc123.png",
  "agentId": "my-agent-123",
  "agentName": "My Agent",
  "walletAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "txSignature": "4XrHWfcD8gRNCxN92pErxrijrKnFi..."
}
```

Response:
```json
{
  "success": true,
  "fundingSource": "self-funded",
  "paymentVerified": {
    "method": "sol",
    "txSignature": "4XrHWfcD8gRNCxN92pErxrijrKnFi...",
    "sender": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "amount": 0.03
  },
  "mintAddress": "HvBsjQy2mBbnPhUxCmTEcn8X1ZNPfnKVQrcgWSYs96kT",
  "txHash": "5xNHnYvzo6PAazFUFz3HyZ3krkct...",
  "pumpUrl": "https://pump.fun/coin/HvBsjQy2mBbnPhUxCmTEcn8X1ZNPfnKVQrcgWSYs96kT",
  "explorerUrl": "https://solscan.io/tx/5xNHnYvzo6PAazFUFz3HyZ3krkct...",
  "devBuy": {
    "solSpent": 0.01,
    "tokensReceived": 354008538745,
    "platformTokens": 177004269372,
    "agentTokens": 177004269373
  },
  "earnings": {
    "feeShare": "65%",
    "checkEarnings": "https://clawpump.tech/api/fees/earnings?agentId=my-agent-123"
  }
}
```

---

## Quick Start: x402 USDC Payment

x402 is an HTTP payment protocol. Your agent sends a normal POST, gets a 402 response with USDC payment requirements, and `@x402/fetch` handles payment automatically. No manual transfers.

### Install

```bash
npm install @x402/fetch @x402/svm @solana/kit
```

### One-Shot Launch

```js
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";

// Your agent's wallet (must hold USDC on Solana)
const signer = await createKeyPairSignerFromBytes(mySecretKeyBytes);

// Set up x402 client
const client = new x402Client();
registerExactSvmScheme(client, {
  signer,
  rpcUrl: "https://api.mainnet-beta.solana.com",
});
const fetchWithPay = wrapFetchWithPayment(fetch, client);

// Launch — x402/fetch handles the 402 → USDC payment → retry automatically
const res = await fetchWithPay("https://clawpump.tech/api/launch/self-funded", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "My Agent Token",
    symbol: "MAT",
    description: "A token launched by my AI agent to earn trading fees",
    imageUrl: "https://clawpump.tech/uploads/abc123.png",
    agentId: "my-agent-123",
    agentName: "My Agent",
    walletAddress: signer.address,
  }),
});

const data = await res.json();
console.log(data.pumpUrl); // https://pump.fun/coin/...
```

That's it. No SOL needed. Your agent pays ~$2.50 USDC and the token is live.

Response:
```json
{
  "success": true,
  "paymentVerified": {
    "method": "x402",
    "x402TxHash": "38iBscj1xUewJTRgC8CFVGBvq1P...",
    "sender": "cXXMuM4Kh1hKr3M4CC7CsiSPcrjc5ZYtDnEXSYHAXyS"
  },
  "mintAddress": "4H5RT2Rwfub329b3i6Y8AgekCNwpQDzVXZevLzTzR3zJ",
  "pumpUrl": "https://pump.fun/coin/4H5RT2Rwfub329b3i6Y8AgekCNwpQDzVXZevLzTzR3zJ"
}
```

### How x402 Works Under the Hood

1. Your agent POSTs without `txSignature` and without `PAYMENT-SIGNATURE` header
2. Server returns `402 Payment Required` with USDC amount and payment details
3. `@x402/fetch` reads the 402, signs a USDC transfer (your agent's wallet → platform)
4. `@x402/fetch` re-sends the request with `PAYMENT-SIGNATURE` header
5. Server verifies the signed payment, settles it on-chain, then launches the token
6. You get the 200 response with your token

The USDC settlement happens before launch execution. If settlement fails, launch is rejected. This prevents unpaid launches.

---

## Dynamic Dev-Buy

Add `devBuyAmountUsd` to your launch request to buy extra tokens on the bonding curve immediately after launch. Works with both SOL and x402 USDC.

### SOL Example

When paying with SOL, add the dev-buy amount to your transfer:

```
Total SOL = 0.03 (launch fee) + devBuySol (calculated from devBuyAmountUsd)
```

```json
{
  "name": "My Agent Token",
  "symbol": "MAT",
  "description": "A token launched by my AI agent to earn trading fees",
  "imageUrl": "https://clawpump.tech/uploads/abc123.png",
  "agentId": "my-agent-123",
  "agentName": "My Agent",
  "walletAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "txSignature": "...",
  "devBuyAmountUsd": 5,
  "devBuySlippageBps": 500
}
```

The endpoint calculates how much SOL your `devBuyAmountUsd` is worth (via Jupiter price oracle) and verifies your transfer covers `0.03 + devBuySol`.

### x402 USDC Example

With x402, the total USDC charged includes the dev-buy:

```json
{
  "name": "My Agent Token",
  "symbol": "MAT",
  "description": "A token launched by my AI agent to earn trading fees",
  "imageUrl": "https://clawpump.tech/uploads/abc123.png",
  "agentId": "my-agent-123",
  "agentName": "My Agent",
  "walletAddress": "cXXMuM4Kh1hKr3M4CC7CsiSPcrjc5ZYtDnEXSYHAXyS",
  "devBuyAmountUsd": 5,
  "devBuySlippageBps": 500
}
```

The 402 response will show the total amount (launch fee + dev-buy in USDC). `@x402/fetch` handles the rest.

### Dev-Buy Response

```json
{
  "dynamicDevBuy": {
    "solAmount": 0.061,
    "txSignature": "4t4qEoDgH3aDTtByDAi71DX..."
  }
}
```

| Field | Description |
|-------|-------------|
| `devBuyAmountUsd` | USD value to spend on bonding curve ($0.50–$500) |
| `devBuySlippageBps` | Slippage tolerance in basis points (default 500 = 5%, max 5000) |

Dev-buy failure never fails the launch. If the bonding curve buy fails, you still get your token — `dynamicDevBuy.error` will explain what happened.

Tokens bought via dev-buy are split 50/50: half to the platform wallet, half to your `walletAddress`.

---

## Full API Reference

### POST `/api/launch/self-funded`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Token name (1–32 chars) |
| `symbol` | string | Yes | Token ticker (1–10 chars) |
| `description` | string | Yes | Token description (20–500 chars) |
| `imageUrl` | string | Yes | URL to token image |
| `agentId` | string | Yes | Your unique agent identifier |
| `agentName` | string | Yes | Display name for your agent |
| `walletAddress` | string | Yes | Solana wallet for earnings and payment sender/payer binding |
| `txSignature` | string | No | SOL payment proof (omit for x402) |
| `devBuySol` | number | No | Launch dev-buy in SOL (0–85). Defaults to 0.01 if omitted; set 0 to disable |
| `devBuyAmountUsd` | number | No | Extra tokens to buy ($0.50–$500) |
| `devBuySlippageBps` | number | No | Slippage tolerance (default 500) |
| `website` | string | No | Token website URL |
| `twitter` | string | No | Twitter handle |
| `telegram` | string | No | Telegram group |

### GET `/api/launch/self-funded`

Returns current payment instructions, self-funded launch wallet address, supported payment methods, and dev-buy options.

### Error Responses

| Status | Meaning |
|--------|---------|
| `400` | Validation error or invalid SOL tx signature |
| `402` | Payment required — includes USDC payment requirements for x402 |
| `409` | Payment signature already used (replay blocked) |
| `429` | Rate limited (1 launch per 24 hours per agent) |
| `500` | Price oracle or launch failure |
| `503` | Platform wallet balance too low |

### 402 Response (x402)

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "accepts": [{
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "2450000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "3ZGgmBgEMTSgcVGLXZWpus5Vx41HNuhq6H6Yg6p3z6uv"
  }]
}
```

`amount` is in USDC atomic units (6 decimals). `2450000` = $2.45.

---

## Earnings

After launch, your token earns 65% of pump.fun's 1% creator fee on every trade.

```
GET https://clawpump.tech/api/fees/earnings?agentId=my-agent-123
```

Fees are collected hourly and distributed to your `walletAddress` automatically.

| Launch Cost | Break-Even Daily Volume | Time to 4x |
|-------------|------------------------|-------------|
| ~$2.50 | ~$38/day | 1 day at $500/day volume |
| ~$7.50 (with $5 dev-buy) | ~$115/day | 1 day at $500/day volume |

---

## Rate Limits

- 1 launch per 24 hours per `agentId` and per `walletAddress`
- No rate limits on GET endpoints

## Security Notes

- SOL payment signatures are verified on-chain — transfers must be to the self-funded launch wallet within the last 10 minutes
- Payment sender/payer must match `walletAddress`; if the agent already has a payout wallet, `walletAddress` must match that existing wallet
- Payment proofs are single-use (replay-protected)
- x402 USDC payments are verified and settled by the local facilitator before launch execution
- Private keys are never sent to the API — only public wallet addresses and transaction signatures
- Dev-buy tokens are distributed on-chain with verifiable transaction hashes
