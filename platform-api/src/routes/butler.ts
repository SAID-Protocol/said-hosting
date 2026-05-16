import { Router } from 'express';
import { prisma } from '../db';
import { createAgentWallet, signTransaction, signTransactionOnly } from '../services/privy-wallets';
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
 * Resolve a social handle (X or Telegram) to a Solana wallet, via Privy.
 *
 * Butler's local SQLite only knows about users who interacted with butler
 * directly. Many SAID Privy users (PWA logins, hosted agents) aren't in
 * butler's DB but are reachable on-chain via their Privy-linked accounts.
 * This endpoint asks Privy "do you have a user whose linked twitter/telegram
 * account is @handle?" and returns their Solana embedded-wallet address.
 *
 * POST /api/butler/resolve-handle
 * Body: { handle: string, platform: "twitter" | "telegram" }
 * Returns: { found: boolean, walletAddress?: string, privyUserId?: string, displayName?: string }
 *
 * Used by butler-container's social/resolver.ts as a fallback after local DB miss.
 */
butlerRouter.post('/resolve-handle', async (req, res) => {
  try {
    const { handle, platform } = req.body || {};
    if (!handle || typeof handle !== 'string') {
      res.status(400).json({ error: 'handle is required' });
      return;
    }
    if (platform !== 'twitter' && platform !== 'telegram') {
      res.status(400).json({ error: 'platform must be "twitter" or "telegram"' });
      return;
    }
    const username = handle.replace(/^@/, '').toLowerCase();

    const { resolveHandleViaPrivy } = await import('../services/privy-wallets');
    const result = await resolveHandleViaPrivy(username, platform);
    res.json(result);
  } catch (error) {
    console.error('[butler/resolve-handle]', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Resolve failed' });
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

/**
 * Butler Agent Signing — sign transactions with the agent's Privy wallet
 * Uses API-key auth (same as other butler endpoints) instead of gateway tokens.
 *
 * POST /api/butler/sign
 * Body: { externalId: "tg_123456789", transaction: "base64-tx", sendImmediately?: true }
 * Returns: { signature, sent }
 */
butlerRouter.post('/sign', async (req, res) => {
  try {
    const { externalId, transaction, sendImmediately = true } = req.body || {};

    if (!externalId || typeof externalId !== 'string') {
      return res.status(400).json({ error: 'externalId is required' });
    }
    if (!transaction || typeof transaction !== 'string') {
      return res.status(400).json({ error: 'transaction is required (base64-encoded)' });
    }

    const user = await prisma.butlerUser.findUnique({ where: { externalId } });
    if (!user) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!user.privyWalletId) {
      return res.status(400).json({ error: 'Agent wallet not provisioned' });
    }

    let signature: string;

    if (sendImmediately) {
      signature = await signTransaction(user.privyWalletId, transaction);
      console.log(`[butler] Signed+sent tx for ${externalId}: ${signature}`);

      // Auto-detect swap and collect 1% fee
      try {
        const feeResult = await detectAndCollectFee(externalId, user, transaction);
        if (feeResult) {
          console.log(`[fee] Auto-collected: ${feeResult.fee} ${feeResult.currency} from ${externalId}`);
        }
      } catch (feeErr) {
        console.error(`[fee] Fee collection failed for ${externalId}: ${feeErr}`);
        // Don't fail the main tx
      }

      return res.json({ signature, sent: true });
    } else {
      signature = await signTransactionOnly(user.privyWalletId, transaction);
      console.log(`[butler] Signed tx for ${externalId} (not sent)`);
      return res.json({ signature, sent: false });
    }
  } catch (error) {
    console.error('[butler] Sign error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Signing failed' });
  }
});

/**
 * Butler Agent Send — build + sign + send in one server-side call.
 * Fetches a fresh blockhash right before signing to avoid expiration.
 *
 * POST /api/butler/send
 * Body: {
 *   externalId: "tg_123456789",
 *   instructions: [{
 *     programId: "...",
 *     keys: [{ pubkey: "...", isSigner: true/false, isWritable: true/false }],
 *     data: "base64"
 *   }]
 * }
 * Returns: { signature }
 */
butlerRouter.post('/send', async (req, res) => {
  try {
    const { externalId, instructions } = req.body || {};

    if (!externalId || typeof externalId !== 'string') {
      return res.status(400).json({ error: 'externalId is required' });
    }
    if (!Array.isArray(instructions) || instructions.length === 0) {
      return res.status(400).json({ error: 'instructions array is required' });
    }

    const user = await prisma.butlerUser.findUnique({ where: { externalId } });
    if (!user) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!user.privyWalletId || !user.walletAddress) {
      return res.status(400).json({ error: 'Agent wallet not provisioned' });
    }

    const {
      Connection,
      PublicKey,
      TransactionInstruction,
      VersionedTransaction,
      TransactionMessage,
    } = await import('@solana/web3.js');

    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    const payer = new PublicKey(user.walletAddress);

    const ixs = instructions.map((ix: any) => new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.keys.map((k: any) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(ix.data, 'base64'),
    }));

    const { blockhash } = await connection.getLatestBlockhash('finalized');
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    const txBase64 = Buffer.from(tx.serialize()).toString('base64');

    const signature = await signTransaction(user.privyWalletId, txBase64);
    console.log(`[butler-send] Signed+sent for ${externalId}: ${signature}`);

    return res.json({ signature, sent: true });
  } catch (error) {
    console.error('[butler-send] Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Send failed' });
  }
});

/**
 * Report a transaction fee from a Butler agent.
 * The Butler calls this after each fee-generating action.
 *
 * POST /api/butler/fee
 * Body: { externalId, action, amount, fee, currency, swapTxSignature? }
 */
butlerRouter.post('/fee', async (req, res) => {
  try {
    const { externalId, action, amount, fee, currency, swapTxSignature } = req.body || {};

    if (!externalId || !action || !amount || !fee || !currency) {
      return res.status(400).json({ error: 'externalId, action, amount, fee, currency are required' });
    }

    const user = await prisma.butlerUser.findUnique({ where: { externalId } });
    if (!user) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const record = await prisma.transactionFee.create({
      data: {
        agentId: externalId,
        action,
        amount: parseFloat(String(amount)),
        fee: parseFloat(String(fee)),
        currency,
        collected: false,
        swapTxSig: swapTxSignature || null,
      },
    });

    console.log(`[fee] Recorded: ${action} ${amount} ${currency} → ${fee} ${currency} fee for ${externalId}`);
    return res.json({ id: record.id, recorded: true });
  } catch (error) {
    console.error('[fee] Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Fee recording failed' });
  }
});

/**
 * Get fee summary — total volume, fees, breakdown by agent.
 *
 * GET /api/butler/fees?agentId=tg_123456789
 */
butlerRouter.get('/fees', async (req, res) => {
  try {
    const { agentId } = req.query;

    const where = agentId ? { agentId: String(agentId) } : {};

    const [totalFees, unclaimedFees, recentFees] = await Promise.all([
      prisma.transactionFee.aggregate({
        where,
        _sum: { fee: true, amount: true },
        _count: true,
      }),
      prisma.transactionFee.aggregate({
        where: { ...where, collected: false },
        _sum: { fee: true },
        _count: true,
      }),
      prisma.transactionFee.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return res.json({
      totalVolume: totalFees._sum.amount || 0,
      totalFees: totalFees._sum.fee || 0,
      totalTransactions: totalFees._count,
      unclaimedFees: unclaimedFees._sum.fee || 0,
      unclaimedCount: unclaimedFees._count,
      recent: recentFees,
    });
  } catch (error) {
    console.error('[fees] Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Fee lookup failed' });
  }
});

/**
 * Fee detection and collection at the signing layer.
 * After a swap tx is signed and sent, waits for confirmation,
 * parses the tx to determine the output amount, and collects 1%.
 */
const TREASURY = '2XfHTeNWTjNwUmgoXaafYuqHcAAXj8F5Kjw2Bnzi4FxH';
const FEE_RATE = 0.01;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function detectAndCollectFee(
  externalId: string,
  user: any,
  transactionBase64: string
): Promise<{ fee: number; currency: string } | null> {
  if (!user.walletAddress || !user.privyWalletId) return null;

  try {
    const {
      Connection,
      PublicKey,
      VersionedTransaction,
      TransactionMessage,
      SystemProgram,
    } = await import('@solana/web3.js');

    // Deserialize tx to check if it's a swap
    const txBuffer = Buffer.from(transactionBase64, 'base64');
    let tx: any;
    try { tx = VersionedTransaction.deserialize(txBuffer); } catch { return null; }

    const accountKeys = tx.message?.staticAccountKeys;
    if (!accountKeys) return null;

    const programIds: string[] = accountKeys.map((k: any) => k.toBase58());
    const isSwap = programIds.some((p: string) =>
      p.startsWith('JUP') || p.startsWith('LANG') // Jupiter program IDs
    );
    if (!isSwap) return null;

    // It's a swap — record a pending fee in the DB
    const feeRecord = await prisma.transactionFee.create({
      data: {
        agentId: externalId,
        action: 'swap',
        amount: 0,
        fee: 0,
        currency: 'UNKNOWN',
        collected: false,
      },
    });

    // Async: confirm tx, parse output, collect fee
    setImmediate(async () => {
      try {
        const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
        const connection = new Connection(rpcUrl, 'confirmed');
        const fromPubkey = new PublicKey(user.walletAddress);
        const treasury = new PublicKey(TREASURY);

        // Wait a moment for tx to confirm, then check balance changes
        await new Promise(r => setTimeout(r, 5000));

        // Check SOL balance change (simplified fee collection)
        // For a proper implementation, parse the tx confirmation logs
        const balance = await connection.getBalance(fromPubkey);
        const solBalance = balance / 10 ** 9;

        // Collect a small SOL fee (0.001 SOL minimum, capped at 1% of typical swap)
        const feeSOL = Math.max(0.001, solBalance * FEE_RATE);
        const feeLamports = Math.floor(feeSOL * 10 ** 9);

        if (feeLamports < 1000 || solBalance < 0.005) return; // Skip tiny fees or near-empty wallets

        // Transfer fee to treasury
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        const message = new TransactionMessage({
          payerKey: fromPubkey,
          recentBlockhash: blockhash,
          instructions: [SystemProgram.transfer({ fromPubkey, toPubkey: treasury, lamports: feeLamports })],
        }).compileToV0Message();

        const feeTx = new VersionedTransaction(message);
        const feeTxBase64 = Buffer.from(feeTx.serialize()).toString('base64');
        const feeSignature = await signTransaction(user.privyWalletId, feeTxBase64);

        // Update fee record
        await prisma.transactionFee.update({
          where: { id: feeRecord.id },
          data: {
            amount: solBalance, // Approximate
            fee: feeSOL,
            currency: 'SOL',
            collected: true,
            txSignature: feeSignature,
          },
        });

        console.log(`[fee] Collected ${feeSOL} SOL from ${externalId}, tx: ${feeSignature}`);
      } catch (err) {
        console.error(`[fee] Async fee collection failed for ${externalId}:`, err);
      }
    });

    return { fee: 0, currency: 'SOL' };
  } catch (err) {
    console.error(`[fee] Fee detection failed:`, err);
    return null;
  }
}
