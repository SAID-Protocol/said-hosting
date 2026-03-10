#!/usr/bin/env node

/**
 * SAID Agent Identity Bootstrap
 *
 * Runs on container boot.
 * 1. Generates a Solana keypair on first boot (saved to persistent volume)
 * 2. Exports the public key for downstream shell scripts
 * 3. Registers on SAID Protocol (pending/free)
 * 4. If funded, does on-chain registration + verification
 */

import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.AGENT_DATA_DIR || '/data';
const WALLET_PATH = process.env.SAID_WALLET_PATH || path.join(DATA_DIR, 'wallet.json');
const STATUS_PATH = process.env.SAID_IDENTITY_STATUS_PATH || path.join(DATA_DIR, 'said-identity.json');
const ENV_PATH = process.env.SAID_IDENTITY_ENV_PATH || path.join(DATA_DIR, 'identity.env');
const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  'https://newest-restless-mansion.solana-mainnet.quiknode.pro/af7d979a4ef8558eb0da3166819eac8af0d3dd2b';
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
  return PublicKey.findProgramAddressSync([Buffer.from('agent'), owner.toBuffer()], PROGRAM_ID);
}

function getTreasuryPDA() {
  return PublicKey.findProgramAddressSync([Buffer.from('treasury')], PROGRAM_ID);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeIdentityEnv(wallet) {
  const content = [
    `SAID_IDENTITY_WALLET=${wallet}`,
    `SAID_WALLET_ADDRESS=${wallet}`,
    `SAID_WALLET_PATH=${WALLET_PATH}`,
    `SAID_IDENTITY_STATUS_PATH=${STATUS_PATH}`,
  ].join('\n') + '\n';

  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {}
  log(`Identity env written: ${ENV_PATH}`);
}

// Step 1: Generate or load keypair
function ensureKeypair() {
  ensureDataDir();

  if (fs.existsSync(WALLET_PATH)) {
    log(`Wallet exists, loading from ${WALLET_PATH}...`);
    const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
    const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    writeIdentityEnv(keypair.publicKey.toString());
    return { keypair, created: false };
  }

  log('Generating new Solana keypair...');
  const keypair = Keypair.generate();
  fs.mkdirSync(path.dirname(WALLET_PATH), { recursive: true });
  fs.writeFileSync(WALLET_PATH, JSON.stringify(Array.from(keypair.secretKey)));
  fs.chmodSync(WALLET_PATH, 0o600);
  writeIdentityEnv(keypair.publicKey.toString());
  log(`Wallet created: ${keypair.publicKey.toString()}`);
  return { keypair, created: true };
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
    }
    if (res.status === 409) {
      log('Already registered on SAID API');
      return { success: true, existing: true };
    }

    log(`Registration note: ${data.error || 'unknown'}`);
    return { success: false, error: data.error };
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

  const [agentPDA] = getAgentPDA(owner);
  const acct = await connection.getAccountInfo(agentPDA);
  if (acct) {
    log('Already registered on-chain');
    return { success: true, existing: true };
  }

  const balance = await connection.getBalance(owner);
  const needed = 0.005 * 1e9;
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
  ensureDataDir();
  fs.writeFileSync(
    STATUS_PATH,
    JSON.stringify(
      {
        wallet,
        ...status,
        walletPath: WALLET_PATH,
        envPath: ENV_PATH,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

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

async function main() {
  log('=== SAID Identity Bootstrap ===');
  log(`Agent: ${AGENT_NAME}`);

  const { keypair, created } = ensureKeypair();
  const wallet = keypair.publicKey.toString();
  process.env.SAID_IDENTITY_WALLET = wallet;
  process.env.SAID_WALLET_ADDRESS = wallet;

  log(`Wallet: ${wallet}`);
  log(created ? 'Wallet generated on this boot.' : 'Wallet already present; bootstrap is idempotent.');

  const status = {
    wallet,
    created,
    registered: false,
    onChain: false,
    verified: false,
  };

  const apiResult = await registerOnAPI(wallet);
  status.registered = apiResult.success;

  const chainResult = await registerOnChain(keypair);
  status.onChain = chainResult.success;

  if (status.onChain) {
    const verifyResult = await getVerified(keypair);
    status.verified = verifyResult.success;
  }

  await reportStatus(wallet, status);

  log('=== Bootstrap complete ===');
  log(`  Registered: ${status.registered ? '✅' : '❌'}`);
  log(`  On-chain:   ${status.onChain ? '✅' : '⏳ (fund wallet with ~0.02 SOL)'}`);
  log(`  Verified:   ${status.verified ? '✅' : '⏳ (needs on-chain first)'}`);
  console.log(`SAID_IDENTITY_WALLET=${wallet}`);
}

main().catch(async (err) => {
  log(`Bootstrap error: ${err.message}`);

  try {
    if (fs.existsSync(WALLET_PATH)) {
      const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
      const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
      const wallet = keypair.publicKey.toString();
      writeIdentityEnv(wallet);
      await reportStatus(wallet, {
        wallet,
        created: false,
        registered: false,
        onChain: false,
        verified: false,
        error: err.message,
      });
      console.log(`SAID_IDENTITY_WALLET=${wallet}`);
    }
  } catch (reportErr) {
    log(`Failed to write fallback identity state: ${reportErr.message}`);
  }

  process.exit(0);
});
