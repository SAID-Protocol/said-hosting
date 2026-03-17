/**
 * Batch Mint Metaplex NFTs for all existing SAID agents
 * 
 * Usage: npx tsx scripts/batch-mint-nfts.ts [--dry-run] [--limit N] [--offset N]
 * 
 * Requires env vars:
 *   PLATFORM_WALLET_KEYPAIR — bs58 encoded keypair (payer + authority)
 *   SOLANA_RPC_URL — QuickNode or similar
 *   METAPLEX_AGENT_COLLECTION — collection address (optional)
 *   SAID_API_URL — defaults to https://api.saidprotocol.com
 *   DATABASE_URL — hosting platform database (to update records)
 * 
 * Strategy:
 *   1. Fetch all agents from SAID API that don't have passportMint
 *   2. For each agent: create MPL Core asset + register identity
 *   3. Update SAID API with passportMint address
 *   4. Log results to batch-mint-results.json
 * 
 * Rate limiting: 2 transactions per second to avoid RPC throttling
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
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://newest-restless-mansion.solana-mainnet.quiknode.pro/af7d979a4ef8558eb0da3166819eac8af0d3dd2b';
const COLLECTION_ADDRESS = process.env.METAPLEX_AGENT_COLLECTION;
const SAID_PROGRAM_ID = '5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G';
const RESULTS_FILE = './batch-mint-results.json';
const DELAY_MS = 500; // 2 tx/sec

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = parseInt(args.find((_, i) => args[i - 1] === '--limit') || '0') || 0;
const OFFSET = parseInt(args.find((_, i) => args[i - 1] === '--offset') || '0') || 0;

interface Agent {
  wallet: string;
  name: string;
  description: string;
  passportMint: string | null;
  skills: string[];
  registrationSource: string | null;
}

interface MintResult {
  wallet: string;
  name: string;
  assetAddress?: string;
  registrationUri?: string;
  signature?: string;
  error?: string;
  timestamp: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildRegistrationDocument(agent: Agent): Record<string, unknown> {
  return {
    type: 'agent-registration-v1',
    name: agent.name,
    description: agent.description,
    image: `${SAID_API}/api/agents/${agent.wallet}/avatar`,
    services: [
      {
        name: 'web',
        endpoint: `https://www.saidprotocol.com/agents/${agent.wallet}`,
      },
      {
        name: 'A2A',
        endpoint: `${SAID_API}/api/a2a/agents/${agent.wallet}`,
        version: '1.2.0',
      },
    ],
    active: true,
    registrations: [
      {
        agentId: agent.wallet,
        agentRegistry: `solana:mainnet:${SAID_PROGRAM_ID}`,
      },
    ],
    supportedTrust: ['reputation', 'crypto-economic'],
    metadata: {
      capabilities: agent.skills.length > 0 ? agent.skills : ['messaging'],
      platform: agent.registrationSource || 'said-protocol',
      protocol: 'said-protocol',
    },
  };
}

async function fetchAgentsWithoutNFT(): Promise<Agent[]> {
  const agents: Agent[] = [];
  let offset = OFFSET;
  const batchSize = 100;

  console.log(`[batch-mint] Fetching agents without NFTs from SAID API...`);

  while (true) {
    const res = await fetch(`${SAID_API}/api/agents?limit=${batchSize}&offset=${offset}`);
    const data = await res.json() as { agents: Agent[]; total: number };

    const needsNFT = data.agents.filter(a => !a.passportMint);
    agents.push(...needsNFT);

    console.log(`[batch-mint] Batch ${offset}-${offset + batchSize}: ${needsNFT.length}/${data.agents.length} need NFTs`);

    offset += batchSize;
    if (offset >= data.total || data.agents.length < batchSize) break;
    if (LIMIT > 0 && agents.length >= LIMIT) break;

    await sleep(100); // Rate limit API calls
  }

  const result = LIMIT > 0 ? agents.slice(0, LIMIT) : agents;
  console.log(`[batch-mint] Total agents needing NFTs: ${result.length}`);
  return result;
}

async function updateSaidApiWithNFT(wallet: string, assetAddress: string, txHash: string): Promise<void> {
  try {
    // Use the SAID API's internal endpoint to update passport
    const res = await fetch(`${SAID_API}/api/agents/${wallet}/passport`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Platform-Key': process.env.SAID_HOSTING_API_KEY || '',
      },
      body: JSON.stringify({
        passportMint: assetAddress,
        passportTxHash: txHash,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[batch-mint] Failed to update SAID API for ${wallet}: ${text}`);
    }
  } catch (error) {
    console.warn(`[batch-mint] SAID API update error for ${wallet}:`, error);
  }
}

async function main() {
  console.log(`[batch-mint] SAID Agent Batch NFT Minting`);
  console.log(`[batch-mint] Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`[batch-mint] RPC: ${SOLANA_RPC_URL.slice(0, 50)}...`);
  if (COLLECTION_ADDRESS) console.log(`[batch-mint] Collection: ${COLLECTION_ADDRESS}`);
  if (LIMIT) console.log(`[batch-mint] Limit: ${LIMIT}`);
  console.log('');

  // Load existing results
  let results: MintResult[] = [];
  if (fs.existsSync(RESULTS_FILE)) {
    results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    console.log(`[batch-mint] Loaded ${results.length} existing results`);
  }
  const alreadyMinted = new Set(results.filter(r => r.assetAddress).map(r => r.wallet));

  // Fetch agents
  const agents = await fetchAgentsWithoutNFT();
  const toMint = agents.filter(a => !alreadyMinted.has(a.wallet));
  console.log(`[batch-mint] ${toMint.length} agents to mint (${alreadyMinted.size} already done in previous runs)`);

  if (DRY_RUN) {
    console.log(`[batch-mint] DRY RUN — would mint ${toMint.length} NFTs`);
    console.log(`[batch-mint] First 5:`);
    toMint.slice(0, 5).forEach(a => console.log(`  - ${a.name} (${a.wallet.slice(0, 8)}...)`));
    return;
  }

  // Setup UMI
  const encoded = process.env.PLATFORM_WALLET_KEYPAIR;
  if (!encoded) {
    console.error('[batch-mint] PLATFORM_WALLET_KEYPAIR is required');
    process.exit(1);
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(encoded));
  const umi = createUmi(SOLANA_RPC_URL)
    .use(mplCore())
    .use(mplAgentIdentity());

  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
  umi.use(keypairIdentity(umiKeypair));

  console.log(`[batch-mint] Payer: ${keypair.publicKey.toString()}`);
  console.log(`[batch-mint] Starting batch mint of ${toMint.length} NFTs...`);
  console.log('');

  let minted = 0;
  let failed = 0;

  for (const agent of toMint) {
    try {
      console.log(`[${minted + failed + 1}/${toMint.length}] Minting NFT for ${agent.name} (${agent.wallet.slice(0, 8)}...)...`);

      // Build registration doc
      const registrationDoc = buildRegistrationDocument(agent);
      const registrationUri = `https://www.saidprotocol.com/agents/${agent.wallet}`;

      // Create MPL Core asset
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
          // Collection not found, skip
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

      const registerResult = await registerIdentityV1(umi, registerParams).sendAndConfirm(umi);
      const signature = bs58.encode(registerResult.signature);

      // Update SAID API
      await updateSaidApiWithNFT(agent.wallet, asset.publicKey.toString(), signature);

      const result: MintResult = {
        wallet: agent.wallet,
        name: agent.name,
        assetAddress: asset.publicKey.toString(),
        registrationUri,
        signature,
        timestamp: new Date().toISOString(),
      };
      results.push(result);
      minted++;

      console.log(`  ✅ Asset: ${asset.publicKey.toString().slice(0, 12)}... | Sig: ${signature.slice(0, 12)}...`);

      // Save progress every 10 mints
      if (minted % 10 === 0) {
        fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
        console.log(`  [checkpoint] Saved ${results.length} results`);
      }

      await sleep(DELAY_MS);
    } catch (error) {
      failed++;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.log(`  ❌ Failed: ${errorMsg}`);

      results.push({
        wallet: agent.wallet,
        name: agent.name,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });

      // If too many failures in a row, abort
      if (failed > 10 && failed > minted) {
        console.error(`[batch-mint] Too many failures (${failed}). Aborting.`);
        break;
      }

      await sleep(DELAY_MS * 2); // Extra delay after failure
    }
  }

  // Save final results
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

  console.log('');
  console.log(`[batch-mint] === COMPLETE ===`);
  console.log(`[batch-mint] Minted: ${minted}`);
  console.log(`[batch-mint] Failed: ${failed}`);
  console.log(`[batch-mint] Results saved to ${RESULTS_FILE}`);
}

main().catch(console.error);
