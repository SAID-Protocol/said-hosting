import { NextFunction, Request, Response } from 'express';
import { PrivyClient } from '@privy-io/server-auth';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
        
        // Auto-create or get existing user
        const user = await prisma.user.upsert({
          where: { privyId: privyUserId },
          update: {},
          create: {
            privyId: privyUserId,
            billingStatus: 'trial',
            billingMode: 'all_inclusive',
            trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
            tier: 'starter',
          },
        });
        
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
