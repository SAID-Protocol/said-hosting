import { Router } from 'express';
import { prisma } from '../db';
import { createAgentWallet } from '../services/privy-wallets';
import { registerAgent, verifyAgent } from '../services/butler-registration';

export const butlerRouter = Router();

/**
 * All butler endpoints are API-key authed (called from inside agent containers).
 * These provision AGENTS (not user identities) — each user gets their own agent
 * with its own wallet and on-chain SAID identity.
 */
function requireApiKey(req: any, res: any, next: any) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

butlerRouter.use(requireApiKey);

/**
 * Step 1: Provision a new agent
 * Creates Privy wallet + DB record. No on-chain registration yet.
 *
 * POST /api/butler/provision
 * Body: { externalId: "tg_123456789", platform: "telegram" }
 * Returns: { id, externalId, walletAddress }
 */
butlerRouter.post('/provision', async (req, res) => {
  try {
    const { externalId, platform } = req.body || {};

    if (!externalId || typeof externalId !== 'string') {
      res.status(400).json({ error: 'externalId is required (e.g. "tg_123456789")' });
      return;
    }
    if (!platform || typeof platform !== 'string') {
      res.status(400).json({ error: 'platform is required (e.g. "telegram")' });
      return;
    }

    // Idempotent: if agent already exists, return existing record
    const existing = await prisma.butlerUser.findUnique({ where: { externalId } });
    if (existing) {
      res.json({
        id: existing.id,
        externalId: existing.externalId,
        walletAddress: existing.walletAddress,
        displayName: existing.displayName,
        saidRegistered: existing.saidRegistered,
        saidVerified: existing.saidVerified,
        saidPda: existing.saidPda,
        alreadyExists: true,
      });
      return;
    }

    // Create Privy wallet for the agent
    const { walletId, address } = await createAgentWallet();
    console.log(`[butler] Provisioned agent wallet ${address} for ${externalId}`);

    // Create DB record
    const user = await prisma.butlerUser.create({
      data: {
        externalId,
        platform,
        walletAddress: address,
        privyWalletId: walletId,
      },
    });

    res.status(201).json({
      id: user.id,
      externalId: user.externalId,
      walletAddress: address,
      displayName: null,
      saidRegistered: false,
      saidVerified: false,
      saidPda: null,
      alreadyExists: false,
    });
  } catch (error) {
    console.error('[butler] Provision error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Provision failed' });
  }
});

/**
 * Step 2: Register agent on-chain (sponsored — we pay gas + rent, costs dust)
 * Agent appears in SAID directory as REGISTERED.
 * Does NOT verify — verification happens when user funds the agent.
 *
 * POST /api/butler/register-said
 * Body: { externalId: "tg_123456789", displayName: "My Cool Agent" }
 * Returns: { success, saidPda, txSignature, walletAddress, profile }
 */
butlerRouter.post('/register-said', async (req, res) => {
  try {
    const { externalId, displayName } = req.body || {};

    if (!externalId || typeof externalId !== 'string') {
      res.status(400).json({ error: 'externalId is required' });
      return;
    }
    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      res.status(400).json({ error: 'displayName is required (the agent name)' });
      return;
    }

    const user = await prisma.butlerUser.findUnique({ where: { externalId } });
    if (!user) {
      res.status(404).json({ error: 'Agent not found — call /provision first' });
      return;
    }
    if (!user.walletAddress || !user.privyWalletId) {
      res.status(400).json({ error: 'Agent wallet not provisioned' });
      return;
    }

    // Already fully registered on-chain
    if (user.saidRegistered && user.saidPda) {
      res.json({
        success: true,
        saidPda: user.saidPda,
        walletAddress: user.walletAddress,
        displayName: user.displayName,
        saidRegistered: true,
        saidVerified: user.saidVerified,
        alreadyRegistered: true,
        profile: `https://www.saidprotocol.com/agents/${user.walletAddress}`,
      });
      return;
    }

    const trimmedName = displayName.trim();

    // Register on-chain (sponsored, dust cost)
    const result = await registerAgent(
      user.walletAddress,
      user.privyWalletId,
      trimmedName,
      user.platform,
      externalId,
    );

    // Update DB — registered but NOT verified
    await prisma.butlerUser.update({
      where: { externalId },
      data: {
        displayName: trimmedName,
        saidPda: result.pda,
        saidRegistered: true,
        saidVerified: false, // Verification requires funding
      },
    });

    console.log(`[butler] Registered ON-CHAIN for ${externalId}: PDA=${result.pda}`);

    res.json({
      success: true,
      saidPda: result.pda,
      walletAddress: user.walletAddress,
      displayName: trimmedName,
      status: 'REGISTERED',
      profile: result.profile,
      badge: result.badge,
      onChain: true,
      txSignature: result.txSignature,
    });
  } catch (error) {
    console.error('[butler] Register SAID error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
  }
});

/**
 * Step 3: Verify agent on-chain (paid from agent wallet, ~0.013 SOL)
 * Triggered by deposit monitor when user funds the agent.
 * Sends get_verified tx + mints Metaplex NFT.
 *
 * POST /api/butler/verify-said
 * Body: { externalId: "tg_123456789" }
 * Returns: { success, verifyTxSignature, nftMinted }
 */
butlerRouter.post('/verify-said', async (req, res) => {
  try {
    const { externalId } = req.body || {};

    if (!externalId || typeof externalId !== 'string') {
      res.status(400).json({ error: 'externalId is required' });
      return;
    }

    const user = await prisma.butlerUser.findUnique({ where: { externalId } });
    if (!user) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (!user.saidRegistered) {
      res.status(400).json({ error: 'Agent must be registered before verification' });
      return;
    }
    if (user.saidVerified) {
      res.json({
        success: true,
        walletAddress: user.walletAddress,
        alreadyVerified: true,
        status: 'VERIFIED',
      });
      return;
    }
    if (!user.walletAddress || !user.privyWalletId) {
      res.status(400).json({ error: 'Agent wallet not provisioned' });
      return;
    }

    // Verify on-chain (agent wallet pays ~0.013 SOL)
    const result = await verifyAgent(
      user.walletAddress,
      user.privyWalletId,
      user.displayName || 'SAID Agent',
      user.platform,
    );

    // Update DB
    await prisma.butlerUser.update({
      where: { externalId },
      data: {
        saidVerified: true,
        verificationTx: result.verifyTxSignature,
      },
    });

    console.log(`[butler] Verified ON-CHAIN for ${externalId}: tx=${result.verifyTxSignature}`);

    res.json({
      success: true,
      walletAddress: user.walletAddress,
      saidPda: user.saidPda,
      status: 'VERIFIED',
      verifyTxSignature: result.verifyTxSignature,
      nftMinted: result.nftMinted,
      profile: result.profile,
      badge: result.badge,
    });
  } catch (error) {
    console.error('[butler] Verify SAID error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Verification failed' });
  }
});

/**
 * Check if an agent exists
 *
 * GET /api/butler/user/:externalId
 * Returns: agent record or { exists: false }
 */
butlerRouter.get('/user/:externalId', async (req, res) => {
  try {
    const user = await prisma.butlerUser.findUnique({
      where: { externalId: req.params.externalId },
    });

    if (!user) {
      res.json({ exists: false });
      return;
    }

    res.json({
      exists: true,
      id: user.id,
      externalId: user.externalId,
      platform: user.platform,
      displayName: user.displayName,
      walletAddress: user.walletAddress,
      saidPda: user.saidPda,
      saidRegistered: user.saidRegistered,
      saidVerified: user.saidVerified,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Lookup failed' });
  }
});

/**
 * List all agents (admin/stats)
 *
 * GET /api/butler/users?limit=50&offset=0
 */
butlerRouter.get('/users', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const [users, total] = await Promise.all([
      prisma.butlerUser.findMany({
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.butlerUser.count(),
    ]);

    res.json({ users, total, limit, offset });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'List failed' });
  }
});
