import { Router } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

export const balanceRouter = Router();

const RPC_URL = process.env.SOLANA_RPC || 'https://newest-restless-mansion.solana-mainnet.quiknode.pro/af7d979a4ef8558eb0da3166819eac8af0d3dd2b';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * GET /api/balance/:walletAddress - Get USDC balance for any Solana wallet
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
    const ata = await getAssociatedTokenAddress(USDC_MINT, wallet);
    
    try {
      const balance = await connection.getTokenAccountBalance(ata);
      res.json({ 
        balance: Number(balance.value.uiAmount || 0),
        walletAddress,
      });
    } catch {
      // Token account doesn't exist = 0 balance
      res.json({ balance: 0, walletAddress });
    }
  } catch (error) {
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to fetch balance' 
    });
  }
});
