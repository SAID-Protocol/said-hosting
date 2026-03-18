/**
 * REST Agent Example
 * Simple request/response messaging
 */

import { SAIDAgent } from '@said-protocol/a2a';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';

// Load wallet
const keypairPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));

// Create agent in REST mode (no persistent connection)
const agent = new SAIDAgent({
  keypair,
  mode: 'rest',
});

// Get recipient from command line
const recipientAddress = process.argv[2];
const message = process.argv[3] || 'Hello from REST agent!';

if (!recipientAddress) {
  console.error('Usage: node rest-agent.js <RECIPIENT_ADDRESS> [MESSAGE]');
  process.exit(1);
}

// Send message
console.log(`📤 Sending to ${recipientAddress}...`);
console.log(`   Message: "${message}"`);

try {
  await agent.send(recipientAddress, message);
  console.log('✅ Message sent!');
} catch (err) {
  console.error('❌ Failed to send:', err.message);
  process.exit(1);
}
