/**
 * Backfill missing Solana wallet addresses from Privy
 * 
 * Usage:
 *   npx tsx scripts/backfill-wallets.ts
 */

import 'dotenv/config';
import { PrivyClient } from '@privy-io/server-auth';
import { prisma } from '../src/db';

const privyClient = new PrivyClient(
  'cmlbxd3qu00jqi80c4pibohzv',
  process.env.PRIVY_APP_SECRET || ''
);

async function backfillWallets() {
  console.log('[backfill] Starting wallet backfill...\n');

  // Find all users missing wallet addresses
  const usersWithoutWallets = await prisma.user.findMany({
    where: {
      privyWalletAddress: null,
      privyId: { not: null },
    },
    select: {
      id: true,
      privyId: true,
      privyWalletAddress: true,
    },
  });

  console.log(`[backfill] Found ${usersWithoutWallets.length} users without wallets\n`);

  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (const user of usersWithoutWallets) {
    try {
      console.log(`[backfill] Checking user ${user.id} (${user.privyId})...`);
      
      const privyUser = await privyClient.getUserById(user.privyId!);
      
      // Find Solana wallet
      const solanaWallet = privyUser.linkedAccounts?.find((acc) => 
        acc.type === 'wallet' && 'chainType' in acc && acc.chainType === 'solana'
      );
      
      if (solanaWallet && solanaWallet.type === 'wallet' && 'address' in solanaWallet) {
        const walletAddress = solanaWallet.address;
        console.log(`  ✅ Found wallet: ${walletAddress}`);
        
        await prisma.user.update({
          where: { id: user.id },
          data: { privyWalletAddress: walletAddress },
        });
        
        updated++;
      } else {
        console.log(`  ⚠️  No Solana wallet found in Privy`);
        notFound++;
      }
    } catch (error) {
      console.error(`  ❌ Error fetching user:`, error instanceof Error ? error.message : error);
      errors++;
    }
    
    console.log('');
  }

  console.log('[backfill] Summary:');
  console.log(`  Updated: ${updated}`);
  console.log(`  Not found: ${notFound}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total: ${usersWithoutWallets.length}`);
}

backfillWallets()
  .then(() => {
    console.log('\n[backfill] Done!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[backfill] Fatal error:', err);
    process.exit(1);
  });
