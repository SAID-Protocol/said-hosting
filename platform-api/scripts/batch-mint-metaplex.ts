/**
 * Batch Mint Metaplex NFTs for SAID Agents
 * 
 * Finds all agents without metaplexAsset and creates MPL Core NFTs + registers them.
 * 
 * Usage:
 *   npx ts-node scripts/batch-mint-metaplex.ts [--dry-run] [--limit 10]
 */

import { prisma } from '../src/db';
import { registerAgentMetaplex } from '../src/services/metaplex';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : undefined;

async function batchMintMetaplex() {
  console.log('🔍 Finding agents without Metaplex NFTs...\n');

  // Get all agents that:
  // 1. Have a wallet address
  // 2. Are SAID verified
  // 3. Don't have a Metaplex asset yet
  const agents = await prisma.agent.findMany({
    where: {
      walletAddress: { not: null },
      // Filter to verified agents when available
      metaplexAsset: null,
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${agents.length} agents needing Metaplex NFTs`);
  
  if (agents.length === 0) {
    console.log('✅ All agents already have Metaplex NFTs!');
    return;
  }

  if (dryRun) {
    console.log('\n📋 DRY RUN - Would mint for:');
    agents.forEach(a => {
      console.log(`  - ${a.name} (${a.walletAddress})`);
    });
    console.log(`\nRun without --dry-run to execute`);
    return;
  }

  console.log('\n🚀 Starting batch mint...\n');

  let successCount = 0;
  let failureCount = 0;

  for (const agent of agents) {
    try {
      console.log(`\n📦 Minting for: ${agent.name} (${agent.walletAddress})`);

      const result = await registerAgentMetaplex({
        name: agent.name,
        description: `SAID hosted agent: ${agent.name}`,
        walletAddress: agent.walletAddress!,
        capabilities: ['messaging', 'web-search'],
        tier: agent.tier,
        flyAppName: agent.flyAppName || undefined,
      });

      if (result.success && result.assetAddress) {
        // Update database with Metaplex info
        await prisma.agent.update({
          where: { id: agent.id },
          data: {
            metaplexAsset: result.assetAddress,
            metaplexUri: result.registrationUri,
          },
        });

        console.log(`  ✅ Success!`);
        console.log(`     Asset: ${result.assetAddress}`);
        console.log(`     URI: ${result.registrationUri}`);
        console.log(`     Tx: ${result.signature}`);
        
        successCount++;
      } else {
        console.log(`  ❌ Failed: ${result.error}`);
        failureCount++;
      }

      // Rate limit: wait 5 seconds between mints to avoid RPC throttling
      if (agents.indexOf(agent) < agents.length - 1) {
        console.log('  ⏳ Waiting 5s before next mint...');
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      failureCount++;
    }
  }

  console.log('\n📊 Batch Mint Complete');
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failureCount}`);
  console.log(`  📈 Total: ${agents.length}`);
}

batchMintMetaplex()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
