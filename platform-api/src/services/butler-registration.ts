/**
 * Butler Registration Service
 * 
 * Builds and submits sponsored SAID registration transactions directly,
 * bypassing the Protocol API's two-phase flow (which has blockhash expiry issues).
 * 
 * Flow:
 * 1. Store agent card on Protocol API (for metadata URI)
 * 2. Build register_agent + get_verified instructions locally
 * 3. Build transaction with fresh blockhash
 * 4. Sponsor partial signs (fee payer + funding transfer)
 * 5. Privy signs (agent wallet) and broadcasts
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
import { signTransaction } from './privy-wallets';

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

interface RegistrationResult {
  success: boolean;
  pda: string;
  txSignature: string;
  walletAddress: string;
  metadataUri: string;
  profile: string;
  badge: string;
  error?: string;
}

export async function registerButlerUser(
  walletAddress: string,
  privyWalletId: string,
  displayName: string,
  platform: string,
  externalId: string,
): Promise<RegistrationResult> {
  const agentPubkey = new PublicKey(walletAddress);
  const sponsor = getSponsorKeypair();

  // Compute PDA
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), agentPubkey.toBuffer()],
    SAID_PROGRAM_ID,
  );

  // Treasury PDA
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('treasury')],
    SAID_PROGRAM_ID,
  );

  const metadataUri = `https://api.saidprotocol.com/api/cards/${walletAddress}.json`;

  // Step 1: Store agent card on Protocol API
  const card = {
    name: displayName,
    description: `${displayName} — SAID Butler agent for ${platform}`,
    wallet: walletAddress,
    capabilities: ['messaging', 'assistant'],
    platform: 'said.hosting',
    verified: true,
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
    // Non-fatal — card can be stored later
    console.warn(`[butler-reg] Failed to store card for ${walletAddress}`);
  });

  // Step 2: Build register_agent instruction
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

  // Step 3: Build get_verified instruction
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

  // Step 4: Build funding transfer (sponsor → agent, 0.015 SOL)
  const FUND_AMOUNT = Math.ceil(0.015 * LAMPORTS_PER_SOL);

  const fundIx = SystemProgram.transfer({
    fromPubkey: sponsor.publicKey,
    toPubkey: agentPubkey,
    lamports: FUND_AMOUNT,
  });

  // Step 5: Build transaction with FRESH blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: sponsor.publicKey,
  });

  tx.add(fundIx);       // 1. Fund agent wallet
  tx.add(registerIx);   // 2. Register on-chain
  tx.add(verifyIx);     // 3. Verify (0.01 SOL → treasury)

  // Step 6: Sponsor signs
  tx.partialSign(sponsor);

  // Step 7: Serialize for Privy signing
  const serializedTx = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString('base64');

  // Step 8: Privy signs and broadcasts
  const txSignature = await signTransaction(privyWalletId, serializedTx);

  console.log(`[butler-reg] Registered+verified ON-CHAIN: ${walletAddress}, PDA=${pda.toString()}, tx=${txSignature}`);

  // Step 9: Update Protocol API database
  try {
    await fetch(`${SAID_API}/api/register/pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: walletAddress,
        name: displayName,
        description: `${displayName} — SAID Butler agent for ${platform}`,
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
    profile: `https://www.saidprotocol.com/agent.html?wallet=${walletAddress}`,
    badge: `https://api.saidprotocol.com/api/badge/${walletAddress}.svg`,
  };
}
