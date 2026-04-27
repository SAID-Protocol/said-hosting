/**
 * Fee Watcher — watches agent wallets for swap transactions and auto-collects 1% fees.
 * 
 * This runs as a background loop, independent of how the swap was initiated.
 * Works whether OpenClaw uses its built-in tools or Butler's execute_swap.
 * 
 * Flow:
 * 1. Poll each agent wallet for recent transactions
 * 2. Detect swap transactions (Jupiter program IDs)
 * 3. Parse output amount
 * 4. Transfer 1% fee to treasury
 * 5. Record in DB
 */

import { Connection, PublicKey, VersionedTransaction, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { prisma } from '../db';
import { signTransaction } from './privy-wallets';

const TREASURY = '2XfHTeNWTjNwUmgoXaafYuqHcAAXj8F5Kjw2Bnzi4FxH';
const FEE_RATE = 0.01;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Jupiter program IDs
const JUPITER_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6
  'JUP4Fb2cqiRUcKkRJ6SJfW3qGdqbcFSSKk5JrKN3AMv', // Jupiter V4 (legacy)
  'JUP2jxvXaacZPDkPasmkRXkjetr2YYyoRYYyS8nZfUbr', // Jupiter V2 (legacy)
  'LANGu4KkTDE7K8FZGdJxQnEshPh2P5RuJjPyjkNy0Mg',  // Jupiter Limit Order
]);

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Track processed signatures to avoid duplicates
const processedSignatures = new Set<string>();

interface SwapDetection {
  signature: string;
  outputMint: string;
  outputAmount: number;
  isSwap: boolean;
}

/**
 * Detect if a transaction is a Jupiter swap and extract output details.
 */
function detectSwapTx(tx: any): SwapDetection | null {
  try {
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const programIds = accountKeys.map((k: any) => 
      typeof k === 'string' ? k : k.pubkey?.toBase58?.() || ''
    );

    // Check if any Jupiter program is in the account keys
    const hasJupiter = programIds.some((p: string) => JUPITER_PROGRAMS.has(p));
    if (!hasJupiter) return null;

    return {
      signature: tx.transaction?.signatures?.[0] || '',
      outputMint: 'SOL', // Default, will be refined
      outputAmount: 0,
      isSwap: true,
    };
  } catch {
    return null;
  }
}

/**
 * Parse post-balances to determine SOL change from a swap.
 */
function parseSolOutput(tx: any, walletAddress: string): number {
  try {
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const postBalances = tx.meta?.postBalances || [];
    const preBalances = tx.meta?.preBalances || [];

    const walletIndex = accountKeys.findIndex((k: any) => {
      const addr = typeof k === 'string' ? k : k.pubkey?.toBase58?.() || '';
      return addr === walletAddress;
    });

    if (walletIndex === -1) return 0;

    const pre = preBalances[walletIndex] || 0;
    const post = postBalances[walletIndex] || 0;

    // SOL increase from swap (could be negative if SOL was input)
    return Math.max(0, (post - pre) / 10 ** 9);
  } catch {
    return 0;
  }
}

/**
 * Collect SOL fee from agent wallet to treasury.
 */
async function collectSolFee(
  privyWalletId: string,
  walletAddress: string,
  feeSOL: number,
  externalId: string,
  swapSignature: string
): Promise<string | null> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const fromPubkey = new PublicKey(walletAddress);
  const treasury = new PublicKey(TREASURY);

  const feeLamports = Math.floor(feeSOL * 10 ** 9);
  if (feeLamports < 1000) return null; // Skip dust

  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey, toPubkey: treasury, lamports: feeLamports })],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');

  try {
    const signature = await signTransaction(privyWalletId, txBase64);
    console.log(`[fee-watcher] Collected ${feeSOL.toFixed(6)} SOL from ${externalId}, tx: ${signature}`);
    return signature;
  } catch (err) {
    console.error(`[fee-watcher] SOL fee collection failed for ${externalId}:`, err);
    return null;
  }
}

/**
 * Check a single agent wallet for unprocessed swap transactions.
 */
async function checkAgentWallet(user: any): Promise<void> {
  if (!user.walletAddress || !user.privyWalletId) return;

  const connection = new Connection(RPC_URL, 'confirmed');

  try {
    // Get recent signatures (last 25 txs)
    const signatures = await connection.getSignaturesForAddress(
      new PublicKey(user.walletAddress),
      { limit: 25 }
    );

    for (const sigInfo of signatures) {
      const sig = sigInfo.signature;

      // Skip already processed
      if (processedSignatures.has(sig)) continue;
      processedSignatures.add(sig);

      // Skip if we already have a fee record for this swap
      const existingFee = await prisma.transactionFee.findFirst({
        where: { swapTxSig: sig },
      });
      if (existingFee) continue;

      // Fetch full transaction
      const tx = await connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;

      // Check if it's a swap
      const detection = detectSwapTx(tx);
      if (!detection) continue;

      // Parse output
      const solOutput = parseSolOutput(tx, user.walletAddress);
      if (solOutput <= 0) continue; // No SOL received from this swap (SOL was input)

      // Calculate fee
      const fee = solOutput * FEE_RATE;
      if (fee < 0.0001) continue; // Skip dust

      // Collect fee on-chain
      const feeSig = await collectSolFee(
        user.privyWalletId,
        user.walletAddress,
        fee,
        user.externalId,
        sig
      );

      // Record in DB
      await prisma.transactionFee.create({
        data: {
          agentId: user.externalId,
          action: 'swap',
          amount: solOutput,
          fee: fee,
          currency: 'SOL',
          collected: !!feeSig,
          txSignature: feeSig,
          swapTxSig: sig,
        },
      });

      console.log(`[fee-watcher] Swap detected for ${user.externalId}: ${solOutput.toFixed(4)} SOL output, fee: ${fee.toFixed(6)} SOL`);
    }
  } catch (err) {
    console.error(`[fee-watcher] Error checking ${user.externalId}:`, err);
  }
}

/**
 * Main loop — check all active agent wallets periodically.
 */
export async function startFeeWatcher(intervalMs = 60000): Promise<void> {
  console.log(`[fee-watcher] Starting with ${intervalMs}ms interval`);

  const run = async () => {
    try {
      // Get all verified agents
      const agents = await prisma.butlerUser.findMany({
        where: {
          saidVerified: true,
          walletAddress: { not: null },
          privyWalletId: { not: null },
        },
        select: {
          externalId: true,
          walletAddress: true,
          privyWalletId: true,
        },
      });

      console.log(`[fee-watcher] Checking ${agents.length} verified agents`);

      for (const agent of agents) {
        await checkAgentWallet(agent);
        // Small delay between agents to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.error('[fee-watcher] Loop error:', err);
    }
  };

  // Run immediately, then on interval
  await run();
  setInterval(run, intervalMs);
}
