/**
 * Agent Wallet Signing API
 * 
 * Allows agents to sign transactions without exposing private keys.
 * Agents call this with their API token, platform signs with their Privy wallet.
 */

import { Router } from 'express';
import { prisma } from '../db';
import { hashGatewayToken } from '../utils/auth';
import { signTransaction, signTransactionOnly } from '../services/privy-wallets';
import { extractPlatformFee } from '../services/transaction-fees';

const router = Router();

/**
 * POST /agents/:id/sign
 * 
 * Sign a transaction with the agent's Privy wallet
 * 
 * Headers:
 *   X-Gateway-Token: <agent's gateway token>
 *   
 * Body:
 *   {
 *     "transaction": "base64-encoded-transaction",
 *     "sendImmediately": true  // optional, default true
 *   }
 *   
 * Returns:
 *   {
 *     "signature": "tx-hash" | "signed-tx-base64",
 *     "sent": true | false
 *   }
 */
router.post('/:id/sign', async (req, res) => {
  try {
    const { id: agentId } = req.params;
    const { transaction, sendImmediately = true } = req.body;
    const gatewayToken = req.headers['x-gateway-token'] as string;

    // Validate inputs
    if (!gatewayToken) {
      return res.status(401).json({ error: 'Missing X-Gateway-Token header' });
    }

    if (!transaction || typeof transaction !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid transaction (must be base64 string)' });
    }

    // Look up agent and verify token
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const tokenHash = hashGatewayToken(gatewayToken);
    if (tokenHash !== agent.gatewayTokenHash) {
      return res.status(403).json({ error: 'Invalid gateway token' });
    }

    if (!agent.privyWalletId) {
      return res.status(400).json({ 
        error: 'Agent does not have a Privy wallet (legacy agent or wallet creation failed)' 
      });
    }

    // Extract 1% platform fee
    const { modifiedTransaction, feeAmount, originalAmount } = await extractPlatformFee(
      transaction,
      agent.walletAddress!,
    );

    if (feeAmount > 0) {
      console.log(
        `[wallet] Agent ${agentId}: Extracted ${feeAmount} lamports fee from ${originalAmount} lamports transfer`,
      );
    }

    // Sign (and optionally send) the modified transaction
    let signature: string;

    if (sendImmediately) {
      signature = await signTransaction(agent.privyWalletId, modifiedTransaction);
      console.log(`[wallet] Agent ${agentId} signed and sent transaction: ${signature}`);
      return res.json({ signature, sent: true, feeAmount });
    } else {
      signature = await signTransactionOnly(agent.privyWalletId, modifiedTransaction);
      console.log(`[wallet] Agent ${agentId} signed transaction (not sent)`);
      return res.json({ signature, sent: false, feeAmount });
    }
  } catch (error) {
    console.error('[wallet] Signing error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'Failed to sign transaction', details: message });
  }
});

/**
 * GET /agents/:id/wallet
 * 
 * Get agent's wallet address
 * 
 * Headers:
 *   X-Gateway-Token: <agent's gateway token>
 *   
 * Returns:
 *   {
 *     "address": "solana-public-key"
 *   }
 */
router.get('/:id/wallet', async (req, res) => {
  try {
    const { id: agentId } = req.params;
    const gatewayToken = req.headers['x-gateway-token'] as string;

    if (!gatewayToken) {
      return res.status(401).json({ error: 'Missing X-Gateway-Token header' });
    }

    const agent = await prisma.agent.findUnique({ where: { id: agentId } });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const tokenHash = hashGatewayToken(gatewayToken);
    if (tokenHash !== agent.gatewayTokenHash) {
      return res.status(403).json({ error: 'Invalid gateway token' });
    }

    if (!agent.walletAddress) {
      return res.status(404).json({ error: 'Agent wallet not yet created' });
    }

    return res.json({ address: agent.walletAddress });
  } catch (error) {
    console.error('[wallet] Get wallet error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'Failed to get wallet', details: message });
  }
});

export default router;
