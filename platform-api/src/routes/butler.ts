import { Router } from 'express';
import { prisma } from '../db';
import { createAgentWallet, signTransaction as privySign } from '../services/privy-wallets';
import { registerHostedAgent, confirmHostedAgent } from '../services/said';

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

    // Update display name
    await prisma.butlerUser.update({
      where: { externalId },
      data: { displayName: displayName.trim() },
    });

    // Get unsigned registration tx from Protocol API
    const registration = await registerHostedAgent({
      wallet: user.walletAddress,
      name: displayName.trim(),
      description: `Butler-provisioned agent for ${user.platform} user ${externalId}`,
      capabilities: ['messaging'],
    });

    if (!registration.success || !registration.unsignedTransaction) {
      res.status(500).json({ error: registration.error || 'SAID registration failed' });
      return;
    }

    // Sign with Privy wallet AND send the transaction immediately
    const signature = await privySign(user.privyWalletId, registration.unsignedTransaction);

    // Privy's signAndSendTransaction returns the tx signature
    // We need to confirm on-chain status via the Protocol API
    const confirmation = await confirmHostedAgent({
      signedTransaction: signature,
      wallet: user.walletAddress,
      name: displayName.trim(),
      description: `Butler-provisioned agent for ${user.platform} user ${externalId}`,
      capabilities: ['messaging'],
    });

    if (!confirmation.success) {
      res.status(500).json({ error: confirmation.error || 'SAID confirmation failed' });
      return;
    }

    // Update DB with confirmed registration
    const updated = await prisma.butlerUser.update({
      where: { externalId },
      data: {
        saidPda: confirmation.saidPda || registration.pda,
        saidRegistered: true,
        registrationTx: null,
      },
    });

    console.log(`[butler] Registered SAID for ${externalId}: PDA=${updated.saidPda}`);

    res.json({
      success: true,
      saidPda: updated.saidPda,
      walletAddress: user.walletAddress,
      displayName: displayName.trim(),
      signature: confirmation.signature,
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
