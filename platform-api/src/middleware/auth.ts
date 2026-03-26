import { NextFunction, Request, Response } from 'express';
import { PrivyClient } from '@privy-io/server-auth';
import { prisma } from '../db';

const privyClient = new PrivyClient(
  'cmlbxd3qu00jqi80c4pibohzv', // Privy App ID
  process.env.PRIVY_APP_SECRET || '' // TODO: Add PRIVY_APP_SECRET to Railway env
);

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    // Check for Bearer token first (Privy auth)
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      
      try {
        const verifiedClaims = await privyClient.verifyAuthToken(token);
        const privyUserId = verifiedClaims.userId; // e.g., "did:privy:xxx"
        
        // Fetch user details from Privy to get wallet address
        let walletAddress: string | null = null;
        try {
          // Retry logic: Privy may still be creating the wallet after login
          let privyUser;
          let attempts = 0;
          const maxAttempts = 3;
          
          while (attempts < maxAttempts) {
            privyUser = await privyClient.getUserById(privyUserId);
            
            // Get the first Solana wallet (Privy creates embedded Solana wallets)
            const solanaWallet = privyUser.linkedAccounts?.find((acc) => 
              acc.type === 'wallet' && 'chainType' in acc && acc.chainType === 'solana'
            );
            
            if (solanaWallet && solanaWallet.type === 'wallet' && 'address' in solanaWallet) {
              walletAddress = solanaWallet.address;
              break;
            }
            
            // Wallet not ready yet, wait and retry
            attempts++;
            if (attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
            } else {
              console.warn('[auth] No Solana wallet found after', maxAttempts, 'attempts:', privyUserId);
            }
          }
        } catch (privyFetchError) {
          console.error('[auth] Failed to fetch Privy user wallet:', privyFetchError);
        }
        
        // Auto-create or get existing user
        const user = await prisma.user.upsert({
          where: { privyId: privyUserId },
          update: walletAddress ? { privyWalletAddress: walletAddress } : {},
          create: {
            privyId: privyUserId,
            privyWalletAddress: walletAddress,
          },
        });
        // Reduced logging - only log userId on auth success
        
        (req as Request & { userId: string }).userId = user.id;
        next();
        return;
      } catch (privyError) {
        console.error('Privy token verification failed:', privyError);
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
    }
    
    // Fallback to x-api-key for internal/service calls
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey === process.env.API_KEY) {
      // For service calls, use a default user or require userId in request
      (req as Request & { userId: string }).userId = 'default-user';
      next();
      return;
    }
    
    // No valid auth found
    res.status(401).json({ error: 'Unauthorized' });
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
