#!/usr/bin/env node

/**
 * SAID Agent Identity Bootstrap
 * 
 * Runs on first boot inside the container.
 * 1. Generates a Solana keypair (saved to persistent volume)
 * 2. Registers on SAID Protocol (pending/free)
 * 3. Writes public key to a status file for the Platform API to read
 * 4. If funded, does on-chain registration + verification
 */

import { Keypair, Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.AGENT_DATA_DIR || '/agent/data';
const WALLET_PATH = path.join(DATA_DIR, 'wallet.json');
const STATUS_PATH = path.join(DATA_DIR, 'said-identity.json');
const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PROGRAM_ID = new PublicKey('5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G');

const AGENT_NAME = process.env.SAID_AGENT_NAME || 'SAID Agent';
const AGENT_DESCRIPTION = process.env.SAID_AGENT_DESCRIPTION || `Hosted SAID agent: ${AGENT_NAME}`;

function log(msg) {
  console.log(`[said-bootstrap] ${msg}`);
}

function getDiscriminator(name) {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}

function getAgentPDA(owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), owner.toBuffer()],
    PROGRAM_ID
  );
}

function getTreasuryPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury')],
    PROGRAM_ID
  );
}

// Step 1: Generate or load keypair
function ensureKeypair() {
  if (fs.existsSync(WALLET_PATH)) {
    log('Wallet exists, loading...');
    const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }

  log('Generating new Solana keypair...');
  const keypair = Keypair.generate();
  fs.mkdirSync(path.dirname(WALLET_PATH), { recursive: true });
  fs.writeFileSync(WALLET_PATH, JSON.stringify(Array.from(keypair.secretKey)));
  fs.chmodSync(WALLET_PATH, 0o600); // Owner read/write only
  log(`Wallet created: ${keypair.publicKey.toString()}`);
  return keypair;
}

// Step 2: Register on SAID API (free, off-chain)
async function registerOnAPI(wallet) {
  log('Registering on SAID Protocol...');
  try {
    const res = await fetch(`${SAID_API}/api/register/pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet,
        name: AGENT_NAME,
        description: AGENT_DESCRIPTION,
      }),
    });

    const data = await res.json();
    if (res.ok && data.success) {
      log(`SAID identity registered (pending): PDA ${data.pda || 'N/A'}`);
      return { success: true, pda: data.pda, profile: data.profile };
    } else if (res.status === 409) {
      log('Already registered on SAID API');
      return { success: true, existing: true };
    } else {
      log(`Registration note: ${data.error || 'unknown'}`);
      return { success: false, error: data.error };
    }
  } catch (err) {
    log(`Registration failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Step 3: On-chain registration (requires SOL)
async function registerOnChain(keypair) {
  const connection = new Connection(RPC_URL, 'confirmed');
  const owner = keypair.publicKey;
  const wallet = owner.toString();

  // Check if already registered
  const [agentPDA] = getAgentPDA(owner);
  const acct = await connection.getAccountInfo(agentPDA);
  if (acct) {
    log('Already registered on-chain');
    return { success: true, existing: true };
  }

  // Check balance
  const balance = await connection.getBalance(owner);
  const needed = 0.005 * 1e9; // ~0.005 SOL for registration
  if (balance < needed) {
    log(`Insufficient SOL for on-chain registration (have ${(balance / 1e9).toFixed(4)}, need ~0.005)`);
    return { success: false, error: 'insufficient_funds' };
  }

  log('Submitting on-chain registration...');
  const metadataUri = `${SAID_API}/api/cards/${wallet}.json`;
  const discriminator = getDiscriminator('global:register_agent');
  const uriBytes = Buffer.from(metadataUri, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(uriBytes.length, 0);
  const data = Buffer.concat([discriminator, lenBuf, uriBytes]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: agentPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);

  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  log(`On-chain registration tx: ${sig}`);
  return { success: true, signature: sig };
}

// Step 4: Verification (requires 0.01 SOL)
async function getVerified(keypair) {
  const connection = new Connection(RPC_URL, 'confirmed');
  const owner = keypair.publicKey;

  const [agentPDA] = getAgentPDA(owner);
  const [treasuryPDA] = getTreasuryPDA();

  // Check balance
  const balance = await connection.getBalance(owner);
  const cost = 0.01 * 1e9;
  if (balance < cost + 5000) {
    log(`Insufficient SOL for verification (have ${(balance / 1e9).toFixed(4)}, need ~0.01)`);
    return { success: false, error: 'insufficient_funds' };
  }

  log('Submitting verification tx (0.01 SOL)...');
  const discriminator = getDiscriminator('global:get_verified');

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: agentPDA, isSigner: false, isWritable: true },
      { pubkey: treasuryPDA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);

  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  log(`Verification tx: ${sig}`);
  return { success: true, signature: sig };
}

// Step 5: Report status back to Platform API
async function reportStatus(wallet, status) {
  // Write locally for the dashboard/terminal to read
  fs.writeFileSync(STATUS_PATH, JSON.stringify({
    wallet,
    ...status,
    updatedAt: new Date().toISOString(),
  }, null, 2));

  // Report to Platform API if configured
  const platformApi = process.env.SAID_PLATFORM_API;
  const agentId = process.env.SAID_AGENT_ID;
  const apiKey = process.env.SAID_PLATFORM_API_KEY;

  if (platformApi && agentId && apiKey) {
    try {
      await fetch(`${platformApi}/api/agents/${agentId}/identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ wallet, ...status }),
      });
      log('Reported identity to Platform API');
    } catch (err) {
      log(`Failed to report to Platform API: ${err.message}`);
    }
  }
}

// Main
async function main() {
  log('=== SAID Identity Bootstrap ===');
  log(`Agent: ${AGENT_NAME}`);

  // 1. Keypair
  const keypair = ensureKeypair();
  const wallet = keypair.publicKey.toString();
  log(`Wallet: ${wallet}`);

  const status = {
    wallet,
    registered: false,
    onChain: false,
    verified: false,
  };

  // 2. API registration (always free)
  const apiResult = await registerOnAPI(wallet);
  status.registered = apiResult.success;

  // 3. On-chain registration (if funded)
  const chainResult = await registerOnChain(keypair);
  status.onChain = chainResult.success;

  // 4. Verification (if funded and registered on-chain)
  if (status.onChain) {
    const verifyResult = await getVerified(keypair);
    status.verified = verifyResult.success;
  }

  // 5. Report
  await reportStatus(wallet, status);

  log('=== Bootstrap complete ===');
  log(`  Registered: ${status.registered ? '✅' : '❌'}`);
  log(`  On-chain:   ${status.onChain ? '✅' : '⏳ (fund wallet with ~0.02 SOL)'}`);
  log(`  Verified:   ${status.verified ? '✅' : '⏳ (needs on-chain first)'}`);
}

main().catch(err => {
  log(`Bootstrap error: ${err.message}`);
  process.exit(0); // Don't crash the container — agent can still run without identity
});
