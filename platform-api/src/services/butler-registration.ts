/**
 * Butler Registration Service
 * 
 * Two separate on-chain operations:
 * 
 * 1. registerAgent() — Sponsored by us (costs dust ~0.002 SOL)
 *    - Stores agent card on Protocol API
 *    - Builds register_agent instruction
 *    - Sponsor pays gas + rent, Privy signs as agent
 *    - Agent shows in directory as REGISTERED
 * 
 * 2. verifyAgent() — Paid from agent's own wallet (~0.013 SOL total)
 *    - Builds get_verified instruction (0.01 SOL → treasury)
 *    - Mints Metaplex NFT (~0.003 SOL)
 *    - Agent wallet pays everything
 *    - Agent upgrades to VERIFIED + gets NFT
 * 
 * Triggered by deposit monitor when user funds the agent wallet.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { signTransactionOnly } from './privy-wallets';

const SAID_PROGRAM_ID = new PublicKey('5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G');
const SAID_API = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
const SAID_PLATFORM_KEY = process.env.SAID_HOSTING_API_KEY || '';
const SOLANA_RPC = process.env.SOLANA_RPC_URL;

if (!SOLANA_RPC) throw new Error('SOLANA_RPC_URL required');

const connection = new Connection(SOLANA_RPC, 'confirmed');

function getSponsorKeypair(): Keypair {
  const encoded = process.env.FUNDING_WALLET_KEYPAIR;
  if (!encoded) throw new Error('FUNDING_WALLET_KEYPAIR required for sponsored registration');
  return Keypair.fromSecretKey(bs58.decode(encoded));
}

function computePda(agentPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), agentPubkey.toBuffer()],
    SAID_PROGRAM_ID,
  );
}

function computeTreasuryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury')],
    SAID_PROGRAM_ID,
  );
}

// ─── Store agent card on Protocol API ───────────────────────────────────────

async function storeAgentCard(
  walletAddress: string,
  displayName: string,
  platform: string,
  verified: boolean = false,
): Promise<void> {
  const card = {
    name: displayName,
    description: `${displayName} — SAID agent on ${platform}`,
    wallet: walletAddress,
    capabilities: ['messaging', 'assistant'],
    platform: 'said.hosting',
    verified,
    registeredAt: new Date().toISOString(),
  };

  await fetch(`${SAID_API}/api/cards/${walletAddress}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-Key': SAID_PLATFORM_KEY,
    },
    body: JSON.stringify({ cardJson: JSON.stringify(card) }),
  }).catch(() => {
    console.warn(`[butler-reg] Failed to store card for ${walletAddress}`);
  });
}

// ─── 1. Register Agent (sponsored, dust cost) ──────────────────────────────

export interface RegisterResult {
  success: boolean;
  pda: string;
  txSignature: string;
  walletAddress: string;
  metadataUri: string;
  profile: string;
  badge: string;
  error?: string;
}

export async function registerAgent(
  walletAddress: string,
  privyWalletId: string,
  displayName: string,
  platform: string,
  externalId: string,
): Promise<RegisterResult> {
  const agentPubkey = new PublicKey(walletAddress);
  const sponsor = getSponsorKeypair();
  const [pda] = computePda(agentPubkey);
  const metadataUri = `https://api.saidprotocol.com/api/cards/${walletAddress}.json`;

  // Store card on Protocol API
  await storeAgentCard(walletAddress, displayName, platform, false);

  // Build register_agent instruction
  const registerDiscriminator = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
  const uriBytes = Buffer.from(metadataUri, 'utf8');
  const uriLen = Buffer.alloc(4);
  uriLen.writeUInt32LE(uriBytes.length);
  const registerData = Buffer.concat([registerDiscriminator, uriLen, uriBytes]);

  const registerIx = new TransactionInstruction({
    programId: SAID_PROGRAM_ID,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: agentPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: registerData,
  });

  // Sponsor funds the rent (~0.002 SOL) for the PDA account
  const RENT_FUND = Math.ceil(0.005 * LAMPORTS_PER_SOL);
  const fundIx = SystemProgram.transfer({
    fromPubkey: sponsor.publicKey,
    toPubkey: agentPubkey,
    lamports: RENT_FUND,
  });

  // Build tx with fresh blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: sponsor.publicKey });

  tx.add(fundIx);       // 1. Fund agent for rent
  tx.add(registerIx);   // 2. Register on-chain

  // Sponsor signs (fee payer + funding)
  tx.partialSign(sponsor);

  // Serialize for Privy signing
  const serializedTx = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString('base64');

  // Privy signs as agent wallet
  const signedTxBase64 = await signTransactionOnly(privyWalletId, serializedTx);

  // Broadcast
  const signedTxBuffer = Buffer.from(signedTxBase64, 'base64');
  const signedTx = Transaction.from(signedTxBuffer);

  // Simulate first to get detailed logs
  try {
    const simulateResult = await connection.simulateTransaction(signedTx);
    if (simulateResult.value.err) {
      console.error('[butler-reg] Simulation logs:', simulateResult.value.logs);
      throw new Error(`Simulation failed: ${JSON.stringify(simulateResult.value.err)}\nLogs: ${simulateResult.value.logs?.join('\n')}`);
    }
  } catch (simErr: any) {
    console.error('[butler-reg] Full sim error:', simErr.message);
    throw simErr;
  }

  const txSignature = await connection.sendRawTransaction(signedTxBuffer, {
    skipPreflight: true,
    maxRetries: 3,
  });

  await connection.confirmTransaction(
    { signature: txSignature, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  console.log(`[butler-reg] Registered ON-CHAIN: ${walletAddress}, PDA=${pda.toString()}, tx=${txSignature}`);

  // Update Protocol API database
  try {
    await fetch(`${SAID_API}/api/register/pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: walletAddress,
        name: displayName,
        description: `${displayName} — SAID agent on ${platform}`,
        capabilities: ['messaging', 'assistant'],
        source: 'butler',
      }),
    });
  } catch {
    console.warn(`[butler-reg] Failed to update Protocol API DB for ${walletAddress}`);
  }

  return {
    success: true,
    pda: pda.toString(),
    txSignature,
    walletAddress,
    metadataUri,
    profile: `https://www.saidprotocol.com/agents/${walletAddress}`,
    badge: `https://api.saidprotocol.com/api/badge/${walletAddress}.svg`,
  };
}

// ─── 2. Verify Agent (paid from agent wallet, ~0.013 SOL) ──────────────────

export interface VerifyResult {
  success: boolean;
  pda: string;
  verifyTxSignature: string;
  walletAddress: string;
  profile: string;
  badge: string;
  nftMinted: boolean;
  error?: string;
}

export async function verifyAgent(
  walletAddress: string,
  privyWalletId: string,
  displayName: string,
  platform: string,
): Promise<VerifyResult> {
  const agentPubkey = new PublicKey(walletAddress);
  const [pda] = computePda(agentPubkey);
  const [treasuryPda] = computeTreasuryPda();

  // Build get_verified instruction (0.01 SOL → treasury)
  const verifyDiscriminator = Buffer.from([132, 231, 2, 30, 115, 74, 23, 26]);
  const verifyIx = new TransactionInstruction({
    programId: SAID_PROGRAM_ID,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: agentPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: verifyDiscriminator,
  });

  // Agent wallet is fee payer (they funded it)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: agentPubkey });

  tx.add(verifyIx);

  // Serialize for Privy signing (agent wallet pays for everything)
  const serializedTx = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString('base64');

  const signedTxBase64 = await signTransactionOnly(privyWalletId, serializedTx);

  const signedTxBuffer = Buffer.from(signedTxBase64, 'base64');
  const verifyTxSignature = await connection.sendRawTransaction(signedTxBuffer, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(
    { signature: verifyTxSignature, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  console.log(`[butler-reg] Verified ON-CHAIN: ${walletAddress}, PDA=${pda.toString()}, tx=${verifyTxSignature}`);

  // Update card to verified
  await storeAgentCard(walletAddress, displayName, platform, true);

  // TODO: Mint Metaplex NFT here
  // For now, log that we need to add this
  let nftMinted = false;
  console.log(`[butler-reg] TODO: Mint Metaplex NFT for ${walletAddress}`);

  return {
    success: true,
    pda: pda.toString(),
    verifyTxSignature,
    walletAddress,
    profile: `https://www.saidprotocol.com/agents/${walletAddress}`,
    badge: `https://api.saidprotocol.com/api/badge/${walletAddress}.svg`,
    nftMinted,
  };
}

// Legacy export for backward compat
export const registerButlerUser = registerAgent;
