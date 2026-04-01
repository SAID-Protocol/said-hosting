import { Router } from 'express';
import { getBillingInfo, getMonthlyPrice, getWalletUsdcBalance, startTrial, PRICING, buildWithdrawalTransaction, recordPayment, processManualPayment } from '../services/billing';
import { chargeWallet } from '../services/privy-billing';
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

/**
 * POST /api/billing/withdraw — Withdraw USDC from embedded wallet to external address
 */
billingRouter.post('/withdraw', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const { toAddress, amount } = req.body;
    
    // Validate inputs
    if (!toAddress || typeof toAddress !== 'string') {
      res.status(400).json({ error: 'toAddress is required' });
      return;
    }
    
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }
    
    // Minimum withdrawal $1 (prevent spam)
    if (amount < 1) {
      res.status(400).json({ error: 'Minimum withdrawal is $1 USDC' });
      return;
    }
    
    // Get user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { privyId: true, privyWalletAddress: true },
    });
    
    if (!user?.privyId || !user?.privyWalletAddress) {
      res.status(400).json({ error: 'User wallet not found' });
      return;
    }
    
    // Check balance
    const balance = await getWalletUsdcBalance(user.privyWalletAddress);
    if (balance < amount) {
      res.status(400).json({ error: `Insufficient balance. You have $${balance.toFixed(2)} USDC.` });
      return;
    }
    
    // Validate Solana address
    try {
      // This will throw if invalid
      new (await import('@solana/web3.js')).PublicKey(toAddress);
    } catch {
      res.status(400).json({ error: 'Invalid Solana address' });
      return;
    }
    
    // Execute withdrawal via Privy server-side signer
    const { signAndSubmitWithdrawalTx } = await import('../services/privy-billing');
    const txSignature = await signAndSubmitWithdrawalTx(user.privyId, toAddress, amount);
    
    if (!txSignature) {
      res.status(500).json({ error: 'Withdrawal transaction failed. Please try again.' });
      return;
    }
    
    // Record withdrawal
    await recordPayment(
      userId,
      null, // Not tied to a specific agent
      amount,
      'USDC',
      amount, // 1:1
      txSignature,
      'completed',
      'withdrawal',
    );
    
    res.json({
      success: true,
      txSignature,
      amount,
      toAddress,
    });
  } catch (error) {
    console.error('[billing/withdraw] Error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Withdrawal failed' });
  }
});

/**
 * POST /api/billing/pay — Process manual subscription payment
 * User initiates payment via Privy, sends tx signature to confirm
 */
billingRouter.post('/pay', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const { txSignature } = req.body;
    
    if (!txSignature || typeof txSignature !== 'string') {
      res.status(400).json({ error: 'txSignature is required' });
      return;
    }
    
    // Process the payment and update billing status
    await processManualPayment(userId, txSignature);
    
    res.json({
      success: true,
      message: 'Payment processed successfully',
      txSignature,
    });
  } catch (error) {
    console.error('[billing/pay] Error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Payment processing failed' });
  }
});

/**
 * POST /api/billing/test-charge — Test server-side wallet charge (admin only)
 */
billingRouter.post('/test-charge', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { walletId, walletAddress, amount } = req.body;
    if (!walletId || !walletAddress || !amount) {
      res.status(400).json({ error: 'walletId, walletAddress, and amount are required' });
      return;
    }

    console.log(`[billing/test-charge] Testing charge of $${amount} from ${walletId}`);
    const hash = await chargeWallet(walletId, walletAddress, amount);

    if (hash) {
      res.json({ success: true, hash });
    } else {
      res.status(500).json({ error: 'Charge failed — check server logs' });
    }
  } catch (error) {
    console.error('[billing/test-charge] Error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Test charge failed' });
  }
});
