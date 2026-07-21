import { Router, Request } from 'express';
import { prisma } from '../db';
import { createAgent, startAgent, stopAgent, deleteAgent } from '../services/agent';
import { sendWebhook } from '../services/webhook';
import { CreateAgentRequest } from '../types';

export const partnerRouter = Router();

const ALLOWED_PARTNER_TIERS = new Set(['starter', 'pro', 'power']);

async function ensurePartnerUser(partnerId: string): Promise<string> {
  const userId = `partner-${partnerId}`;
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      email: `${userId}@partners.saidprotocol.com`,
      tier: 'pro',
      billingStatus: 'active',
    },
  });
  return userId;
}

partnerRouter.post('/agents', async (req, res) => {
  try {
    const partnerId = (req as any).partnerId as string;
    const { name, external_id, platform, webhook_url, description, tier, program_md, config, telegram_token, custom_api_key } = req.body;

    if (!name?.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!external_id?.trim()) {
      res.status(400).json({ error: 'external_id is required' });
      return;
    }
    if (!platform?.trim()) {
      res.status(400).json({ error: 'platform is required' });
      return;
    }

    const resolvedTier = (tier || 'starter').toString();
    if (!ALLOWED_PARTNER_TIERS.has(resolvedTier)) {
      res.status(400).json({
        error: `Invalid tier. Allowed: ${[...ALLOWED_PARTNER_TIERS].join(', ')}`,
      });
      return;
    }

    const existing = await prisma.agent.findUnique({
      where: { platform_externalId: { platform, externalId: external_id } },
    });
    if (existing) {
      res.status(409).json({
        error: 'Agent already exists for this platform + external_id',
        agent_id: existing.id,
        status: existing.status,
      });
      return;
    }

    const partnerUserId = await ensurePartnerUser(partnerId);

    const payload: CreateAgentRequest = {
      name: name.trim(),
      description,
      tier: resolvedTier as CreateAgentRequest['tier'],
      program_md,
      config,
      telegram_token,
      custom_api_key,
    };

    const agent = await createAgent(partnerUserId, payload);

    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        platform,
        externalId: external_id,
        webhookUrl: webhook_url || null,
        partnerId,
      },
    });

    await sendWebhook(agent.id, 'agent.created', {
      name: agent.name,
      status: agent.status,
      wallet_address: agent.walletAddress,
      gateway_token: agent.gatewayToken,
    });

    res.status(201).json({
      agent_id: agent.id,
      external_id,
      platform,
      name: agent.name,
      status: agent.status,
      wallet_address: agent.walletAddress,
      gateway_token: agent.gatewayToken,
      tier: agent.tier,
    });
  } catch (error) {
    console.error('[partner] Create agent failed:', error instanceof Error ? error.message : error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create agent' });
  }
});

partnerRouter.get('/agents/:externalId', async (req, res) => {
  try {
    const partnerId = (req as any).partnerId as string;
    const platform = req.query.platform as string;

    if (!platform) {
      res.status(400).json({ error: 'platform query parameter is required' });
      return;
    }

    const agent = await prisma.agent.findUnique({
      where: { platform_externalId: { platform, externalId: req.params.externalId } },
    });

    if (!agent || agent.partnerId !== partnerId) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    res.json({
      agent_id: agent.id,
      external_id: agent.externalId,
      platform: agent.platform,
      name: agent.name,
      status: agent.status,
      tier: agent.tier,
      wallet_address: agent.walletAddress,
      said_registered: agent.saidRegistered,
      said_verified: agent.saidVerified,
      created_at: agent.createdAt,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to fetch agent' });
  }
});

partnerRouter.post('/agents/:externalId/start', async (req, res) => {
  try {
    const partnerId = (req as any).partnerId as string;
    const platform = req.query.platform as string;
    if (!platform) { res.status(400).json({ error: 'platform query parameter is required' }); return; }

    const agent = await prisma.agent.findUnique({
      where: { platform_externalId: { platform, externalId: req.params.externalId } },
    });
    if (!agent || agent.partnerId !== partnerId) { res.status(404).json({ error: 'Agent not found' }); return; }

    const updated = await startAgent(agent.userId, agent.id);
    await sendWebhook(agent.id, 'agent.running', { status: updated.status });

    res.json({ agent_id: agent.id, status: updated.status });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to start agent' });
  }
});

partnerRouter.post('/agents/:externalId/stop', async (req, res) => {
  try {
    const partnerId = (req as any).partnerId as string;
    const platform = req.query.platform as string;
    if (!platform) { res.status(400).json({ error: 'platform query parameter is required' }); return; }

    const agent = await prisma.agent.findUnique({
      where: { platform_externalId: { platform, externalId: req.params.externalId } },
    });
    if (!agent || agent.partnerId !== partnerId) { res.status(404).json({ error: 'Agent not found' }); return; }

    const updated = await stopAgent(agent.userId, agent.id);
    await sendWebhook(agent.id, 'agent.stopped', { status: updated.status });

    res.json({ agent_id: agent.id, status: updated.status });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to stop agent' });
  }
});

partnerRouter.delete('/agents/:externalId', async (req, res) => {
  try {
    const partnerId = (req as any).partnerId as string;
    const platform = req.query.platform as string;
    if (!platform) { res.status(400).json({ error: 'platform query parameter is required' }); return; }

    const agent = await prisma.agent.findUnique({
      where: { platform_externalId: { platform, externalId: req.params.externalId } },
    });
    if (!agent || agent.partnerId !== partnerId) { res.status(404).json({ error: 'Agent not found' }); return; }

    await sendWebhook(agent.id, 'agent.deleted', { name: agent.name });
    await deleteAgent(agent.userId, agent.id);

    res.json({ success: true, agent_id: agent.id });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to delete agent' });
  }
});

// ── Trust Score Endpoint ─────────────────────────────────────────────────
// Partners can query SAID trust scores for any wallet, including their own agents.
// This enables partners to make trust-aware decisions in their platforms.

partnerRouter.get('/trust/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!wallet || wallet.length < 32 || wallet.length > 44) {
      res.status(400).json({ error: 'Valid wallet address required' });
      return;
    }

    // Query SAID public API for trust data
    const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
    const response = await fetch(`${SAID_API}/api/verify/${wallet}`);

    if (!response.ok) {
      if (response.status === 404) {
        res.json({
          wallet,
          registered: false,
          verified: false,
          trustScore: null,
        });
        return;
      }
      throw new Error(`SAID API returned ${response.status}`);
    }

    const data = await response.json() as any;

    res.json({
      wallet,
      registered: data.registered ?? false,
      verified: data.verified ?? false,
      identity: data.identity ?? null,
      trustScore: data.trustScore ?? null,
      reputation: data.reputation ?? null,
      endpoints: data.endpoints ?? null,
    });
  } catch (error) {
    console.error('[partner] Trust score query failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to query trust score' });
  }
});

// ── Trust Breakdown Endpoint ─────────────────────────────────────────────
// Returns transparent point-by-point score breakdown.

partnerRouter.get('/trust/:wallet/breakdown', async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!wallet || wallet.length < 32 || wallet.length > 44) {
      res.status(400).json({ error: 'Valid wallet address required' });
      return;
    }

    const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
    const response = await fetch(`${SAID_API}/api/verify/${wallet}`);

    if (!response.ok) {
      if (response.status === 404) {
        res.json({ wallet, score: null, breakdown: null });
        return;
      }
      throw new Error(`SAID API returned ${response.status}`);
    }

    const data = await response.json() as any;

    if (!data.trustScore) {
      res.json({
        wallet,
        score: data.reputation?.score ?? 0,
        tier: data.reputation?.tier ?? 'Unverified',
        breakdown: null,
        message: 'Agent verified but no detailed trust score available',
      });
      return;
    }

    const ts = data.trustScore;
    res.json({
      wallet,
      score: ts.score,
      tier: ts.tier,
      badges: ts.badges ?? [],
      sources: ts.sources ?? [],
      breakdown: {
        identity: ts.identity ?? 0,
        activity: ts.activity ?? 0,
        economic: ts.economic ?? 0,
        ecosystem: ts.ecosystem ?? 0,
        longevity: ts.longevity ?? 0,
        fairscale: ts.fairscale ?? 0,
      },
      computedAt: ts.computedAt ?? null,
    });
  } catch (error) {
    console.error('[partner] Trust breakdown failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to query trust breakdown' });
  }
});

// ── Batch Trust Check ────────────────────────────────────────────────────
// Check trust scores for multiple wallets in one call.

partnerRouter.post('/trust/batch', async (req, res) => {
  try {
    const wallets = req.body?.wallets;
    if (!Array.isArray(wallets) || wallets.length === 0) {
      res.status(400).json({ error: 'wallets array is required' });
      return;
    }
    if (wallets.length > 50) {
      res.status(400).json({ error: 'Maximum 50 wallets per batch' });
      return;
    }

    const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';

    const results = await Promise.allSettled(
      wallets.map(async (wallet: string) => {
        const response = await fetch(`${SAID_API}/api/verify/${wallet}`);
        if (!response.ok) {
          return { wallet, registered: false, verified: false, trustScore: null };
        }
        const data = await response.json() as any;
        return {
          wallet,
          registered: data.registered ?? false,
          verified: data.verified ?? false,
          score: data.trustScore?.score ?? null,
          tier: data.trustScore?.tier ?? null,
        };
      })
    );

    const trustResults = results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        wallet: wallets[i],
        registered: false,
        verified: false,
        trustScore: null,
        error: result.reason?.message ?? 'Lookup failed',
      };
    });

    res.json({ results: trustResults });
  } catch (error) {
    console.error('[partner] Batch trust check failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to batch check trust' });
  }
});
