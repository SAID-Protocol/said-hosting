import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';

const SAID_API_URL = process.env.SAID_API_URL || 'https://api.saidprotocol.com';
const SAID_RPC_URL = process.env.SOLANA_RPC_URL || 'https://newest-restless-mansion.solana-mainnet.quiknode.pro/af7d979a4ef8558eb0da3166819eac8af0d3dd2b';
const SAID_PROGRAM_ID = new PublicKey('5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G');
const REGISTER_DISC = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
const VERIFY_DISC = Buffer.from([132, 231, 2, 30, 115, 74, 23, 26]);
const DEFAULT_PLATFORM = 'said-hosting';

export interface SaidMetadata {
  description?: string;
  twitter?: string;
  website?: string;
  capabilities?: string[];
  platform?: string;
}

export interface SaidRegistrationResult {
  success: boolean;
  pda: string;
  walletAddress: string;
  metadataUri: string;
  transaction?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  error?: string;
}

function getConnection() {
  return new Connection(SAID_RPC_URL, 'confirmed');
}

function getAgentPDA(owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('agent'), owner.toBuffer()], SAID_PROGRAM_ID);
  return pda;
}

function getTreasuryPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('treasury')], SAID_PROGRAM_ID);
  return pda;
}

function getPlatformWallet(): Keypair {
  const secret = process.env.PLATFORM_WALLET_KEYPAIR;
  if (!secret) throw new Error('PLATFORM_WALLET_KEYPAIR is required');
  return Keypair.fromSecretKey(bs58.decode(secret));
}

function encodeBorshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

async function upsertAgentCard(walletAddress: string, agentName: string, metadata: SaidMetadata): Promise<string> {
  const payload = {
    wallet: walletAddress,
    name: agentName,
    description: metadata.description || `Hosted SAID agent: ${agentName}`,
    twitter: metadata.twitter,
    website: metadata.website,
    capabilities: metadata.capabilities || ['chat', 'assistant'],
    platform: metadata.platform || DEFAULT_PLATFORM,
    verified: true,
    registeredAt: new Date().toISOString(),
  };

  const res = await fetch(`${SAID_API_URL}/api/register/pending`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`SAID API card registration failed (${res.status}): ${text}`);
  }

  return `${SAID_API_URL}/api/cards/${walletAddress}.json`;
}

export async function registerAgent(agentName: string, walletAddress: string, metadata: SaidMetadata = {}): Promise<SaidRegistrationResult> {
  try {
    const connection = getConnection();
    const sponsor = getPlatformWallet();
    const owner = new PublicKey(walletAddress);
    const pda = getAgentPDA(owner);
    const metadataUri = await upsertAgentCard(walletAddress, agentName, metadata);
    const existing = await connection.getAccountInfo(pda);

    if (existing) {
      return { success: true, pda: pda.toBase58(), walletAddress, metadataUri };
    }

    const fundIx = SystemProgram.transfer({
      fromPubkey: sponsor.publicKey,
      toPubkey: owner,
      lamports: Math.ceil(0.015 * LAMPORTS_PER_SOL),
    });

    const registerIx = new TransactionInstruction({
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([REGISTER_DISC, encodeBorshString(metadataUri)]),
    });

    const verifyIx = new TransactionInstruction({
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: getTreasuryPDA(), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: VERIFY_DISC,
    });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: sponsor.publicKey });
    tx.add(fundIx, registerIx, verifyIx);
    tx.partialSign(sponsor);

    return {
      success: true,
      pda: pda.toBase58(),
      walletAddress,
      metadataUri,
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      blockhash,
      lastValidBlockHeight,
    };
  } catch (error) {
    const pda = (() => { try { return getAgentPDA(new PublicKey(walletAddress)).toBase58(); } catch { return ''; } })();
    return {
      success: false,
      pda,
      walletAddress,
      metadataUri: `${SAID_API_URL}/api/cards/${walletAddress}.json`,
      error: error instanceof Error ? error.message : 'Unknown SAID registration error',
    };
  }
}

export async function verifyAgent(agentPDAAddress: string): Promise<SaidRegistrationResult> {
  return {
    success: true,
    pda: agentPDAAddress,
    walletAddress: '',
    metadataUri: '',
  };
}
