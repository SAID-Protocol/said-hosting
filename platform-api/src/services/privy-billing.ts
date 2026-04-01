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
if (!process.env.SOLANA_RPC_URL) throw new Error('SOLANA_RPC_URL environment variable is required');
const RPC_URL: string = process.env.SOLANA_RPC_URL;

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
 * Charge a specific wallet by ID and address directly
 * No user lookup needed — just walletId + address + amount
 */
export async function chargeWallet(
  walletId: string,
  walletAddress: string,
  amountUsd: number,
): Promise<string | null> {
  try {
    console.log(`[privy-billing] Charging $${amountUsd} USDC from wallet ${walletId} (${walletAddress})`);
    
    const serializedTx = await buildUsdcTransferTx(walletAddress, amountUsd);
    
    const result = await privy.wallets().rpc(walletId, {
      method: 'signAndSendTransaction',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      params: {
        transaction: serializedTx,
        encoding: 'base64',
      },
      chain_type: 'solana',
      authorization_context: {
        authorization_private_keys: [AUTHORIZATION_KEY],
      },
    });
    
    const hash = (result as any).hash || (result as any).signature || (result as any).data?.hash;
    console.log(`[privy-billing] Charge tx submitted: ${hash}`);
    return hash || null;
  } catch (error) {
    console.error(`[privy-billing] Charge error:`, error);
    return null;
  }
}

/**
 * Sign and submit a billing transaction via Privy SDK (by user DID)
 * Looks up the user's wallet, then charges it.
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
    
    console.log(`[privy-billing] Charging $${amountUsd} USDC from wallet ${wallet.walletId} (${wallet.address})`);
    
    // 2. Build the USDC transfer transaction
    const serializedTx = await buildUsdcTransferTx(wallet.address, amountUsd);
    
    // 3. Sign and send via Privy SDK with authorization context
    // Uses privy.wallets().rpc() which auto-generates authorization signatures
    const result = await privy.wallets().rpc(wallet.walletId, {
      method: 'signAndSendTransaction',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', // Solana mainnet
      params: {
        transaction: serializedTx,
        encoding: 'base64',
      },
      chain_type: 'solana',
      authorization_context: {
        authorization_private_keys: [AUTHORIZATION_KEY],
      },
    });
    
    const hash = (result as any).hash || (result as any).signature || (result as any).data?.hash;
    console.log(`[privy-billing] Billing tx submitted: ${hash}`);
    return hash || null;
  } catch (error) {
    console.error(`[privy-billing] Billing error:`, error);
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
 * Sign and submit a withdrawal transaction via Privy SDK
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
    
    console.log(`[privy-billing] Withdrawing $${amountUsd} USDC from wallet ${wallet.walletId} to ${toAddress}`);
    
    // 2. Build the withdrawal transaction
    const serializedTx = await buildWithdrawalTx(wallet.address, toAddress, amountUsd);
    
    // 3. Sign and send via Privy SDK with authorization context
    const result = await privy.wallets().rpc(wallet.walletId, {
      method: 'signAndSendTransaction',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', // Solana mainnet
      params: {
        transaction: serializedTx,
        encoding: 'base64',
      },
      chain_type: 'solana',
      authorization_context: {
        authorization_private_keys: [AUTHORIZATION_KEY],
      },
    });
    
    const hash = (result as any).hash || (result as any).signature || (result as any).data?.hash;
    console.log(`[privy-billing] Withdrawal tx submitted: ${hash}`);
    return hash || null;
  } catch (error) {
    console.error(`[privy-billing] Withdrawal error:`, error);
    return null;
  }
}
