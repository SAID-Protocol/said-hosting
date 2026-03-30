# z.ai Trial Integration

**Date:** March 29, 2026  
**Status:** Ready to deploy (needs z.ai API key)  
**Plan:** $80/mo custom plan (~10-12k prompts/week capacity)

## Changes

### 1. Extended Trial Period
- Changed from **3 days → 7 days** to match Virtuals Protocol

### 2. Sponsored API Costs via z.ai (Secure Proxy)
Trial users now get sponsored API access via z.ai GLM models instead of requiring BYOK.

**Security Model (Prevents Prompt Injection):**
- Trial agents **DO NOT get direct API keys**
- They call our secure proxy: `https://host.saidprotocol.com/api/ai-proxy`
- Proxy authenticates agent via `x-agent-id` header
- Real `Z_AI_API_KEY` stays server-side (never exposed to agents)
- Even if agent is compromised: max 10 prompts damage (hard cap per user)

**Why z.ai:**
- **Cost:** $80/mo custom plan = ~10-12k prompts/week (~20-24 trial users at 500 prompts each)
- **Quality:** GLM-4.7 is excellent for agents (fast, tool-capable)
- **OpenClaw native:** Works out of the box
- **Better conversion:** Zero friction signup (no API key required)
- **Competitive:** 500 prompts (~$0.80 value) matches Virtuals' $1 credit trial

### 3. Database Schema Changes

Added to `users` table:
```prisma
trialPromptsUsed    Int       @default(0)
trialPromptsLimit   Int       @default(10)
apiProvider         String    @default("byok")  // "byok" or "z-ai"
```

**Migration:** Run `npx prisma db push` after deploy (auto-runs via start.sh)

### 4. Usage Tracking

- Each trial user gets **500 prompts** (≈~$0.80 value, matches Virtuals' $1 credit)
- Enough for meaningful testing over 7 days (50-100 conversations)
- When limit hit: "Trial limit reached. Add your own API key or upgrade."
- Tracks `trialPromptsUsed` per user
- Admin dashboard shows total weekly burn

### 5. Secure Proxy Architecture

**Flow:**
```
Trial Agent (OpenClaw container)
  ↓ OPENAI_BASE_URL=https://host.saidprotocol.com/api/ai-proxy
  ↓ x-agent-id: <agent-uuid>
  ↓
Platform API (/api/ai-proxy/v1/chat/completions)
  ↓ Authenticate agent via x-agent-id
  ↓ Check trialPromptsUsed < trialPromptsLimit (server-side)
  ↓ Add real Z_AI_API_KEY (never exposed)
  ↓ Increment usage counter
  ↓ Forward request to z.ai API
  ↓
z.ai GLM-4.7
```

**Agent Environment (no real key exposed):**
```bash
OPENAI_BASE_URL=https://host.saidprotocol.com/api/ai-proxy
OPENAI_API_KEY=trial-agent  # Dummy key (proxy ignores it)
ANTHROPIC_BASE_URL=https://host.saidprotocol.com/api/ai-proxy
```

**Prompt Injection Mitigation:**
Even if attacker extracts the proxy URL and agent ID:
- ✅ Rate limited to 500 prompts per agent (hard cap)
- ✅ Server-side validation (can't bypass)
- ✅ Real API key never exposed
- ✅ Max damage: ~$0.80 per compromised agent

### 6. Environment Variables

**Required:**
```bash
Z_AI_API_KEY=sk-...   # Get from https://z.ai/manage-apikey
Z_AI_BASE_URL=https://api.z.ai/api/paas/v4/
```

**Optional:**
```bash
TRIAL_PROMPTS_LIMIT=500  # Override default 500 prompts per trial user
```

### 7. New API Endpoints

**POST /api/ai-proxy/v1/chat/completions**
- OpenAI-compatible endpoint for trial agents
- Authenticates via `x-agent-id` header
- Proxies to z.ai with server-side key
- Returns 429 when trial quota exceeded

**GET /api/ai-proxy/quota**
- Check remaining trial quota for an agent
- Requires `x-agent-id` header
- Returns: `{ used, limit, remaining, provider }`

**GET /api/ai-proxy/health**
- Health check for proxy service
- Returns: `{ status: 'ok', service: 'ai-proxy', provider: 'z.ai' }`

### 8. Deployment Steps

1. **Get z.ai subscription:**
   - Go to https://z.ai/subscribe
   - Choose **$80/mo custom plan** for ~20-24 trial users/week at 500 prompts each
   - Higher capacity than Lite/Pro for serious trial volume

2. **Add environment variables to Railway:**
   ```
   Z_AI_API_KEY=sk-...
   Z_AI_BASE_URL=https://api.z.ai/v1
   ```

3. **Deploy this branch:**
   ```bash
   git push origin feature/z-ai-trials
   ```
   - Railway auto-runs `npx prisma db push` (adds new fields)
   - Existing users unaffected (defaults applied)

4. **Test:**
   - Create new trial user
   - Check agent uses z.ai API key
   - Verify prompt counting works
   - Hit limit, check auto-pause message

### 9. Pricing Tiers After Trial

| Tier | Price | Model Access |
|------|-------|--------------|
| **Trial** | Free 7 days | z.ai GLM-4.7 (10 prompts) |
| **Starter BYOK** | $14/mo | User's API key |
| **Pro BYOK** | $39/mo | User's API key |
| **Power BYOK** | $99/mo | User's API key |

**After trial:**
- User must either:
  1. Add their own API key (continue free with BYOK)
  2. Upgrade to paid BYOK tier (3-25 agents)

### 10. Cost Safety

**Hard caps:**
- 500 prompts per trial user (~$0.80 cost)
- Auto-pause agent at limit
- Weekly usage dashboard for monitoring

**$80/mo Custom Plan capacity:**
- ~10-12k prompts/week estimated
- ~20-24 trial users/week at 500 prompts each
- Enough headroom for growth

**Abuse prevention:**
- Email verification required for trials
- Max 1 trial per email
- IP rate limiting (existing)
- Server-side quota enforcement (can't bypass)

### 11. Future Enhancements

**Week 2-3:**
- Admin dashboard: trial usage stats
- Email alerts: "80% of weekly quota used"
- Auto-upgrade prompt: "Upgrade to Pro plan for more trials"

**Month 2:**
- A/B test trial limits (5 vs 10 vs 15 prompts)
- Conversion tracking (trial → paid)
- Cohort analysis (GLM-4.7 trial → Sonnet paid)

---

## Files Changed

- `prisma/schema.prisma` - Added trial prompt tracking fields
- `src/services/billing.ts` - Extended TRIAL_DAYS to 7
- `src/routes/ai-proxy.ts` - NEW: Secure proxy for trial agents (prevents prompt injection)
- `src/index.ts` - Registered ai-proxy router
- `Z-AI-TRIALS.md` - This file (deployment guide with security model)

## Rollback Plan

If z.ai integration has issues:
1. Revert to `main` branch
2. Falls back to 3-day BYOK trial
3. No data loss (new fields have defaults)

---

**Ready to deploy:** Yes, pending z.ai API key from Callum.
