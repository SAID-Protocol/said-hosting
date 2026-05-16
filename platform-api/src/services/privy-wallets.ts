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

const PRIVY_APP_ID = 'cmlbxd3qu00jqi80c4pibohzv';
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || '';

// Initialize Privy client
const privy = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });

/**
 * Create a new Privy wallet for an agent (Solana mainnet)
 * Returns { walletId, address }
 */
export async function createAgentWallet(): Promise<{ walletId: string; address: string }> {
  try {
    console.log('[privy-wallets] Creating new Solana wallet...');
    
    const result = await (privy as any).wallets().create({
      chain_type: 'solana',
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
    
    const result = await (privy as any).wallets().rpc(walletId, {
      method: 'signAndSendTransaction',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      params: {
        transaction,
        encoding: 'base64',
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
 * Sign an arbitrary message with an agent's Privy wallet (Solana)
 * Used for SAID Protocol registration signatures.
 * 
 * @param walletId - The Privy wallet ID
 * @param message - UTF-8 message string to sign
 * @returns Base58-encoded signature
 */
export async function signMessage(
  walletId: string,
  message: string,
): Promise<string> {
  try {
    console.log(`[privy-wallets] Signing message with wallet ${walletId}`);
    
    // Encode message as base64 for Privy RPC
    const messageBase64 = Buffer.from(message, 'utf8').toString('base64');
    
    const result = await (privy as any).wallets().rpc(walletId, {
      method: 'signMessage',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      params: {
        message: messageBase64,
        encoding: 'base64',
      },
    });
    
    const signature = (result as any).signature || (result as any).data?.signature;
    
    if (!signature) {
      throw new Error('Privy message signing failed - no signature returned');
    }
    
    console.log(`[privy-wallets] Message signed successfully`);
    return signature;
  } catch (error) {
    console.error(`[privy-wallets] Message signing error:`, error);
    throw error;
  }
}

/**
 * Resolve a social handle to a Solana wallet via Privy's linked-accounts index.
 *
 * Privy maintains the canonical "human ↔ linked accounts" mapping. We call its
 * getByTwitterUsername / getByTelegramUsername endpoint and walk the user's
 * linked_accounts for a Solana embedded wallet. Returns null if no Privy user
 * has that handle linked, OR if the user has no Solana wallet on file.
 *
 * Cost: one Privy API call per uncached resolve. Cache the result client-side
 * (butler local DB) once successful so we don't hit Privy on repeat sends to
 * the same handle.
 */
export async function resolveHandleViaPrivy(
  username: string,
  platform: 'twitter' | 'telegram',
): Promise<{
  found: boolean;
  walletAddress?: string;
  privyUserId?: string;
  displayName?: string;
}> {
  try {
    const user: any =
      platform === 'twitter'
        ? await (privy as any).users.getByTwitterUsername({ username })
        : await (privy as any).users.getByTelegramUsername({ username });

    if (!user) return { found: false };

    // Walk linked_accounts for a Solana wallet. Prefer embedded > external.
    const linked: any[] = user.linked_accounts || [];
    const embedded = linked.find(
      (a) => a?.chain_type === 'solana' && a?.connector_type === 'embedded',
    );
    const external = linked.find(
      (a) => a?.chain_type === 'solana' && a?.type === 'wallet' && a?.connector_type !== 'embedded',
    );
    const wallet = embedded || external;

    if (!wallet?.address) {
      console.warn(`[privy] @${username} on ${platform} found but no Solana wallet linked (privyUserId=${user.id})`);
      return { found: false };
    }

    // Surface the most useful display name we can find. Twitter username,
    // Telegram username, or the user's email — in that order.
    const twitter = linked.find((a) => a?.type === 'twitter_oauth')?.username;
    const telegram = linked.find((a) => a?.type === 'telegram')?.username;
    const displayName = (platform === 'twitter' ? twitter : telegram) || username;

    return {
      found: true,
      walletAddress: wallet.address,
      privyUserId: user.id,
      displayName,
    };
  } catch (error: any) {
    // Privy returns 404 for "no user with that handle" — that's a normal not-found,
    // not an error. Surface anything else.
    if (error?.status === 404 || error?.response?.status === 404 || /not.?found/i.test(String(error?.message))) {
      return { found: false };
    }
    console.error('[privy/resolveHandle]', error);
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
    
    // Use the newer Privy SDK method: wallets().solana().signTransaction()
    const result = await (privy as any).wallets().solana().signTransaction(walletId, {
      transaction,
    });
    
    const signedTx = result?.signed_transaction || result?.signedTransaction;
    
    if (!signedTx) {
      throw new Error('Privy signing failed - no signed transaction returned');
    }
    
    return signedTx;
  } catch (error) {
    console.error(`[privy-wallets] Sign-only error:`, error);
    throw error;
  }
}
