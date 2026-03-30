import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotent,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';

const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
const SAID_PLATFORM_KEY = process.env.SAID_HOSTING_API_KEY || '';
if (!process.env.SOLANA_RPC_URL) throw new Error('SOLANA_RPC_URL environment variable is required');
const SOLANA_RPC_URL: string = process.env.SOLANA_RPC_URL;
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;
const FUNDING_AMOUNTS: Record<string, number> = {
  trial: 0,    // No USDC funding for trials (they use z.ai sponsored API instead)
  starter: 2,
  pro: 5,
  power: 15,
};

interface SaidRegisterResponse {
  success?: boolean;
  unsignedTransaction?: string;
  unsignedTx?: string;
  transaction?: string;
  pda?: string;
  error?: string;
}

interface SaidConfirmResponse {
  success?: boolean;
  signature?: string;
  txSignature?: string;
  pda?: string;
  wallet?: string;
  error?: string;
  [key: string]: unknown;
}

export type SaidRegisterRequest = {
  wallet: string;
  name: string;
  description: string;
  capabilities?: string[];
};

export type SaidRegisterResult = {
  success: boolean;
  unsignedTransaction?: string;
  pda?: string;
  error?: string;
};

export type SaidConfirmRequest = {
  signedTransaction: string;
  wallet: string;
  name: string;
  description?: string;
  twitter?: string;
  website?: string;
  capabilities?: string[];
};

export type SaidConfirmResult = {
  success: boolean;
  saidPda?: string;
  signature?: string;
  wallet?: string;
  raw?: SaidConfirmResponse;
  error?: string;
};

export type FundingResult = {
  success: boolean;
  amountUsdc: number;
  signature?: string;
  error?: string;
};

function getPlatformHeaders(): HeadersInit {
  if (!SAID_PLATFORM_KEY) {
    throw new Error('SAID_HOSTING_API_KEY is required');
  }

  return {
    'Content-Type': 'application/json',
    'X-Platform-Key': SAID_PLATFORM_KEY,
  };
}

export function getFundingAmountUsdc(tier: string): number {
  return FUNDING_AMOUNTS[tier] ?? FUNDING_AMOUNTS.starter;
}

export async function registerHostedAgent(payload: SaidRegisterRequest): Promise<SaidRegisterResult> {
  try {
    const response = await fetch(`${SAID_API}/api/platforms/said-hosting/register`, {
      method: 'POST',
      headers: getPlatformHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as SaidRegisterResponse;
    const unsignedTransaction = data.unsignedTransaction || data.unsignedTx || data.transaction;

    if (!response.ok || !data.success || !unsignedTransaction) {
      return {
        success: false,
        error: data.error || `SAID register failed with status ${response.status}`,
      };
    }

    return {
      success: true,
      unsignedTransaction,
      pda: data.pda,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

export async function confirmHostedAgent(payload: SaidConfirmRequest): Promise<SaidConfirmResult> {
  try {
    const response = await fetch(`${SAID_API}/api/platforms/said-hosting/confirm`, {
      method: 'POST',
      headers: getPlatformHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as SaidConfirmResponse;

    if (!response.ok || !data.success) {
      return {
        success: false,
        error: data.error || `SAID confirm failed with status ${response.status}`,
      };
    }

    return {
      success: true,
      saidPda: data.pda,
      signature: data.signature || data.txSignature,
      wallet: data.wallet,
      raw: data,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

function getFundingKeypair(): Keypair {
  const encoded = process.env.FUNDING_WALLET_KEYPAIR;
  if (!encoded) {
    throw new Error('FUNDING_WALLET_KEYPAIR is required');
  }

  return Keypair.fromSecretKey(bs58.decode(encoded));
}

export async function fundAgentWallet(agentWallet: string, tier: string): Promise<FundingResult> {
  const amountUsdc = getFundingAmountUsdc(tier);

  // Skip funding for trial tier (they use z.ai sponsored API instead)
  if (amountUsdc === 0) {
    return {
      success: true,
      amountUsdc: 0,
      signature: null,
    };
  }

  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const fundingKeypair = getFundingKeypair();
    const owner = fundingKeypair.publicKey;
    const destination = new PublicKey(agentWallet);

    const sourceAta = getAssociatedTokenAddressSync(USDC_MINT, owner);
    const destinationAta = getAssociatedTokenAddressSync(USDC_MINT, destination);

    await createAssociatedTokenAccountIdempotent(
      connection,
      fundingKeypair,
      USDC_MINT,
      destination,
    );

    const latest = await connection.getLatestBlockhash('confirmed');
    const transferTx = new Transaction({
      feePayer: owner,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(
      createTransferCheckedInstruction(
        sourceAta,
        USDC_MINT,
        destinationAta,
        owner,
        Math.round(amountUsdc * 10 ** USDC_DECIMALS),
        USDC_DECIMALS,
      ),
    );

    const signature = await connection.sendTransaction(transferTx, [fundingKeypair], {
      skipPreflight: false,
    });
    await connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed',
    );

    return {
      success: true,
      amountUsdc,
      signature,
    };
  } catch (error) {
    return {
      success: false,
      amountUsdc,
      error: error instanceof Error ? error.message : 'Funding failed',
    };
  }
}
