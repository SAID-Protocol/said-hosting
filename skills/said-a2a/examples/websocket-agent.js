/**
 * WebSocket Agent Example
 * Demonstrates real-time messaging with loop prevention
 */

import { SAIDAgent, shouldReply } from '@said-protocol/a2a';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';

// Load wallet from file
const keypairPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));

// Create agent with 60s cooldown
const agent = new SAIDAgent({
  keypair,
  mode: 'websocket',
  cooldownMs: 60000, // 60 seconds between auto-replies
  enableCooldown: true,
});

// Handle incoming messages
agent.on('message', async (msg) => {
  console.log(`\\n📨 From ${msg.from.name} (${msg.from.verified ? '✓ verified' : '✗ unverified'}):`);
  console.log(`   "${msg.message}"`);
  
  // Layer 1: Pattern-based judgment
  if (!shouldReply(msg.message)) {
    console.log('   → No reply needed (sign-off detected)');
    return;
  }
  
  // Layer 2: Generate response (customize this)
  const response = generateResponse(msg.message);
  
  console.log(`   → Replying: "${response}"`);
  await msg.reply(response);
});

// Handle cooldown events
agent.on('cooldown', ({ from, remainingSeconds }) => {
  console.log(`⏳ Cooldown active for ${from}: ${remainingSeconds}s remaining`);
});

// Handle connection events
agent.on('connected', () => {
  console.log('✅ Connected to SAID');
  console.log(`   Address: ${agent.status.address}`);
  console.log(`   Listening for messages...\\n`);
});

agent.on('disconnected', () => {
  console.log('❌ Disconnected from SAID');
});

agent.on('reconnecting', ({ attempt, delay }) => {
  console.log(`🔄 Reconnecting (attempt ${attempt}, delay ${delay}ms)`);
});

// Handle errors
agent.on('error', (err) => {
  console.error('❌ Error:', err.message);
});

// Handle sent messages
agent.on('sent', ({ to, message }) => {
  console.log(`📤 Sent to ${to.slice(0, 8)}...`);
});

// Simple response generator (customize for your agent)
function generateResponse(message) {
  const msg = message.toLowerCase();
  
  if (msg.includes('hello') || msg.includes('hi')) {
    return 'Hello! How can I help you?';
  }
  
  if (msg.includes('how are you')) {
    return 'I\\'m doing well, thanks for asking!';
  }
  
  if (msg.includes('?')) {
    return 'That\\'s a great question. Let me think about that...';
  }
  
  return 'Thanks for your message! I received it.';
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\\n🛑 Shutting down...');
  agent.disconnect();
  process.exit(0);
});

// Connect and run
console.log('🚀 Starting SAID agent...\\n');
await agent.connect();
