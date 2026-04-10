/**
 * Transaction Fee Service
 * 
 * Extracts 1% platform fee from agent transactions before signing.
 * 
 * How it works:
 * 1. Decode incoming transaction
 * 2. Find SOL transfer instructions
 * 3. Calculate 1% of transfer amount
 * 4. Add a SystemProgram.transfer instruction sending fee to treasury
 * 5. Return modified transaction
 * 
 * Fee goes to: SAID treasury wallet (same as verification fees)
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from '@solana/web3.js';

const TREASURY_WALLET = new PublicKey('H8nKbwHTTmnjgnsvqxRDpoEcTkU6uoqs4DcLm4kY55Wp');
const FEE_BASIS_POINTS = 100; // 1% = 100 basis points
const MIN_FEE_LAMPORTS = 1000; // ~0.000001 SOL minimum fee

interface FeeExtractionResult {
  modifiedTransaction: string; // base64
  feeAmount: number; // lamports
  originalAmount: number; // lamports
}

/**
 * Extract 1% platform fee from a transaction
 * 
 * @param transactionBase64 - Base64-encoded transaction from agent
 * @param agentAddress - Agent's wallet address (fee payer)
 * @returns Modified transaction with fee instruction added
 */
export async function extractPlatformFee(
  transactionBase64: string,
  agentAddress: string,
): Promise<FeeExtractionResult> {
  try {
    // Decode transaction
    const txBuffer = Buffer.from(transactionBase64, 'base64');
    const tx = Transaction.from(txBuffer);

    // Find SOL transfer amount
    const transferAmount = findSolTransferAmount(tx);

    if (transferAmount === 0) {
      // No SOL transfer found — return original transaction unchanged
      return {
        modifiedTransaction: transactionBase64,
        feeAmount: 0,
        originalAmount: 0,
      };
    }

    // Calculate 1% fee
    const feeAmount = Math.max(
      Math.floor((transferAmount * FEE_BASIS_POINTS) / 10000),
      MIN_FEE_LAMPORTS,
    );

    // Add fee transfer instruction (agent → treasury)
    const feeInstruction = SystemProgram.transfer({
      fromPubkey: new PublicKey(agentAddress),
      toPubkey: TREASURY_WALLET,
      lamports: feeAmount,
    });

    tx.add(feeInstruction);

    // Re-serialize
    const modifiedTxBuffer = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const modifiedTransaction = modifiedTxBuffer.toString('base64');

    console.log(
      `[fees] Extracted ${feeAmount} lamports (${(feeAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL) from ${transferAmount} lamports transfer`,
    );

    return {
      modifiedTransaction,
      feeAmount,
      originalAmount: transferAmount,
    };
  } catch (error) {
    console.error('[fees] Fee extraction error:', error);
    // On error, return original transaction unchanged
    return {
      modifiedTransaction: transactionBase64,
      feeAmount: 0,
      originalAmount: 0,
    };
  }
}

/**
 * Find the SOL transfer amount in a transaction
 * Returns 0 if no transfer found
 */
function findSolTransferAmount(tx: Transaction): number {
  const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();

  for (const ix of tx.instructions) {
    // Check if it's a SystemProgram instruction
    if (ix.programId.toBase58() !== SYSTEM_PROGRAM_ID) {
      continue;
    }

    // SystemProgram.transfer has instruction discriminator 2
    // Data format: [2, ...lamports_le]
    if (ix.data.length >= 5 && ix.data[0] === 2) {
      // Read lamports (u64 little-endian at offset 1-8)
      const lamports = ix.data.readBigUInt64LE(1);
      return Number(lamports);
    }
  }

  return 0;
}
