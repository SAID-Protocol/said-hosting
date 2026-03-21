/**
 * Privy Server-Side Billing — Sign and submit USDC transfers
 * 
 * Uses Privy's @privy-io/node SDK with authorization context
 * to sign transactions on users' embedded wallets.
 */

import { PrivyClient } from '@privy-io/node';
import type { AuthorizationContext } from '@privy-io/node';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const PRIVY_APP_ID = 'cmlbxd3qu00jqi80c4pibohzv';
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || '';
const AUTHORIZATION_KEY = process.env.PRIVY_AUTHORIZATION_KEY || '';
const AUTHORIZATION_KEY_ID = process.env.PRIVY_AUTHORIZATION_KEY_ID || '';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TREASURY_WALLET = new PublicKey(process.env.BILLING_TREASURY_WALLET || 'HUpEuDs3FC4T3xMZ3n8EGe16QLJFSnjbd1Kzh6C22YyP');
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://newest-restless-mansion.solana-mainnet.quiknode.pro/af7d979a4ef8558eb0da3166819eac8af0d3dd2b';

// Initialize Privy client (new SDK takes config object)
const privy = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });

// Authorization context for signing wallet transactions
const authContext: AuthorizationContext = {
  authorization_private_keys: [AUTHORIZATION_KEY],
};

/**
 * Get the Privy wallet ID for a user by their Privy DID
 */
export async function getUserWalletId(privyDid: string): Promise<{ walletId: string; address: string } | null> {
  try {
    const user = await privy.users()._get(privyDid);
    
    // Find the embedded Solana wallet
    const solanaWallet = user.linked_accounts?.find(
      (account: any) => account.type === 'wallet' && account.chain_type === 'solana' && 'id' in account
    );
    
    if (!solanaWallet || !('id' in solanaWallet)) return null;
    
    return {
      walletId: (solanaWallet as any).id,
      address: (solanaWallet as any).address,
    };
  } catch (error) {
    console.error(`[privy-billing] Failed to get wallet for ${privyDid}:`, error);
    return null;
  }
}

/**
 * Build a USDC transfer transaction (to treasury)
 */
async function buildUsdcTransferTx(
  fromAddress: string,
  amountUsd: number,
): Promise<string> {
  const connection = new Connection(RPC_URL);
  const from = new PublicKey(fromAddress);
  
  const amountLamports = Math.round(amountUsd * 1_000_000); // USDC has 6 decimals
  
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
  
  // Serialize as base64 for Privy
  return transaction.serialize({ requireAllSignatures: false }).toString('base64');
}

/**
 * Sign and submit a billing transaction via Privy
 * 
 * Returns the transaction signature, or null on failure.
 */
export async function signAndSubmitBillingTx(
  privyDid: string,
  amountUsd: number,
): Promise<string | null> {
  try {
    // 1. Get user's wallet
    const wallet = await getUserWalletId(privyDid);
    if (!wallet) {
      console.error(`[privy-billing] No wallet found for ${privyDid}`);
      return null;
    }
    
    // 2. Build the USDC transfer transaction
    const serializedTx = await buildUsdcTransferTx(wallet.address, amountUsd);
    
    // 3. Sign and send via Privy API
    // Using the intents/rpc endpoint with signAndSendTransaction
    const response = await fetch(`https://api.privy.io/v1/intents/wallets/${wallet.walletId}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'privy-app-id': PRIVY_APP_ID,
        'Authorization': `Basic ${Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64')}`,
      },
      body: JSON.stringify({
        method: 'signAndSendTransaction',
        params: {
          transaction: serializedTx,
          encoding: 'base64',
        },
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`[privy-billing] Privy RPC failed (${response.status}):`, error);
      return null;
    }
    
    const result = await response.json();
    
    // The intent may need authorization signing
    if (result.status === 'pending_authorization') {
      console.log(`[privy-billing] Intent ${result.intent_id} pending authorization — needs signer setup`);
      // TODO: Use authorization context to approve the intent
      return null;
    }
    
    // Extract tx signature from result
    const txSignature = result.response?.signature || result.response?.result || null;
    
    if (txSignature) {
      console.log(`[privy-billing] Billing tx submitted: ${txSignature}`);
    }
    
    return txSignature;
  } catch (error) {
    console.error(`[privy-billing] Error:`, error);
    return null;
  }
}

/**
 * Build a USDC withdrawal transaction (to external address)
 */
async function buildWithdrawalTx(
  fromAddress: string,
  toAddress: string,
  amountUsd: number,
): Promise<string> {
  const connection = new Connection(RPC_URL);
  const from = new PublicKey(fromAddress);
  const to = new PublicKey(toAddress);
  
  const amountLamports = Math.round(amountUsd * 1_000_000); // USDC has 6 decimals
  
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
  
  // Serialize as base64 for Privy
  return transaction.serialize({ requireAllSignatures: false }).toString('base64');
}

/**
 * Sign and submit a withdrawal transaction via Privy
 * User can withdraw USDC from their embedded wallet to an external address
 */
export async function signAndSubmitWithdrawalTx(
  privyDid: string,
  toAddress: string,
  amountUsd: number,
): Promise<string | null> {
  try {
    // 1. Get user's wallet
    const wallet = await getUserWalletId(privyDid);
    if (!wallet) {
      console.error(`[privy-billing] No wallet found for ${privyDid}`);
      return null;
    }
    
    // 2. Build the withdrawal transaction
    const serializedTx = await buildWithdrawalTx(wallet.address, toAddress, amountUsd);
    
    // 3. Sign and send via Privy API
    const response = await fetch(`https://api.privy.io/v1/intents/wallets/${wallet.walletId}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'privy-app-id': PRIVY_APP_ID,
        'Authorization': `Basic ${Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64')}`,
      },
      body: JSON.stringify({
        method: 'signAndSendTransaction',
        params: {
          transaction: serializedTx,
          encoding: 'base64',
        },
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`[privy-billing] Withdrawal RPC failed (${response.status}):`, error);
      return null;
    }
    
    const result = await response.json();
    
    if (result.status === 'pending_authorization') {
      console.log(`[privy-billing] Withdrawal intent ${result.intent_id} pending authorization`);
      return null;
    }
    
    const txSignature = result.response?.signature || result.response?.result || null;
    
    if (txSignature) {
      console.log(`[privy-billing] Withdrawal tx submitted: ${txSignature}`);
    }
    
    return txSignature;
  } catch (error) {
    console.error(`[privy-billing] Withdrawal error:`, error);
    return null;
  }
}
