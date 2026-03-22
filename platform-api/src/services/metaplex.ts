/**
 * Metaplex Agent Registry Integration
 * 
 * Creates MPL Core NFT assets and registers agent identity via
 * @metaplex-foundation/mpl-agent-registry.
 * 
 * Flow:
 * 1. Create MPL Core asset (NFT) for the agent
 * 2. Upload registration JSON to Arweave via Turbo
 * 3. Register identity via registerIdentityV1
 * 4. Return asset address + registration URI
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, create as createAsset, fetchCollection } from '@metaplex-foundation/mpl-core';
import { mplAgentIdentity } from '@metaplex-foundation/mpl-agent-registry';
import { registerIdentityV1 } from '@metaplex-foundation/mpl-agent-registry/dist/src/generated/identity/instructions';
import { generateSigner, keypairIdentity, publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  'https://newest-restless-mansion.solana-mainnet.quiknode.pro/af7d979a4ef8558eb0da3166819eac8af0d3dd2b';

// Collection for all SAID hosted agents — created once, reused
const AGENT_COLLECTION_ADDRESS = process.env.METAPLEX_AGENT_COLLECTION;

// SAID Protocol endpoints for registration document
const SAID_WEBSITE = 'https://www.saidprotocol.com';
const SAID_API = 'https://api.saidprotocol.com';
const SAID_PROGRAM_ID = '5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G';

export interface MetaplexRegistrationResult {
  success: boolean;
  assetAddress?: string;
  registrationUri?: string;
  signature?: string;
  error?: string;
}

export interface AgentMetadata {
  name: string;
  description: string;
  walletAddress: string;
  capabilities?: string[];
  tier: string;
  flyAppName?: string;
}

/**
 * Build ERC-8004 compatible agent registration document
 */
function buildRegistrationDocument(metadata: AgentMetadata): Record<string, unknown> {
  return {
    type: 'agent-registration-v1',
    name: metadata.name,
    description: metadata.description,
    image: `${SAID_WEBSITE}/api/agents/${metadata.walletAddress}/avatar`,
    services: [
      {
        name: 'web',
        endpoint: `${SAID_WEBSITE}/agents/${metadata.walletAddress}`,
      },
      {
        name: 'A2A',
        endpoint: `${SAID_API}/api/a2a/agents/${metadata.walletAddress}`,
        version: '1.2.0',
      },
      ...(metadata.flyAppName
        ? [
            {
              name: 'MCP',
              endpoint: `https://${metadata.flyAppName}.fly.dev/mcp`,
              version: '2025-06-18',
            },
          ]
        : []),
    ],
    active: true,
    registrations: [
      {
        agentId: metadata.walletAddress,
        agentRegistry: `solana:mainnet:${SAID_PROGRAM_ID}`,
      },
    ],
    supportedTrust: ['reputation', 'crypto-economic'],
    metadata: {
      tier: metadata.tier,
      capabilities: metadata.capabilities || ['messaging', 'web-search'],
      platform: 'said-hosting',
      protocol: 'said-protocol',
    },
  };
}

/**
 * Get UMI instance with platform keypair
 */
function getUmi() {
  const encoded = process.env.PLATFORM_WALLET_KEYPAIR;
  if (!encoded) {
    throw new Error('PLATFORM_WALLET_KEYPAIR is required for Metaplex operations');
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(encoded));
  const umi = createUmi(SOLANA_RPC_URL)
    .use(mplCore())
    .use(mplAgentIdentity());

  // Convert Solana keypair to UMI format
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
  umi.use(keypairIdentity(umiKeypair));

  return umi;
}

/**
 * Upload registration JSON to a publicly accessible URI.
 * 
 * For now, we host it on the SAID API itself at a deterministic URL.
 * In production, upload to Arweave via Turbo for permanence.
 */
async function uploadRegistrationDocument(
  walletAddress: string,
  document: Record<string, unknown>,
): Promise<string> {
  // Store on SAID API — accessible at /api/agents/{wallet}/registration.json
  const SAID_HOSTING_API = process.env.SAID_HOSTING_API_URL || 'https://app.saidprotocol.com';
  const API_KEY = process.env.API_KEY || '';

  try {
    const response = await fetch(`${SAID_HOSTING_API}/api/agents/registration-doc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({
        walletAddress,
        document,
      }),
    });

    if (response.ok) {
      return `${SAID_API}/api/agents/${walletAddress}/registration.json`;
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: use a data URI approach — store inline for now
  // TODO: Implement Arweave upload via Turbo
  console.warn('[metaplex] Using fallback registration URI — implement Arweave upload for production');
  return `${SAID_WEBSITE}/agents/${walletAddress}`;
}

/**
 * Create an MPL Core NFT and register agent identity on Metaplex Agent Registry.
 * 
 * This gives the agent:
 * 1. An NFT (visible in wallets, tradeable)
 * 2. A PDA for on-chain discovery
 * 3. ERC-8004 compatible registration document
 * 4. Lifecycle hooks (Transfer, Update, Execute)
 */
export async function registerAgentMetaplex(metadata: AgentMetadata): Promise<MetaplexRegistrationResult> {
  try {
    const umi = getUmi();

    // Build and upload registration document
    const registrationDoc = buildRegistrationDocument(metadata);
    const registrationUri = await uploadRegistrationDocument(metadata.walletAddress, registrationDoc);

    // Create the MPL Core asset (NFT)
    const asset = generateSigner(umi);

    const createParams: Parameters<typeof createAsset>[1] = {
      asset,
      name: metadata.name,
      uri: registrationUri,
    };

    // Fetch collection if configured — needed for both create and register
    let collection: Awaited<ReturnType<typeof fetchCollection>> | undefined;
    if (AGENT_COLLECTION_ADDRESS) {
      try {
        collection = await fetchCollection(umi, umiPublicKey(AGENT_COLLECTION_ADDRESS));
        console.log(`[metaplex] Creating asset in collection: ${AGENT_COLLECTION_ADDRESS}`);
      } catch (e) {
        console.warn('[metaplex] Collection not found, creating without collection:', e);
      }
    }

    // Create the asset — pass full collection object so asset belongs to it
    await createAsset(umi, {
      asset,
      name: metadata.name,
      uri: registrationUri,
      ...(collection ? { collection } : {}),
    }).sendAndConfirm(umi);

    console.log(`[metaplex] Created MPL Core asset: ${asset.publicKey}`);

    // Register identity on Metaplex Agent Registry
    // Pass collection publicKey for the authority check
    const registerResult = await registerIdentityV1(umi, {
      asset: asset.publicKey,
      ...(collection ? { collection: collection.publicKey } : {}),
      agentRegistrationUri: registrationUri,
    }).sendAndConfirm(umi);

    console.log(`[metaplex] Registered agent identity for ${metadata.name} (asset: ${asset.publicKey})`);

    return {
      success: true,
      assetAddress: asset.publicKey.toString(),
      registrationUri,
      signature: bs58.encode(registerResult.signature),
    };
  } catch (error) {
    console.error('[metaplex] Registration failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Metaplex registration failed',
    };
  }
}
