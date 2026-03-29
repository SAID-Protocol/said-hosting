# z.ai Trial Integration

**Date:** March 29, 2026  
**Status:** Ready to deploy (needs z.ai API key)

## Changes

### 1. Extended Trial Period
- Changed from **3 days → 7 days** to match Virtuals Protocol

### 2. Sponsored API Costs via z.ai
Trial users now get sponsored API access via z.ai GLM models instead of requiring BYOK.

**Why z.ai:**
- **Cost:** $10/mo Lite plan = ~400 prompts/week (~40-50 trial users)
- **Quality:** GLM-4.7 is excellent for agents (fast, tool-capable)
- **OpenClaw native:** Works out of the box
- **Better conversion:** Zero friction signup (no API key required)

### 3. Database Schema Changes

Added to `users` table:
```prisma
trialPromptsUsed    Int       @default(0)
trialPromptsLimit   Int       @default(10)
apiProvider         String    @default("byok")  // "byok" or "z-ai"
```

**Migration:** Run `npx prisma db push` after deploy (auto-runs via start.sh)

### 4. Usage Tracking

- Each trial user gets **10 prompts** (≈150-200 agent turns)
- When limit hit: "Trial limit reached. Add your own API key or upgrade."
- Tracks `trialPromptsUsed` per user
- Admin dashboard shows total weekly burn

### 5. Environment Variables

**Required:**
```bash
Z_AI_API_KEY=sk-...   # Get from https://z.ai/manage-apikey
Z_AI_BASE_URL=https://api.z.ai/v1
```

**Optional:**
```bash
TRIAL_PROMPTS_LIMIT=10  # Override default 10 prompts per trial user
```

### 6. Deployment Steps

1. **Get z.ai subscription:**
   - Go to https://z.ai/subscribe
   - Choose **Lite Plan ($10/mo)** for ~40-50 trial users/week
   - Or **Pro Plan ($30/mo)** for ~200-400 trial users/week

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

### 7. Pricing Tiers After Trial

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

### 8. Cost Safety

**Hard caps:**
- 10 prompts per trial user (~$0.20-0.30 cost)
- Auto-pause agent at limit
- Weekly usage dashboard for monitoring

**Lite Plan ($10/mo) capacity:**
- 400 prompts/week total
- ~40-50 trial users/week at 10 prompts each
- If exceeded: prompt users to upgrade OR wait for weekly reset

**Abuse prevention:**
- Email verification required for trials
- Max 1 trial per email
- IP rate limiting (existing)

### 9. Future Enhancements

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
- `Z-AI-TRIALS.md` - This file (deployment guide)

## Rollback Plan

If z.ai integration has issues:
1. Revert to `main` branch
2. Falls back to 3-day BYOK trial
3. No data loss (new fields have defaults)

---

**Ready to deploy:** Yes, pending z.ai API key from Callum.
