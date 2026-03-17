/**
 * Batch Metaplex NFT Mint for Existing SAID Agents
 * 
 * Mints NFTs for all ~1,470 existing SAID agents that don't already have one.
 * Processes in batches to avoid rate limiting and RPC throttling.
 * 
 * Usage:
 *   npx tsx scripts/batch-mint-nfts.ts [--dry-run] [--batch-size=10] [--delay=2000]
 * 
 * Prerequisites:
 *   - PLATFORM_WALLET_KEYPAIR env var (base58 encoded)
 *   - SOLANA_RPC_URL env var
 *   - METAPLEX_AGENT_COLLECTION env var (optional, for collection grouping)
 *   - SAID_API_URL env var (defaults to https://api.saidprotocol.com)
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, create as createAsset, fetchCollection } from '@metaplex-foundation/mpl-core';
import { mplAgentIdentity } from '@metaplex-foundation/mpl-agent-registry';
import { registerIdentityV1 } from '@metaplex-foundation/mpl-agent-registry/dist/src/generated/identity/instructions';
import { generateSigner, keypairIdentity, publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';

// Config
const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 
  'https://newest-restless-mansion.solana-mainnet.quiknode.pro/af7d979a4ef8558eb0da3166819eac8af0d3dd2b';
const COLLECTION_ADDRESS = process.env.METAPLEX_AGENT_COLLECTION;
const SAID_WEBSITE = 'https://www.saidprotocol.com';
const SAID_PROGRAM_ID = '5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G';

// CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '10', 10);
const DELAY_MS = parseInt(args.find(a => a.startsWith('--delay='))?.split('=')[1] || '2000', 10);

interface SaidAgent {
  wallet: string;
  name: string;
  description?: string;
  capabilities?: string[];
  verified?: boolean;
  createdAt?: string;
}

interface MintResult {
  wallet: string;
  name: string;
  success: boolean;
  assetAddress?: string;
  error?: string;
}

const LOG_FILE = `batch-mint-${new Date().toISOString().slice(0, 10)}.json`;

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function getUmi() {
  const encoded = process.env.PLATFORM_WALLET_KEYPAIR;
  if (!encoded) throw new Error('PLATFORM_WALLET_KEYPAIR required');

  const keypair = Keypair.fromSecretKey(bs58.decode(encoded));
  const umi = createUmi(SOLANA_RPC_URL).use(mplCore()).use(mplAgentIdentity());
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
  umi.use(keypairIdentity(umiKeypair));
  return umi;
}

function buildRegistrationDocument(agent: SaidAgent): Record<string, unknown> {
  return {
    type: 'agent-registration-v1',
    name: agent.name,
    description: agent.description || `SAID Protocol agent: ${agent.name}`,
    image: `${SAID_WEBSITE}/api/agents/${agent.wallet}/avatar`,
    services: [
      { name: 'web', endpoint: `${SAID_WEBSITE}/agents/${agent.wallet}` },
      { name: 'A2A', endpoint: `${SAID_API}/api/a2a/agents/${agent.wallet}`, version: '1.2.0' },
    ],
    active: true,
    registrations: [
      { agentId: agent.wallet, agentRegistry: `solana:mainnet:${SAID_PROGRAM_ID}` },
    ],
    supportedTrust: ['reputation', 'crypto-economic'],
    metadata: {
      capabilities: agent.capabilities || ['messaging'],
      platform: 'said-protocol',
      retroactiveMint: true,
      originalRegistration: agent.createdAt,
    },
  };
}

async function fetchAllAgents(): Promise<SaidAgent[]> {
  log('Fetching all SAID agents from API...');
  
  // Fetch from SAID API directory
  const res = await fetch(`${SAID_API}/api/a2a/agents?limit=2000`);
  if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
  
  const data = await res.json() as { agents?: SaidAgent[] };
  const agents = data.agents || [];
  
  log(`Found ${agents.length} total agents`);
  return agents;
}

async function filterAgentsWithoutNFT(agents: SaidAgent[]): Promise<SaidAgent[]> {
  // For now, we mint for ALL agents and track what's been minted via the log file
  // In production, check on-chain or DB for existing NFTs
  const alreadyMinted = new Set<string>();
  
  if (fs.existsSync(LOG_FILE)) {
    const existing = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) as MintResult[];
    for (const result of existing) {
      if (result.success) alreadyMinted.add(result.wallet);
    }
    log(`${alreadyMinted.size} agents already minted (from log file)`);
  }
  
  const remaining = agents.filter(a => !alreadyMinted.has(a.wallet));
  log(`${remaining.length} agents need NFTs`);
  return remaining;
}

async function mintNFT(umi: ReturnType<typeof getUmi>, agent: SaidAgent): Promise<MintResult> {
  try {
    const registrationDoc = buildRegistrationDocument(agent);
    // For batch mint, use the SAID website profile as URI
    const registrationUri = `${SAID_WEBSITE}/agents/${agent.wallet}`;

    const asset = generateSigner(umi);
    
    const createParams: Parameters<typeof createAsset>[1] = {
      asset,
      name: agent.name.slice(0, 32), // Metaplex name limit
      uri: registrationUri,
    };

    if (COLLECTION_ADDRESS) {
      try {
        await fetchCollection(umi, umiPublicKey(COLLECTION_ADDRESS));
        (createParams as Record<string, unknown>).collection = umiPublicKey(COLLECTION_ADDRESS);
      } catch {
        // Skip collection if not found
      }
    }

    await createAsset(umi, createParams).sendAndConfirm(umi);

    // Register identity
    const registerParams: Parameters<typeof registerIdentityV1>[1] = {
      asset: asset.publicKey,
      agentRegistrationUri: registrationUri,
    };

    if (COLLECTION_ADDRESS) {
      (registerParams as Record<string, unknown>).collection = umiPublicKey(COLLECTION_ADDRESS);
    }

    await registerIdentityV1(umi, registerParams).sendAndConfirm(umi);

    return {
      wallet: agent.wallet,
      name: agent.name,
      success: true,
      assetAddress: asset.publicKey.toString(),
    };
  } catch (error) {
    return {
      wallet: agent.wallet,
      name: agent.name,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log('=== SAID Batch Metaplex NFT Mint ===');
  log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  log(`Batch size: ${BATCH_SIZE}, Delay: ${DELAY_MS}ms`);

  const allAgents = await fetchAllAgents();
  const toMint = await filterAgentsWithoutNFT(allAgents);

  if (toMint.length === 0) {
    log('No agents need NFTs. Done.');
    return;
  }

  if (DRY_RUN) {
    log(`DRY RUN: Would mint ${toMint.length} NFTs`);
    log('First 5 agents:');
    for (const agent of toMint.slice(0, 5)) {
      log(`  - ${agent.name} (${agent.wallet.slice(0, 8)}...)`);
    }
    return;
  }

  const umi = getUmi();
  const results: MintResult[] = [];

  // Load existing results if resuming
  if (fs.existsSync(LOG_FILE)) {
    const existing = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) as MintResult[];
    results.push(...existing);
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < toMint.length; i += BATCH_SIZE) {
    const batch = toMint.slice(i, i + BATCH_SIZE);
    log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toMint.length / BATCH_SIZE)} (${batch.length} agents)`);

    for (const agent of batch) {
      log(`  Minting: ${agent.name} (${agent.wallet.slice(0, 8)}...)`);
      const result = await mintNFT(umi, agent);
      results.push(result);

      if (result.success) {
        success++;
        log(`  ✅ ${result.assetAddress}`);
      } else {
        failed++;
        log(`  ❌ ${result.error}`);
      }

      // Save progress after each mint (resumable)
      fs.writeFileSync(LOG_FILE, JSON.stringify(results, null, 2));
    }

    // Rate limit between batches
    if (i + BATCH_SIZE < toMint.length) {
      log(`  Waiting ${DELAY_MS}ms before next batch...`);
      await sleep(DELAY_MS);
    }
  }

  log('\n=== Results ===');
  log(`Total: ${toMint.length}`);
  log(`Success: ${success}`);
  log(`Failed: ${failed}`);
  log(`Log: ${LOG_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
