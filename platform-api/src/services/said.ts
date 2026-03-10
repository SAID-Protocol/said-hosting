import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';

export interface SaidMetadata {
  description?: string;
  twitter?: string;
  website?: string;
  capabilities?: string[];
}

export interface SaidRegistrationResult {
  success: boolean;
  walletAddress: string;
  secretKeyBase58: string;
  saidPda?: string;
  profile?: string;
  error?: string;
}

interface PendingRegisterResponse {
  success?: boolean;
  pda?: string;
  profile?: string;
  error?: string;
}

function getRegistrationMessage(wallet: string, name: string, timestamp: number): string {
  return `SAID:register:${wallet}:${name}:${timestamp}`;
}

function signMessage(message: string, keypair: Keypair): string {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return bs58.encode(signature);
}

export function generateKeypair(): { keypair: Keypair; walletAddress: string; secretKeyBase58: string } {
  const keypair = Keypair.generate();
  return {
    keypair,
    walletAddress: keypair.publicKey.toBase58(),
    secretKeyBase58: bs58.encode(keypair.secretKey),
  };
}

export async function registerAgent(agentName: string, metadata: SaidMetadata = {}): Promise<SaidRegistrationResult> {
  const { keypair, walletAddress, secretKeyBase58 } = generateKeypair();

  try {
    const timestamp = Date.now();
    const message = getRegistrationMessage(walletAddress, agentName, timestamp);
    const signature = signMessage(message, keypair);

    const response = await fetch(`${SAID_API}/api/register/pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: walletAddress,
        name: agentName,
        description: metadata.description || `Hosted SAID agent: ${agentName}`,
        twitter: metadata.twitter,
        website: metadata.website,
        capabilities: metadata.capabilities || ['messaging', 'web-search'],
        signature,
        timestamp,
      }),
    });

    const data = await response.json() as PendingRegisterResponse;

    if (response.ok && data.success) {
      return {
        success: true,
        walletAddress,
        secretKeyBase58,
        saidPda: data.pda,
        profile: data.profile,
      };
    }

    return {
      success: false,
      walletAddress,
      secretKeyBase58,
      error: data.error || 'Registration failed',
    };
  } catch (error) {
    return {
      success: false,
      walletAddress,
      secretKeyBase58,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

export async function verifyAgent(agentPDA: string): Promise<string> {
  return agentPDA;
}
