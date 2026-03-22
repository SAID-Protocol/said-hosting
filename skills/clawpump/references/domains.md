# clawpump — Domain Search & Registration API for AI Agents

Search, check availability, and register domains for your AI agent. Powered by Conway Domains.

Base URL: `https://clawpump.tech`

---

## How It Works

ClawPump wraps the Conway Domains API to give AI agents access to domain search, availability checking, and pricing. Search and check endpoints are free. Registration (Phase 2) adds a 10% service fee on top of Conway's registrar price.

```
1. Search domains by keyword → get available options with prices
2. Check exact domain availability → confirm before registering
3. Get TLD pricing → compare costs across extensions
4. Register a domain (Phase 2) → pay in SOL, ClawPump handles Conway
```

---

## Quick Start

### Step 1 — Search for Domains

```
GET https://clawpump.tech/api/domains/search?q=myagent&tlds=com,io,ai
```

Response:
```json
{
  "query": "myagent",
  "results": [
    {
      "domain": "myagent.com",
      "available": false
    },
    {
      "domain": "myagent.io",
      "available": true,
      "price": 32.99,
      "pricing": {
        "conwayPrice": 32.99,
        "clawpumpFee": 3.30,
        "totalPrice": 36.29,
        "feePercent": 10
      }
    },
    {
      "domain": "myagent.ai",
      "available": true,
      "price": 54.99,
      "pricing": {
        "conwayPrice": 54.99,
        "clawpumpFee": 5.50,
        "totalPrice": 60.49,
        "feePercent": 10
      }
    }
  ],
  "source": "conway",
  "timestamp": 1739700000000
}
```

### Step 2 — Check Exact Availability

```
GET https://clawpump.tech/api/domains/check?domains=myagent.dev,myagent.xyz
```

Response:
```json
{
  "domains": ["myagent.dev", "myagent.xyz"],
  "results": [
    {
      "domain": "myagent.dev",
      "available": true,
      "price": 12.99,
      "pricing": {
        "conwayPrice": 12.99,
        "clawpumpFee": 1.30,
        "totalPrice": 14.29,
        "feePercent": 10
      }
    },
    {
      "domain": "myagent.xyz",
      "available": true,
      "price": 1.99,
      "pricing": {
        "conwayPrice": 1.99,
        "clawpumpFee": 0.20,
        "totalPrice": 2.19,
        "feePercent": 10
      }
    }
  ],
  "source": "conway",
  "timestamp": 1739700000000
}
```

### Step 3 — Compare TLD Pricing

```
GET https://clawpump.tech/api/domains/pricing?tlds=com,io,dev,ai
```

Response:
```json
{
  "pricing": [
    {
      "tld": "com",
      "register": {
        "conwayPrice": 11.07,
        "clawpumpFee": 1.11,
        "totalPrice": 12.18,
        "feePercent": 10
      },
      "renew": {
        "conwayPrice": 12.99,
        "clawpumpFee": 1.30,
        "totalPrice": 14.29,
        "feePercent": 10
      },
      "currency": "USD"
    }
  ],
  "feePercent": 10,
  "note": "Prices include a 10% ClawPump service fee. Registration available in Phase 2.",
  "timestamp": 1739700000000
}
```

---

## API Reference

### Search Domains

**GET** `/api/domains/search`

Search for available domains by keyword across multiple TLDs.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `q` | string | Yes | Search keyword (1-63 chars) |
| `tlds` | string | No | Comma-separated TLDs (default: com,io,ai,dev,xyz,net,org) |
| `agentId` | string | No | Agent ID for rate limiting |

**Rate limit:** 30 requests per minute per agentId/IP.

### Check Domain Availability

**GET** `/api/domains/check`

Check exact availability of specific domain names.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `domains` | string | Yes | Comma-separated full domain names (max 20) |
| `agentId` | string | No | Agent ID for rate limiting |

**Rate limit:** 30 requests per minute per agentId/IP.

### Get TLD Pricing

**GET** `/api/domains/pricing`

Get registration and renewal pricing for TLDs.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tlds` | string | No | Comma-separated TLDs (default: com,io,ai,dev,xyz,net,org) |

### Capabilities

**GET** `/api/domains/capabilities`

Returns supported TLDs, fee structure, and available operations.

### Register a Domain (Phase 2)

**POST** `/api/domains/register` — _Coming soon_

Registration requires a Conway API key. The agent will pay the domain cost plus 10% fee in SOL (at current market rate) via a transfer to the platform wallet. ClawPump handles the Conway registration.

---

## Default TLDs

When no `tlds` parameter is specified, these extensions are searched:

| TLD | Typical Price Range |
|-----|-------------------|
| `.com` | $11-13 |
| `.io` | $30-35 |
| `.ai` | $50-60 |
| `.dev` | $12-15 |
| `.xyz` | $1-3 |
| `.net` | $12-15 |
| `.org` | $10-13 |

Prices vary by registrar and promotions. Use the `/api/domains/pricing` endpoint for current rates.

---

## Fee Structure

| Operation | Cost |
|-----------|------|
| Search | Free |
| Check availability | Free |
| Pricing lookup | Free |
| Registration (Phase 2) | Conway price + 10% ClawPump fee |

**Example:** Registering `myagent.com` at Conway price $11.07 → ClawPump fee $1.11 → Total $12.18 (paid as equivalent SOL).

---

## Rate Limits

- **30 requests per minute** per `agentId` or IP address
- Applies to `/api/domains/search` and `/api/domains/check`
- `/api/domains/pricing` and `/api/domains/capabilities` are not rate limited

---

## Error Responses

**400** — Validation error:
```json
{ "error": "Validation failed", "details": { "q": ["Search query is required"] } }
```

**429** — Rate limited:
```json
{ "error": "Rate limit exceeded", "limit": 30, "window": "60s" }
```

**500** — Upstream error:
```json
{ "error": "Failed to search domains", "message": "Conway search failed (502): ..." }
```

---

## Example: Domain Scout Agent

```js
const API = "https://clawpump.tech";

async function findDomain(keyword) {
  // Search across popular TLDs
  const res = await fetch(
    `${API}/api/domains/search?q=${keyword}&tlds=com,io,ai,dev,xyz`
  );
  const data = await res.json();

  // Filter available domains, sorted by price
  const available = data.results
    .filter(r => r.available && r.pricing)
    .sort((a, b) => a.pricing.totalPrice - b.pricing.totalPrice);

  if (available.length > 0) {
    const best = available[0];
    console.log(`Best option: ${best.domain} at $${best.pricing.totalPrice}/yr`);
    console.log(`  Conway: $${best.pricing.conwayPrice} + Fee: $${best.pricing.clawpumpFee}`);
  }

  return available;
}

// Check specific domains
async function checkExact(domains) {
  const res = await fetch(
    `${API}/api/domains/check?domains=${domains.join(",")}`
  );
  return (await res.json()).results;
}

// Usage
const options = await findDomain("smartagent");
const exact = await checkExact(["smartagent.ai", "smartagent.dev"]);
```

---

## Combine with Other ClawPump APIs

- **Launch a token** for your agent with a matching domain: [skill.md](https://clawpump.tech/skill.md)
- **Swap tokens** to convert SOL for domain registration: [swap.md](https://clawpump.tech/swap.md)
- **Scan arbitrage** opportunities while your domain propagates: [arbitrage.md](https://clawpump.tech/arbitrage.md)
- **Trading Intelligence** → market data and macro signals for your agent: [trading-intelligence.md](https://clawpump.tech/trading-intelligence.md)
- **Deploy via X** — launch tokens by tweeting @clawpumptech: [deploy-via-x.md](https://clawpump.tech/deploy-via-x.md)
- **SAID Identity** — on-chain agent identity badges: [said-verification.md](https://clawpump.tech/said-verification.md)
- **All skills:** [skills-directory.md](https://clawpump.tech/skills-directory.md)
