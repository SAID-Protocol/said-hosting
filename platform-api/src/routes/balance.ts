import { Router } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

export const balanceRouter = Router();

if (!process.env.SOLANA_RPC_URL && !process.env.SOLANA_RPC) throw new Error('SOLANA_RPC_URL environment variable is required');
const RPC_URL: string = (process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC)!;
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * GET /api/balance/:walletAddress - Get USDC and SOL balance for any Solana wallet
 * No auth required - simple RPC proxy to avoid exposing QuickNode URL
 */
balanceRouter.get('/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    // Validate wallet address
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(walletAddress);
    } catch {
      res.status(400).json({ error: 'Invalid wallet address' });
      return;
    }
    
    const connection = new Connection(RPC_URL);
    
    // Get USDC balance
    let usdcBalance = 0;
    try {
      const ata = await getAssociatedTokenAddress(USDC_MINT, wallet);
      const tokenBalance = await connection.getTokenAccountBalance(ata);
      usdcBalance = Number(tokenBalance.value.uiAmount || 0);
    } catch {
      // Token account doesn't exist = 0 USDC
      usdcBalance = 0;
    }
    
    // Get SOL balance
    let solBalance = 0;
    try {
      const lamports = await connection.getBalance(wallet);
      solBalance = lamports / 1_000_000_000; // Convert lamports to SOL
    } catch {
      solBalance = 0;
    }
    
    res.json({ 
      balance: usdcBalance,
      solBalance: solBalance,
      walletAddress,
    });
  } catch (error) {
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to fetch balance' 
    });
  }
});
