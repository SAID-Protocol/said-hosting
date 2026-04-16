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
