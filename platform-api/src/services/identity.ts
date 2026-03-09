import { Keypair } from '@solana/web3.js';

const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';

interface RegisterResult {
  success: boolean;
  pda?: string;
  profile?: string;
  metadataUri?: string;
  badge?: string;
  error?: string;
}

/**
 * Generate a new Solana keypair for the agent.
 * Returns the keypair and the secret key as a JSON array (for storage).
 */
export function generateAgentKeypair(): { keypair: Keypair; secretKeyArray: number[] } {
  const keypair = Keypair.generate();
  return {
    keypair,
    secretKeyArray: Array.from(keypair.secretKey),
  };
}

/**
 * Register an agent on SAID Protocol via the pending registration endpoint.
 * Free, off-chain, instant.
 */
export async function registerSaidIdentity(opts: {
  wallet: string;
  name: string;
  description: string;
  twitter?: string;
  website?: string;
  capabilities?: string[];
}): Promise<RegisterResult> {
  try {
    const res = await fetch(`${SAID_API}/api/register/pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: opts.wallet,
        name: opts.name,
        description: opts.description || `SAID hosted agent: ${opts.name}`,
        twitter: opts.twitter,
        website: opts.website,
        capabilities: opts.capabilities || ['messaging', 'web-search'],
      }),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      return {
        success: true,
        pda: data.pda,
        profile: data.profile,
        metadataUri: data.metadataUri,
        badge: data.badge,
      };
    }

    return { success: false, error: data.error || 'Registration failed' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}
