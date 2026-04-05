/**
 * Privy Agent Wallets — Create and manage Privy wallets for SAID agents
 * 
 * Agents don't have private keys in their config. Instead:
 * - Platform creates a Privy wallet for each agent
 * - Agents call /agents/:id/sign with API token
 * - Platform signs with agent's Privy wallet
 * 
 * This prevents prompt injection attacks and key loss.
 */

import { PrivyClient } from '@privy-io/node';
import type { AuthorizationContext } from '@privy-io/node';

const PRIVY_APP_ID = 'cmlbxd3qu00jqi80c4pibohzv';
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || '';
const AUTHORIZATION_KEY = process.env.PRIVY_AUTHORIZATION_KEY || '';
const AUTHORIZATION_KEY_ID = process.env.PRIVY_AUTHORIZATION_KEY_ID || '';

// Initialize Privy client
const privy = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });

// Authorization context for wallet operations
const authContext: AuthorizationContext = {
  authorization_private_keys: [AUTHORIZATION_KEY],
};

/**
 * Create a new Privy wallet for an agent (Solana mainnet)
 * Returns { walletId, address }
 */
export async function createAgentWallet(): Promise<{ walletId: string; address: string }> {
  try {
    console.log('[privy-wallets] Creating new Solana wallet...');
    
    const result = await privy.wallets().create({
      chain_type: 'solana',
      authorization_context: authContext,
    });
    
    const walletId = (result as any).id;
    const address = (result as any).address;
    
    if (!walletId || !address) {
      throw new Error('Privy wallet creation failed - missing id or address');
    }
    
    console.log(`[privy-wallets] Created wallet ${walletId} (${address})`);
    
    return { walletId, address };
  } catch (error) {
    console.error('[privy-wallets] Wallet creation error:', error);
    throw error;
  }
}

/**
 * Sign a transaction with an agent's Privy wallet
 * 
 * @param walletId - The Privy wallet ID (from database)
 * @param transaction - Base64-encoded serialized transaction
 * @returns Transaction signature (hash)
 */
export async function signTransaction(
  walletId: string,
  transaction: string,
): Promise<string> {
  try {
    console.log(`[privy-wallets] Signing transaction with wallet ${walletId}`);
    
    const result = await privy.wallets().rpc(walletId, {
      method: 'signAndSendTransaction',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', // Solana mainnet
      params: {
        transaction,
        encoding: 'base64',
      },
      chain_type: 'solana',
      authorization_context: {
        authorization_private_keys: [AUTHORIZATION_KEY],
      },
    });
    
    const hash = (result as any).hash || (result as any).signature || (result as any).data?.hash;
    
    if (!hash) {
      throw new Error('Privy signing failed - no transaction hash returned');
    }
    
    console.log(`[privy-wallets] Transaction signed: ${hash}`);
    return hash;
  } catch (error) {
    console.error(`[privy-wallets] Signing error:`, error);
    throw error;
  }
}

/**
 * Sign a transaction without sending it (for agents that want to submit themselves)
 * 
 * @param walletId - The Privy wallet ID
 * @param transaction - Base64-encoded serialized transaction
 * @returns Signed transaction (base64)
 */
export async function signTransactionOnly(
  walletId: string,
  transaction: string,
): Promise<string> {
  try {
    console.log(`[privy-wallets] Signing transaction (no send) with wallet ${walletId}`);
    
    const result = await privy.wallets().rpc(walletId, {
      method: 'signTransaction',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      params: {
        transaction,
        encoding: 'base64',
      },
      chain_type: 'solana',
      authorization_context: {
        authorization_private_keys: [AUTHORIZATION_KEY],
      },
    });
    
    const signedTx = (result as any).signedTransaction || (result as any).data?.signedTransaction;
    
    if (!signedTx) {
      throw new Error('Privy signing failed - no signed transaction returned');
    }
    
    return signedTx;
  } catch (error) {
    console.error(`[privy-wallets] Sign-only error:`, error);
    throw error;
  }
}
