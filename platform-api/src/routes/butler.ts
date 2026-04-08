import { Router } from 'express';
import { prisma } from '../db';
import { createAgentWallet, signMessage, signTransaction } from '../services/privy-wallets';

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
    const SAID_PLATFORM_KEY = process.env.SAID_HOSTING_API_KEY || '';
    const trimmedName = displayName.trim();

    // Phase 1: Get unsigned transaction from said-hosting platform endpoint
    const registerRes = await fetch(`${SAID_API}/api/platforms/said-hosting/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Platform-Key': SAID_PLATFORM_KEY,
      },
      body: JSON.stringify({
        wallet: user.walletAddress,
        name: trimmedName,
        description: `${trimmedName} — SAID Butler agent for ${user.platform}`,
        capabilities: ['messaging', 'assistant'],
      }),
    });

    const registerData = await registerRes.json() as any;

    // The register endpoint returns { transaction } not { unsignedTransaction }
    const unsignedTx = registerData.unsignedTransaction || registerData.transaction;

    if (!registerRes.ok || !registerData.success || !unsignedTx) {
      console.error(`[butler] Protocol API register failed:`, JSON.stringify(registerData));
      res.status(500).json({ error: registerData.error || registerData.message || 'SAID registration failed' });
      return;
    }

    console.log(`[butler] Got unsigned registration tx for ${externalId}, PDA=${registerData.pda}, signing immediately...`);

    // Phase 2: Sign and broadcast with Privy wallet IMMEDIATELY
    // signTransaction uses signAndSendTransaction, so it broadcasts automatically
    let txSignature: string;
    try {
      txSignature = await signTransaction(user.privyWalletId, unsignedTx);
    } catch (signError: any) {
      console.error(`[butler] Privy sign+send failed for ${externalId}:`, signError.message || signError);
      res.status(500).json({ error: `Transaction signing failed: ${signError.message || 'unknown error'}` });
      return;
    }

    console.log(`[butler] Registered ON-CHAIN for ${externalId}: tx=${txSignature}, PDA=${registerData.pda}`);

    // Update DB
    const updated = await prisma.butlerUser.update({
      where: { externalId },
      data: {
        displayName: trimmedName,
        saidPda: registerData.pda,
        saidRegistered: true,
        saidVerified: true, // The tx includes both register + verify
      },
    });

    res.json({
      success: true,
      saidPda: updated.saidPda,
      walletAddress: user.walletAddress,
      displayName: trimmedName,
      status: 'VERIFIED',
      profile: registerData.profile || `https://www.saidprotocol.com/agent.html?wallet=${user.walletAddress}`,
      badge: `https://api.saidprotocol.com/api/badge/${user.walletAddress}.svg`,
      onChain: true,
      txSignature,
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
