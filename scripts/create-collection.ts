/**
 * Create the SAID Agent Collection on Metaplex Core
 * Run once to create the collection, then set METAPLEX_AGENT_COLLECTION env var
 * 
 * Usage: npx ts-node scripts/create-collection.ts
 * Requires: SPONSOR_PRIVATE_KEY or PLATFORM_WALLET_KEYPAIR env var
 */

import 'dotenv/config';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, createCollection } from '@metaplex-foundation/mpl-core';
import { generateSigner, keypairIdentity } from '@metaplex-foundation/umi';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ||
  'https://newest-restless-mansion.solana-mainnet.quiknode.pro/af7d979a4ef8558eb0da3166819eac8af0d3dd2b';

async function main() {
  const encoded = process.env.SPONSOR_PRIVATE_KEY || process.env.PLATFORM_WALLET_KEYPAIR;
  if (!encoded) {
    console.error('Set SPONSOR_PRIVATE_KEY or PLATFORM_WALLET_KEYPAIR');
    process.exit(1);
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(encoded));
  console.log(`Using wallet: ${keypair.publicKey.toString()}`);

  const umi = createUmi(SOLANA_RPC_URL)
    .use(mplCore());

  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
  umi.use(keypairIdentity(umiKeypair));

  const collection = generateSigner(umi);
  
  console.log('Creating SAID Agent Collection...');
  console.log(`Collection address: ${collection.publicKey}`);

  const result = await createCollection(umi, {
    collection,
    name: 'SAID Protocol Agents',
    uri: 'https://api.saidprotocol.com/api/collection.json',
  }).sendAndConfirm(umi);

  console.log(`\n✅ Collection created!`);
  console.log(`Address: ${collection.publicKey}`);
  console.log(`Signature: ${bs58.encode(result.signature)}`);
  console.log(`\nSet this in your env:`);
  console.log(`METAPLEX_AGENT_COLLECTION=${collection.publicKey}`);
}

main().catch(console.error);
