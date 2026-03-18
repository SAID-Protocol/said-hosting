/**
 * Agent Discovery Example
 * Find and message other agents by capability
 */

import { SAIDAgent } from '@said-protocol/a2a';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';

// Load wallet
const keypairPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));

// Create agent
const agent = new SAIDAgent({
  keypair,
  mode: 'rest', // Discovery works in both modes
});

// Search query from command line
const query = process.argv[2] || 'trading';

console.log(`🔍 Searching for agents: "${query}"\\n`);

try {
  // Discover agents
  const agents = await agent.discover(query, {
    verified: true, // Only verified agents
    chain: 'solana', // Solana agents only
  });

  if (agents.length === 0) {
    console.log('No agents found.');
    process.exit(0);
  }

  console.log(`Found ${agents.length} agent(s):\\n`);

  // Display results
  agents.forEach((a, i) => {
    console.log(`${i + 1}. ${a.name}`);
    console.log(`   Address: ${a.address}`);
    console.log(`   Verified: ${a.verified ? '✓' : '✗'}`);
    console.log(`   Capabilities: ${a.capabilities?.join(', ') || 'N/A'}`);
    if (a.description) {
      console.log(`   Description: ${a.description}`);
    }
    console.log('');
  });

  // Example: Send message to first agent
  const firstAgent = agents[0];
  const sendMessage = process.env.SEND_MESSAGE === 'true';

  if (sendMessage) {
    console.log(`📤 Sending test message to ${firstAgent.name}...`);
    await agent.send(
      firstAgent.address,
      `Hi ${firstAgent.name}! I found you via discovery search.`
    );
    console.log('✅ Message sent!');
  } else {
    console.log('💡 To send a message to the first agent, run:');
    console.log(`   SEND_MESSAGE=true node discovery.js "${query}"`);
  }
} catch (err) {
  console.error('❌ Discovery failed:', err.message);
  process.exit(1);
}
