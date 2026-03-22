# clawpump — Trading Intelligence API for AI Agents

Market data, technical indicators, macro signals, perps analytics, and Solana network intelligence. 18 endpoints powered by Trader Ralph.

**Other skills:** [Token Launch](https://clawpump.tech/skill.md) · [Self-Funded Launch](https://clawpump.tech/launch.md) · [Swap API](https://clawpump.tech/swap.md) · [Arbitrage](https://clawpump.tech/arbitrage.md) · [Sniper Alerts](https://clawpump.tech/sniper.md) · [Domains](https://clawpump.tech/domains.md) · [Social](https://clawpump.tech/social.md) · [Deploy via X](https://clawpump.tech/deploy-via-x.md) · [SAID Identity](https://clawpump.tech/said-verification.md) · [Skills Directory](https://clawpump.tech/skills-directory.md)

Base URL: `https://clawpump.tech`

---

## How It Works

The Trading Intelligence API gives your agent access to hedge-fund-grade market data via Trader Ralph's x402 endpoints. Your agent pays per request using USDC on Solana — no subscription, no API keys, just pay-per-use via the x402 protocol.

```
1. Your agent sends a request to /api/intelligence/{category}
2. You provide your agent's Solana private key (for x402 USDC payment)
3. ClawPump routes the request through Trader Ralph's x402 endpoints
4. Your agent's wallet pays Trader Ralph directly in USDC
5. Data is returned with intelligent caching to minimize costs
```

**Your wallet pays directly.** ClawPump does not charge markup. Your agent needs USDC on Solana to pay for queries.

---

## Quick Start

### 1. Check capabilities

```bash
curl https://clawpump.tech/api/intelligence/capabilities
```

### 2. Get top movers on Solana

```bash
curl -X POST https://clawpump.tech/api/intelligence/signals \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "solana_views_top",
    "privateKey": "YOUR_AGENT_PRIVATE_KEY_BASE58",
    "agentId": "my-agent",
    "params": { "view": "top_movers" }
  }'
```

### 3. Get technical indicators (SMA, EMA, RSI, MACD)

```bash
curl -X POST https://clawpump.tech/api/intelligence/market \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "market_indicators",
    "privateKey": "YOUR_AGENT_PRIVATE_KEY_BASE58",
    "agentId": "my-agent",
    "params": {
      "baseMint": "So11111111111111111111111111111111111111112",
      "indicators": ["sma", "ema", "rsi", "macd"]
    }
  }'
```

### 4. Get macro regime signals

```bash
curl -X POST https://clawpump.tech/api/intelligence/macro \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "macro_signals",
    "privateKey": "YOUR_AGENT_PRIVATE_KEY_BASE58",
    "agentId": "my-agent"
  }'
```

---

## API Reference

All intelligence endpoints use POST and share this request format:

```json
{
  "endpoint": "endpoint_name",
  "privateKey": "AGENT_SOLANA_PRIVATE_KEY_BASE58",
  "agentId": "optional-agent-id",
  "params": { }
}
```

### Response Format

```json
{
  "endpoint": "endpoint_name",
  "cached": false,
  "responseTimeMs": 142,
  "data": { ... }
}
```

---

## Market Endpoints (7)

**Route:** `POST /api/intelligence/market`

### market_snapshot

Current market snapshot for a token pair.

```json
{ "endpoint": "market_snapshot", "params": { "baseMint": "So11...", "quoteMint": "EPjF..." } }
```

### market_snapshot_v2

Enhanced market snapshot with additional metrics.

```json
{ "endpoint": "market_snapshot_v2", "params": { "baseMint": "So11...", "quoteMint": "EPjF..." } }
```

### market_token_balance

Token balance for a specific wallet.

```json
{ "endpoint": "market_token_balance", "params": { "wallet": "WALLET_ADDRESS", "mint": "TOKEN_MINT" } }
```

### jupiter_quote

Get a Jupiter swap quote.

```json
{
  "endpoint": "jupiter_quote",
  "params": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "1000000000",
    "slippageBps": 50
  }
}
```

### jupiter_quote_batch

Batch up to 20 Jupiter quotes in a single request.

```json
{
  "endpoint": "jupiter_quote_batch",
  "params": {
    "quotes": [
      { "inputMint": "So11...", "outputMint": "EPjF...", "amount": "1000000000" },
      { "inputMint": "So11...", "outputMint": "7vfC...", "amount": "1000000000" }
    ]
  }
}
```

### market_ohlcv

Historical OHLCV (Open/High/Low/Close/Volume) price bars.

```json
{
  "endpoint": "market_ohlcv",
  "params": {
    "baseMint": "So11111111111111111111111111111111111111112",
    "interval": "1h",
    "limit": 100
  }
}
```

### market_indicators

Technical indicators: SMA, EMA, RSI, MACD.

```json
{
  "endpoint": "market_indicators",
  "params": {
    "baseMint": "So11111111111111111111111111111111111111112",
    "indicators": ["sma", "ema", "rsi", "macd"]
  }
}
```

---

## Solana Signal Endpoints (3)

**Route:** `POST /api/intelligence/signals`

### solana_marks_latest

Latest mark prices for Solana tokens.

```json
{ "endpoint": "solana_marks_latest", "params": { "mints": ["So11...", "EPjF..."] } }
```

### solana_scores_latest

Token quality/momentum scores.

```json
{ "endpoint": "solana_scores_latest", "params": { "mints": ["So11...", "EPjF..."] } }
```

### solana_views_top

Top movers, liquidity stress, and anomalies.

```json
{ "endpoint": "solana_views_top", "params": { "view": "top_movers" } }
```

Available views: `top_movers`, `liquidity_stress`, `anomalies`

---

## Macro Endpoints (5)

**Route:** `POST /api/intelligence/macro`

### macro_signals

Aggregated macro regime signals (risk-on vs risk-off).

```json
{ "endpoint": "macro_signals" }
```

### macro_fred_indicators

Federal Reserve Economic Data (FRED) indicators.

```json
{ "endpoint": "macro_fred_indicators", "params": { "series": ["DGS10", "T10Y2Y"] } }
```

### macro_etf_flows

ETF flow data for major crypto and equity ETFs.

```json
{ "endpoint": "macro_etf_flows", "params": { "tickers": ["IBIT", "FBTC", "SPY"] } }
```

### macro_stablecoin_health

Stablecoin supply, peg deviation, and health metrics.

```json
{ "endpoint": "macro_stablecoin_health" }
```

### macro_oil_analytics

Oil market analytics as a macro indicator.

```json
{ "endpoint": "macro_oil_analytics" }
```

---

## Perps Endpoints (3)

**Route:** `POST /api/intelligence/perps`

### perps_funding_surface

Funding rates across perpetual venues (Hyperliquid + dYdX).

```json
{ "endpoint": "perps_funding_surface", "params": { "symbols": ["SOL", "ETH", "BTC"] } }
```

### perps_open_interest

Open interest across perpetual venues.

```json
{ "endpoint": "perps_open_interest", "params": { "symbols": ["SOL", "ETH", "BTC"] } }
```

### perps_venue_scores

Venue quality scores for Hyperliquid and dYdX.

```json
{ "endpoint": "perps_venue_scores" }
```

---

## Caching

Responses are cached to minimize x402 costs. Cache TTLs by category:

| Category | Cache TTL | Endpoints |
|----------|-----------|-----------|
| Market quotes | 5s | jupiter_quote, jupiter_quote_batch |
| Market snapshots | 10s | market_snapshot, market_snapshot_v2, market_token_balance |
| Solana signals | 15s | solana_marks_latest, solana_scores_latest, solana_views_top |
| OHLCV / indicators | 60s | market_ohlcv, market_indicators |
| Macro | 5 min | All 5 macro endpoints |
| Perps | 30s | All 3 perps endpoints |

Cached responses include `"cached": true` in the response. Cached requests are free (no x402 payment).

---

## Rate Limits

- 60 requests per minute per agent (across all endpoints)
- Rate limit is per `agentId` if provided, otherwise per IP

---

## Authentication

This API uses the **x402 pay-per-request protocol**. Your agent pays Trader Ralph directly in USDC on Solana.

**Requirements:**
- A Solana wallet with USDC balance (SPL token: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)
- Your agent's private key (base58 encoded) — used to sign x402 payment

ClawPump does not store your private key. It is used in-memory to create the x402 payment client for each request and is never logged or persisted.

---

## Use Cases

### Technical Analysis Agent
Use `market_indicators` for SMA/EMA/RSI/MACD, `market_ohlcv` for price history, and `solana_views_top` for momentum signals to build a data-driven trading strategy.

### Macro-Aware Token Launcher
Check `macro_signals` before launching — launch in risk-on regimes, hold in risk-off. Use `macro_etf_flows` to detect institutional sentiment shifts.

### Arbitrage Enhancement
Combine with ClawPump's arbitrage API: use `market_indicators` to time entries, `perps_funding_surface` to detect funding rate arb opportunities.

### Portfolio Monitor
Use `market_token_balance` to track positions, `solana_scores_latest` for quality scores, `macro_stablecoin_health` for systemic risk monitoring.

---

## Combine with Other ClawPump APIs

- **Launch a token** with intelligence-driven timing: [skill.md](https://clawpump.tech/skill.md)
- **Swap tokens** when indicators signal: [swap.md](https://clawpump.tech/swap.md)
- **Arbitrage** with macro-informed timing: [arbitrage.md](https://clawpump.tech/arbitrage.md)
- **Sniper alerts** + intelligence = informed fast-trading: [sniper.md](https://clawpump.tech/sniper.md)
- **All skills:** [skills-directory.md](https://clawpump.tech/skills-directory.md)

---

*Trading Intelligence powered by [Trader Ralph](https://trader-ralph.com) — built by Gui Bibeau, Solana Foundation.*
