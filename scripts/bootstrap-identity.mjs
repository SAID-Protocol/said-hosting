#!/usr/bin/env node

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.AGENT_DATA_DIR || '/data';
const WALLET_PATH = process.env.SAID_WALLET_PATH || path.join(DATA_DIR, 'wallet.json');
const STATUS_PATH = process.env.SAID_IDENTITY_STATUS_PATH || path.join(DATA_DIR, 'said-identity.json');
const ENV_PATH = process.env.SAID_IDENTITY_ENV_PATH || path.join(DATA_DIR, 'identity.env');
const PLATFORM_API = process.env.SAID_PLATFORM_API;
const PLATFORM_API_KEY = process.env.SAID_PLATFORM_API_KEY;
const AGENT_ID = process.env.SAID_AGENT_ID;
const AGENT_NAME = process.env.SAID_AGENT_NAME || 'SAID Agent';

function log(msg) {
  console.log(`[said-bootstrap] ${msg}`);
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
}

function writeStatus(status) {
  ensureDataDir();
  fs.writeFileSync(
    STATUS_PATH,
    JSON.stringify(
      {
        ...status,
        walletPath: WALLET_PATH,
        envPath: ENV_PATH,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

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

function requirePlatformConfig() {
  if (!PLATFORM_API || !PLATFORM_API_KEY || !AGENT_ID) {
    throw new Error('SAID_PLATFORM_API, SAID_PLATFORM_API_KEY, and SAID_AGENT_ID are required');
  }
}

async function platformPost(pathname, body) {
  requirePlatformConfig();

  const res = await fetch(`${PLATFORM_API}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': PLATFORM_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(data.error || `Platform API error ${res.status}`);
  }

  return data;
}

async function registerHostedIdentity(keypair) {
  const wallet = keypair.publicKey.toString();
  const result = {
    wallet,
    agentId: AGENT_ID,
    agentName: AGENT_NAME,
    registered: false,
    saidPda: null,
    registrationSignature: null,
    funding: null,
  };

  // Retry logic for blockhash expiration
  const maxRetries = 2;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const registerRes = await platformPost(`/api/agents/${AGENT_ID}/register-said`, {
        walletAddress: wallet,
      });

      const unsigned = registerRes.unsignedTransaction;
      if (!unsigned || typeof unsigned !== 'string') {
        throw new Error('Platform API did not return unsignedTransaction');
      }

      const tx = VersionedTransaction.deserialize(Buffer.from(unsigned, 'base64'));
      tx.sign([keypair]);
      const signedTransaction = Buffer.from(tx.serialize()).toString('base64');

      const confirmRes = await platformPost(`/api/agents/${AGENT_ID}/confirm-said`, {
        signedTransaction,
      });

      result.registered = true;
      result.saidPda = confirmRes.saidPda || confirmRes.agent?.saidPda || null;
      result.registrationSignature = confirmRes.signature || null;
      result.funding = confirmRes.funding || null;

      writeStatus(result);
      log(`SAID hosted registration complete${result.saidPda ? `: ${result.saidPda}` : ''}`);
      return; // Success!
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown registration error';
      
      // Check if blockhash expired and we can retry
      if (errorMsg.includes('BLOCKHASH_EXPIRED') && attempt < maxRetries - 1) {
        log(`SAID registration expired (attempt ${attempt + 1}/${maxRetries}), retrying...`);
        continue; // Retry from register
      }
      
      // Final error
      result.error = errorMsg;
      writeStatus(result);
      log(`SAID registration failed (continuing boot): ${result.error}`);
      return;
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

  await registerHostedIdentity(keypair);

  console.log(`SAID_IDENTITY_WALLET=${wallet}`);
}

main().catch((err) => {
  log(`Bootstrap error: ${err.message}`);
  try {
    if (fs.existsSync(WALLET_PATH)) {
      const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
      const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
      const wallet = keypair.publicKey.toString();
      writeIdentityEnv(wallet);
      writeStatus({
        wallet,
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        registered: false,
        saidPda: null,
        registrationSignature: null,
        funding: null,
        error: err.message,
      });
      console.log(`SAID_IDENTITY_WALLET=${wallet}`);
    }
  } catch (reportErr) {
    log(`Failed to write fallback identity state: ${reportErr.message}`);
  }

  process.exit(0);
});
