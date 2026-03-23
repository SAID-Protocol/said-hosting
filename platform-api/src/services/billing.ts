/**
 * SAID Host — Billing Service
 * 
 * Handles subscription billing via Privy embedded wallets.
 * Users deposit USDC → we deduct monthly via server-side signer.
 * 
 * Flow:
 * 1. User signs up → Privy creates embedded Solana wallet
 * 2. User adds funds (Apple Pay / Google Pay / external wallet)
 * 3. Frontend calls addSigners() to authorize our server
 * 4. Daily cron checks billing dates and deducts from wallet
 */

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { prisma } from '../db';

// USDC on Solana mainnet
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
// Our treasury wallet that receives subscription payments
const TREASURY_WALLET = new PublicKey(process.env.BILLING_TREASURY_WALLET || 'HUpEuDs3FC4T3xMZ3n8EGe16QLJFSnjbd1Kzh6C22YyP');

if (!process.env.SOLANA_RPC_URL) throw new Error('SOLANA_RPC_URL environment variable is required');
const RPC_URL: string = process.env.SOLANA_RPC_URL;

// Pricing in USD (monthly)
export const PRICING = {
  all_inclusive: {
    starter: 29,
    pro: 79,
    power: 199,
  },
  byok: {
    starter: 14,
    pro: 39,
    power: 99,
  },
} as const;

// Trial duration
const TRIAL_DAYS = 3;
// Grace period after failed payment
const GRACE_DAYS = 3;
// Days before data deletion after pause
const DELETION_DAYS = 30;

/**
 * Get the monthly price for a user based on tier and billing mode
 */
export function getMonthlyPrice(tier: string, billingMode: string): number {
  const mode = billingMode === 'byok' ? 'byok' : 'all_inclusive';
  const tierKey = tier as keyof typeof PRICING.all_inclusive;
  return PRICING[mode][tierKey] || PRICING[mode].starter;
}

/**
 * Start a trial for a new user
 */
export async function startTrial(userId: string, tier: string, billingMode: string = 'all_inclusive') {
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);
  
  const monthlyAmount = getMonthlyPrice(tier, billingMode);

  return prisma.user.update({
    where: { id: userId },
    data: {
      tier,
      billingStatus: 'trial',
      billingMode,
      trialEndsAt,
      monthlyAmountUsd: monthlyAmount,
    },
  });
}

/**
 * Get USDC balance for a wallet address
 */
export async function getWalletUsdcBalance(walletAddress: string): Promise<number> {
  try {
    const connection = new Connection(RPC_URL);
    const wallet = new PublicKey(walletAddress);
    const ata = await getAssociatedTokenAddress(USDC_MINT, wallet);
    
    const balance = await connection.getTokenAccountBalance(ata);
    // USDC has 6 decimals
    return Number(balance.value.uiAmount || 0);
  } catch (error) {
    // Token account might not exist yet (no USDC deposited)
    return 0;
  }
}

/**
 * Get SOL balance for a wallet address
 */
export async function getWalletSolBalance(walletAddress: string): Promise<number> {
  try {
    const connection = new Connection(RPC_URL);
    const wallet = new PublicKey(walletAddress);
    const balance = await connection.getBalance(wallet);
    // Convert lamports to SOL (1 SOL = 1,000,000,000 lamports)
    return balance / 1_000_000_000;
  } catch (error) {
    console.error('Failed to get SOL balance:', error);
    return 0;
  }
}

/**
 * Build a USDC transfer transaction (to be signed by Privy signer)
 */
export async function buildBillingTransaction(
  fromWallet: string,
  amountUsd: number,
): Promise<{ transaction: string; amountUsdc: number }> {
  const connection = new Connection(RPC_URL);
  const from = new PublicKey(fromWallet);
  
  // USDC amount = USD amount (1:1 stablecoin)
  const amountUsdc = amountUsd;
  const amountLamports = Math.round(amountUsdc * 1_000_000); // 6 decimals
  
  const fromAta = await getAssociatedTokenAddress(USDC_MINT, from);
  const toAta = await getAssociatedTokenAddress(USDC_MINT, TREASURY_WALLET);
  
  const transaction = new Transaction().add(
    createTransferInstruction(
      fromAta,
      toAta,
      from,
      amountLamports,
      [],
      TOKEN_PROGRAM_ID,
    )
  );
  
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = from;
  
  // Serialize for Privy to sign
  const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
  
  return { transaction: serialized, amountUsdc };
}

/**
 * Record a payment
 */
export async function recordPayment(
  userId: string,
  agentId: string | null,
  amountUsd: number,
  token: string,
  tokenAmount: number,
  txSignature: string | null,
  status: string,
  type: string,
) {
  return prisma.payment.create({
    data: {
      userId,
      agentId,
      amountUsd: amountUsd,
      token,
      tokenAmount,
      txSignature,
      status,
      type,
    },
  });
}

/**
 * Process billing for a single user
 * Returns: 'paid' | 'insufficient' | 'grace' | 'paused' | 'error'
 */
export async function processUserBilling(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { agents: true },
  });
  
  if (!user || !user.privyWalletAddress) {
    return 'error';
  }
  
  // Calculate total amount due based on all active agents (per-agent billing)
  const activeAgents = user.agents.filter(a => a.status === 'running' || a.status === 'paused');
  
  if (activeAgents.length === 0) {
    console.log(`[billing] User ${userId} has no active agents - skipping billing`);
    return 'paid'; // No agents = no charges
  }
  
  const amountDue = activeAgents.reduce((total, agent) => {
    return total + getMonthlyPrice(agent.tier, user.billingMode);
  }, 0);
  
  console.log(`[billing] User ${userId} has ${activeAgents.length} agents - total due: $${amountDue}`);
  
  // Check USDC balance
  const balance = await getWalletUsdcBalance(user.privyWalletAddress);
  
  if (balance >= amountDue) {
    try {
      // Build and sign the transaction via Privy
      const amountUsdc = amountDue; // USDC is 1:1 with USD
      
      // Sign and submit via Privy server-side signing
      let txSignature: string | null = null;
      if (user.privyId) {
        const { signAndSubmitBillingTx } = await import('./privy-billing');
        txSignature = await signAndSubmitBillingTx(user.privyId, amountDue);
      }
      
      if (!txSignature) {
        console.error(`[billing] Failed to submit billing tx for user ${userId}`);
        // Don't enter grace yet — might be a temporary issue. Retry next cron run.
        return 'error';
      }
      
      // Update billing status
      const nextBilling = new Date();
      nextBilling.setDate(nextBilling.getDate() + 30);
      
      await prisma.user.update({
        where: { id: userId },
        data: {
          billingStatus: 'active',
          nextBillingDate: nextBilling,
          lastPaymentAt: new Date(),
          lastPaymentTx: txSignature,
          graceStartedAt: null,
        },
      });
      
      // Record payment
      await recordPayment(
        userId,
        user.agents[0]?.id || null,
        amountDue,
        'USDC',
        amountUsdc,
        txSignature,
        'success',
        'subscription',
      );
      
      return 'paid';
    } catch (error) {
      console.error(`[billing] Failed to process payment for user ${userId}:`, error);
      return 'error';
    }
  } else {
    // Insufficient balance
    if (user.billingStatus === 'grace') {
      // Check if grace period expired
      if (user.graceStartedAt) {
        const graceEnd = new Date(user.graceStartedAt);
        graceEnd.setDate(graceEnd.getDate() + GRACE_DAYS);
        
        if (new Date() > graceEnd) {
          // Grace period expired → pause all agents
          for (const agent of user.agents) {
            if (agent.status === 'running') {
              try {
                // Import dynamically to avoid circular deps
                const { stopAgent } = await import('./agent');
                await stopAgent(userId, agent.id);
              } catch (e) {
                console.error(`[billing] Failed to stop agent ${agent.id}:`, e);
              }
            }
          }
          
          await prisma.user.update({
            where: { id: userId },
            data: { billingStatus: 'paused' },
          });
          
          return 'paused';
        }
      }
      return 'grace';
    } else {
      // Start grace period
      await prisma.user.update({
        where: { id: userId },
        data: {
          billingStatus: 'grace',
          graceStartedAt: new Date(),
        },
      });
      
      // Record failed payment attempt
      await recordPayment(
        userId,
        user.agents[0]?.id || null,
        amountDue,
        'USDC',
        0,
        null,
        'failed',
        'subscription',
      );
      
      return 'insufficient';
    }
  }
}

/**
 * Daily billing cron — checks all users due for billing
 */
export async function runBillingCron() {
  console.log('[billing] Running daily billing check...');
  
  const now = new Date();
  
  // 1. Check trial expirations
  const expiredTrials = await prisma.user.findMany({
    where: {
      billingStatus: 'trial',
      trialEndsAt: { lte: now },
    },
    include: { agents: true },
  });
  
  for (const user of expiredTrials) {
    console.log(`[billing] Trial expired for user ${user.id}`);
    const result = await processUserBilling(user.id);
    console.log(`[billing] Trial conversion result for ${user.id}: ${result}`);
  }
  
  // 2. Check active subscriptions due for renewal
  const dueForRenewal = await prisma.user.findMany({
    where: {
      billingStatus: 'active',
      nextBillingDate: { lte: now },
    },
  });
  
  for (const user of dueForRenewal) {
    console.log(`[billing] Processing renewal for user ${user.id}`);
    const result = await processUserBilling(user.id);
    console.log(`[billing] Renewal result for ${user.id}: ${result}`);
  }
  
  // 3. Check grace period users (might have added funds)
  const graceUsers = await prisma.user.findMany({
    where: { billingStatus: 'grace' },
  });
  
  for (const user of graceUsers) {
    const result = await processUserBilling(user.id);
    console.log(`[billing] Grace check for ${user.id}: ${result}`);
  }
  
  // 4. Check for deletion (paused > 30 days)
  const deletionThreshold = new Date();
  deletionThreshold.setDate(deletionThreshold.getDate() - DELETION_DAYS);
  
  const pausedTooLong = await prisma.user.findMany({
    where: {
      billingStatus: 'paused',
      graceStartedAt: { lte: deletionThreshold },
    },
    include: { agents: true },
  });
  
  for (const user of pausedTooLong) {
    console.log(`[billing] DELETION: User ${user.id} paused for 30+ days — deleting agents`);
    for (const agent of user.agents) {
      try {
        const { deleteAgent } = await import('./agent');
        await deleteAgent(user.id, agent.id);
      } catch (e) {
        console.error(`[billing] Failed to delete agent ${agent.id}:`, e);
      }
    }
    
    await prisma.user.update({
      where: { id: user.id },
      data: { billingStatus: 'cancelled' },
    });
  }
  
  console.log('[billing] Daily billing check complete.');
}

/**
 * Check if user has a payment due (manual billing)
 */
export function isPaymentDue(user: { nextBillingDate: Date | null; billingStatus: string }): boolean {
  if (!user.nextBillingDate) return false;
  if (user.billingStatus === 'none' || user.billingStatus === 'cancelled') return false;
  
  const now = new Date();
  return now >= user.nextBillingDate;
}

/**
 * Check if user is in grace period (payment overdue but agent still works)
 */
export function isInGracePeriod(user: { nextBillingDate: Date | null; billingStatus: string }): boolean {
  if (!isPaymentDue(user)) return false;
  
  const now = new Date();
  const gracePeriodEnd = new Date(user.nextBillingDate!);
  gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 3); // 3-day grace period
  
  return now < gracePeriodEnd;
}

/**
 * Check if user's agent should be paused (payment overdue + grace period expired)
 */
export function shouldPauseAgent(user: { nextBillingDate: Date | null; billingStatus: string }): boolean {
  if (!isPaymentDue(user)) return false;
  return !isInGracePeriod(user);
}

/**
 * Get billing info for dashboard display
 */
export async function getBillingInfo(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      tier: true,
      billingStatus: true,
      billingMode: true,
      trialEndsAt: true,
      nextBillingDate: true,
      lastPaymentAt: true,
      monthlyAmountUsd: true,
      privyWalletAddress: true,
      paymentToken: true,
    },
  });
  
  if (!user) return null;
  
  let walletBalance = 0;
  let solBalance = 0;
  if (user.privyWalletAddress) {
    walletBalance = await getWalletUsdcBalance(user.privyWalletAddress);
    solBalance = await getWalletSolBalance(user.privyWalletAddress);
  }
  
  // Get recent payments
  const recentPayments = await prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  
  // Calculate payment status
  const paymentDue = isPaymentDue(user);
  const inGracePeriod = isInGracePeriod(user);
  const agentPaused = shouldPauseAgent(user);
  
  // Calculate days until payment/grace period ends
  let daysUntilDue = 0;
  let daysUntilPause = 0;
  
  if (user.nextBillingDate) {
    const now = new Date();
    const nextBilling = new Date(user.nextBillingDate);
    
    if (!paymentDue) {
      // Days until payment is due
      daysUntilDue = Math.ceil((nextBilling.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    } else if (inGracePeriod) {
      // Days until grace period ends (agent pauses)
      const gracePeriodEnd = new Date(nextBilling);
      gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 3);
      daysUntilPause = Math.ceil((gracePeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  
  return {
    ...user,
    walletBalance,
    solBalance,
    recentPayments,
    paymentDue,
    inGracePeriod,
    agentPaused,
    daysUntilDue,
    daysUntilPause,
  };
}

/**
 * Build a USDC withdrawal transaction (user → external address)
 * Uses server-side signer to transfer from user's Privy wallet
 */
export async function buildWithdrawalTransaction(
  fromWallet: string,
  toWallet: string,
  amountUsd: number,
): Promise<{ transaction: string; amountUsdc: number }> {
  const connection = new Connection(RPC_URL);
  const from = new PublicKey(fromWallet);
  const to = new PublicKey(toWallet);
  
  // USDC amount = USD amount (1:1 stablecoin)
  const amountUsdc = amountUsd;
  const amountLamports = Math.round(amountUsdc * 1_000_000); // 6 decimals
  
  const fromAta = await getAssociatedTokenAddress(USDC_MINT, from);
  const toAta = await getAssociatedTokenAddress(USDC_MINT, to);
  
  const transaction = new Transaction().add(
    createTransferInstruction(
      fromAta,
      toAta,
      from,
      amountLamports,
      [],
      TOKEN_PROGRAM_ID,
    )
  );
  
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = from;
  
  // Serialize for Privy to sign
  const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
  
  return { transaction: serialized, amountUsdc };
}

/**
 * Rotate API keys for all user's agents (fresh monthly credits)
 * Called after successful subscription payment
 */
async function rotateAgentKeys(userId: string, tier: string): Promise<void> {
  const { createAgentKey, deleteKey } = await import('./openrouter');
  const { updateContainerEnv } = await import('./hetzner-multi');
  
  // Get all user's running agents
  const agents = await prisma.agent.findMany({
    where: { 
      userId,
      status: 'running'
    },
    select: {
      id: true,
      name: true,
      tier: true,
      openrouterKeyHash: true,
      hostIp: true,
    },
  });
  
  console.log(`[billing] Rotating keys for ${agents.length} agents (tier: ${tier})`);
  
  for (const agent of agents) {
    try {
      // Create new key with tier-based monthly limit
      const newKey = await createAgentKey(agent.id, agent.name, tier);
      
      // Delete old key if exists
      if (agent.openrouterKeyHash) {
        await deleteKey(agent.openrouterKeyHash).catch((err) => {
          console.warn(`[billing] Failed to delete old key for ${agent.id}:`, err);
        });
      }
      
      // Update database with new tier and key
      await prisma.agent.update({
        where: { id: agent.id },
        data: { 
          tier,
          openrouterKeyHash: newKey.hash,
        },
      });
      
      // Inject new key into container (auto-restarts)
      if (agent.hostIp) {
        await updateContainerEnv(
          agent.id,
          agent.hostIp,
          'OPENROUTER_API_KEY',
          newKey.key
        );
        console.log(`[billing] Rotated key for agent ${agent.name} (${agent.id.slice(0, 8)})`);
      }
    } catch (error) {
      console.error(`[billing] Failed to rotate key for agent ${agent.id}:`, error);
      // Continue with other agents even if one fails
    }
  }
}

/**
 * Process manual payment (user-initiated)
 * Called after user approves payment via Privy
 */
export async function processManualPayment(userId: string, txSignature: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tier: true,
      monthlyAmountUsd: true,
      nextBillingDate: true,
      billingStatus: true,
    },
  });
  
  if (!user) throw new Error('User not found');
  if (!user.monthlyAmountUsd) throw new Error('No billing amount set');
  
  // Verify transaction on-chain (API-S02)
  const connection = new Connection(RPC_URL, 'confirmed');
  const tx = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
  
  if (!tx) throw new Error('Transaction not found on-chain');
  if (tx.meta?.err) throw new Error('Transaction failed on-chain');
  
  // Verify it's a USDC transfer to our treasury
  const treasuryAta = await getAssociatedTokenAddress(USDC_MINT, TREASURY_WALLET);
  const instructions = tx.transaction.message.instructions;
  let verified = false;
  
  for (const ix of instructions) {
    if ('parsed' in ix && ix.program === 'spl-token' && ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info;
      if (
        info.destination === treasuryAta.toString() &&
        Number(info.amount) >= user.monthlyAmountUsd * 1_000_000 // USDC has 6 decimals
      ) {
        verified = true;
        break;
      }
    }
    // Also check transferChecked (used by some wallets)
    if ('parsed' in ix && ix.program === 'spl-token' && ix.parsed?.type === 'transferChecked') {
      const info = ix.parsed.info;
      if (
        info.destination === treasuryAta.toString() &&
        Number(info.tokenAmount?.amount) >= user.monthlyAmountUsd * 1_000_000
      ) {
        verified = true;
        break;
      }
    }
  }
  
  if (!verified) throw new Error('Transaction does not contain valid USDC payment to treasury');
  
  // Check for duplicate payment (same tx signature already recorded)
  const existing = await prisma.payment.findFirst({ where: { txSignature } });
  if (existing) throw new Error('Payment already recorded');
  
  // Record the payment
  await recordPayment(
    userId,
    null, // Not tied to specific agent
    user.monthlyAmountUsd,
    'USDC',
    user.monthlyAmountUsd, // 1:1
    txSignature,
    'completed',
    'subscription',
  );
  
  // Update next billing date (add 30 days)
  const nextBilling = user.nextBillingDate ? new Date(user.nextBillingDate) : new Date();
  nextBilling.setDate(nextBilling.getDate() + 30);
  
  await prisma.user.update({
    where: { id: userId },
    data: {
      nextBillingDate: nextBilling,
      lastPaymentAt: new Date(),
      billingStatus: 'active', // Always activate after successful payment
    },
  });
  
  // Key rotation happens on the monthly billing cron per-agent, not on payment
  // This prevents rotating all agent keys every time a user pays for a new agent
  
  console.log(`[billing] Manual payment processed for user ${userId}: ${txSignature}`);
}
