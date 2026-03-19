import { Router } from 'express';
import { getBillingInfo, getMonthlyPrice, getWalletUsdcBalance, startTrial, PRICING } from '../services/billing';
import { prisma } from '../db';

export const billingRouter = Router();

/**
 * GET /api/billing — Get billing info for the authenticated user
 */
billingRouter.get('/', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const info = await getBillingInfo(userId);
    
    if (!info) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch billing info' });
  }
});

/**
 * GET /api/billing/balance — Quick wallet balance check
 */
billingRouter.get('/balance', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { privyWalletAddress: true },
    });
    
    if (!user?.privyWalletAddress) {
      res.json({ balance: 0, walletAddress: null });
      return;
    }
    
    const balance = await getWalletUsdcBalance(user.privyWalletAddress);
    res.json({ balance, walletAddress: user.privyWalletAddress });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch balance' });
  }
});

/**
 * POST /api/billing/start-trial — Start a 3-day trial
 */
billingRouter.post('/start-trial', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const { tier, billingMode } = req.body;
    
    if (!tier || !['starter', 'pro', 'power'].includes(tier)) {
      res.status(400).json({ error: 'Invalid tier. Must be starter, pro, or power.' });
      return;
    }
    
    // Check if user already had a trial
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.billingStatus && user.billingStatus !== 'none') {
      res.status(400).json({ error: 'Trial already used or subscription active.' });
      return;
    }
    
    const updated = await startTrial(userId, tier, billingMode || 'all_inclusive');
    res.json({
      billingStatus: updated.billingStatus,
      tier: updated.tier,
      trialEndsAt: updated.trialEndsAt,
      monthlyAmount: updated.monthlyAmountUsd,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start trial' });
  }
});

/**
 * POST /api/billing/update-tier — Change tier or billing mode
 */
billingRouter.post('/update-tier', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const { tier, billingMode } = req.body;
    
    if (!tier || !['starter', 'pro', 'power'].includes(tier)) {
      res.status(400).json({ error: 'Invalid tier.' });
      return;
    }
    
    const mode = billingMode === 'byok' ? 'byok' : 'all_inclusive';
    const monthlyAmount = getMonthlyPrice(tier, mode);
    
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        tier,
        billingMode: mode,
        monthlyAmountUsd: monthlyAmount,
      },
    });
    
    res.json({
      tier: updated.tier,
      billingMode: updated.billingMode,
      monthlyAmount: updated.monthlyAmountUsd,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update tier' });
  }
});

/**
 * POST /api/billing/set-wallet — Store user's Privy wallet address
 * Called by frontend after wallet is created
 */
billingRouter.post('/set-wallet', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const { walletAddress } = req.body;
    
    if (!walletAddress || typeof walletAddress !== 'string') {
      res.status(400).json({ error: 'walletAddress is required' });
      return;
    }
    
    await prisma.user.update({
      where: { id: userId },
      data: { privyWalletAddress: walletAddress },
    });
    
    res.json({ success: true, walletAddress });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to set wallet' });
  }
});

/**
 * GET /api/billing/pricing — Public pricing info
 */
billingRouter.get('/pricing', (_req, res) => {
  res.json(PRICING);
});

/**
 * GET /api/billing/payments — Payment history for authenticated user
 */
/**
 * GET /api/billing/signer-status — Check if user has consented to server-side signing
 */
billingRouter.get('/signer-status', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { signerConsented: true } });
    res.json({ consented: user?.signerConsented ?? false });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check signer status' });
  }
});

/**
 * POST /api/billing/signer-consented — Mark that user has granted addSigners consent
 */
billingRouter.post('/signer-consented', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    await prisma.user.update({ where: { id: userId }, data: { signerConsented: true } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update signer consent' });
  }
});

billingRouter.get('/payments', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    
    const payments = await prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch payments' });
  }
});
