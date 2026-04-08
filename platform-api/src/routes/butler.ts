import { Router } from 'express';
import { prisma } from '../db';
import { createAgentWallet, signMessage } from '../services/privy-wallets';

export const butlerRouter = Router();

/**
 * All butler endpoints are API-key authed (called from inside agent containers).
 * These are lightweight — they create wallets and DB records but NO containers.
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
 * Step 1: Provision a new user identity
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

    // Idempotent: if user already exists, return existing record
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

    // Create Privy wallet
    const { walletId, address } = await createAgentWallet();
    console.log(`[butler] Provisioned wallet ${address} for ${externalId}`);

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
 * Step 2: Register SAID identity on-chain (sponsored — we pay gas)
 * User must be provisioned first. Requires a display name (the nickname).
 *
 * POST /api/butler/register-said
 * Body: { externalId: "tg_123456789", displayName: "My Cool Agent" }
 * Returns: { success, saidPda, signature, walletAddress }
 */
butlerRouter.post('/register-said', async (req, res) => {
  try {
    const { externalId, displayName } = req.body || {};

    if (!externalId || typeof externalId !== 'string') {
      res.status(400).json({ error: 'externalId is required' });
      return;
    }
    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      res.status(400).json({ error: 'displayName is required (the agent nickname)' });
      return;
    }

    const user = await prisma.butlerUser.findUnique({ where: { externalId } });
    if (!user) {
      res.status(404).json({ error: 'User not found — call /provision first' });
      return;
    }
    if (!user.walletAddress || !user.privyWalletId) {
      res.status(400).json({ error: 'User wallet not provisioned' });
      return;
    }
    if (user.saidRegistered) {
      res.json({
        success: true,
        saidPda: user.saidPda,
        walletAddress: user.walletAddress,
        displayName: user.displayName,
        alreadyRegistered: true,
      });
      return;
    }

    const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
    const trimmedName = displayName.trim();
    const timestamp = Date.now();

    // Build the registration message (must match Protocol API's format)
    const registrationMessage = `SAID:register:${user.walletAddress}:${trimmedName}:${timestamp}`;

    // Sign the message with the user's Privy wallet
    const signature = await signMessage(user.privyWalletId, registrationMessage);

    console.log(`[butler] Signed registration message for ${externalId}`);

    // Call sponsored registration — this does ACTUAL on-chain registration
    // The sponsor wallet pays the rent, user's wallet signs the message
    const sponsoredRes = await fetch(`${SAID_API}/api/register/sponsored`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: user.walletAddress,
        name: trimmedName,
        description: `${trimmedName} — SAID Butler agent for ${user.platform}`,
        signature,
        timestamp,
        capabilities: ['messaging', 'assistant'],
        source: 'butler',
      }),
    });

    const sponsoredData = await sponsoredRes.json() as any;

    if (!sponsoredRes.ok || !sponsoredData.success) {
      // Fall back to pending registration if sponsored fails
      console.warn(`[butler] Sponsored registration failed for ${externalId}: ${sponsoredData.error || sponsoredRes.status}`);
      console.warn(`[butler] Falling back to pending registration`);

      const pendingRes = await fetch(`${SAID_API}/api/register/pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: user.walletAddress,
          name: trimmedName,
          description: `${trimmedName} — SAID Butler agent for ${user.platform}`,
          capabilities: ['messaging', 'assistant'],
          source: 'butler',
        }),
      });

      const pendingData = await pendingRes.json() as any;

      const updated = await prisma.butlerUser.update({
        where: { externalId },
        data: {
          displayName: trimmedName,
          saidPda: pendingData.pda || null,
          saidRegistered: true,
        },
      });

      res.json({
        success: true,
        saidPda: updated.saidPda,
        walletAddress: user.walletAddress,
        displayName: trimmedName,
        status: 'PENDING',
        profile: pendingData.profile,
        onChain: false,
      });
      return;
    }

    // Sponsored registration succeeded — agent is ON-CHAIN
    const updated = await prisma.butlerUser.update({
      where: { externalId },
      data: {
        displayName: trimmedName,
        saidPda: sponsoredData.pda,
        saidRegistered: true,
      },
    });

    console.log(`[butler] Registered SAID ON-CHAIN for ${externalId}: PDA=${updated.saidPda}`);

    res.json({
      success: true,
      saidPda: updated.saidPda,
      walletAddress: user.walletAddress,
      displayName: trimmedName,
      status: 'REGISTERED',
      profile: sponsoredData.profile,
      badge: sponsoredData.badge,
      onChain: true,
    });
  } catch (error) {
    console.error('[butler] Register SAID error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
  }
});

/**
 * Check if a butler user exists
 *
 * GET /api/butler/user/:externalId
 * Returns: user record or 404
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
 * List all butler users (admin/stats)
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
