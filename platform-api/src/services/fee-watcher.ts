/**
 * Fee Watcher — watches agent wallets for swap transactions and auto-collects 1% fees.
 *
 * QuickNode WebSocket logsSubscribe per wallet ('mentions' filter). When the
 * wallet appears in a transaction's logs, QuickNode pushes us the signature; we
 * fetch the tx and run the same swap-detection + fee-collection logic the
 * previous polling implementation used.
 *
 * Replaces a polling loop that fetched up to ~26 RPC calls/wallet/minute
 * regardless of activity. Under WS, idle wallets cost effectively nothing.
 *
 * Flow:
 *   1. Subscribe to logs that mention each agent wallet.
 *   2. On notification, fetch the tx (1 call per real event).
 *   3. Detect Jupiter swap.
 *   4. Transfer 1% fee to treasury.
 *   5. Record in DB (DB unique constraint on swapTxSig is the dedupe of record).
 */

import WebSocket from 'ws';
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
} from '@solana/web3.js';
import { prisma } from '../db';
import { signTransaction } from './privy-wallets';

const TREASURY = '2XfHTeNWTjNwUmgoXaafYuqHcAAXj8F5Kjw2Bnzi4FxH';
const FEE_RATE = 0.01;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Jupiter program IDs
const JUPITER_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6
  'JUP4Fb2cqiRUcKkRJ6SJfW3qGdqbcFSSKk5JrKN3AMv', // Jupiter V4 (legacy)
  'JUP2jxvXaacZPDkPasmkRXkjetr2YYyoRYYyS8nZfUbr', // Jupiter V2 (legacy)
  'LANGu4KkTDE7K8FZGdJxQnEshPh2P5RuJjPyjkNy0Mg', // Jupiter Limit Order
]);
const JUPITER_PROGRAM_LIST = Array.from(JUPITER_PROGRAMS);

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const WS_URL = process.env.QUICKNODE_WS_URL;

// Tunables. SUBS_PER_CONNECTION is conservative — raise if your QuickNode tier
// supports more subscriptions per WS connection.
const SUBS_PER_CONNECTION = 100;
const SYNC_INTERVAL_MS = 60_000;
const PING_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CATCHUP_SIGS_PER_WALLET = 25;

// In-process dedupe so a tx that arrives via WS and via catch-up isn't
// processed twice within one boot. The DB unique check on swapTxSig is the
// authoritative dedupe across restarts.
const processedSignatures = new Set<string>();

interface WatchedWallet {
  externalId: string;
  walletAddress: string;
  privyWalletId: string;
}

/* ---------- detection / collection (unchanged from polling impl) ---------- */

interface SwapDetection {
  signature: string;
  outputMint: string;
  outputAmount: number;
  isSwap: boolean;
}

function detectSwapTx(tx: any): SwapDetection | null {
  try {
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const programIds = accountKeys.map((k: any) =>
      typeof k === 'string' ? k : k.pubkey?.toBase58?.() || ''
    );
    const hasJupiter = programIds.some((p: string) => JUPITER_PROGRAMS.has(p));
    if (!hasJupiter) return null;
    return {
      signature: tx.transaction?.signatures?.[0] || '',
      outputMint: 'SOL',
      outputAmount: 0,
      isSwap: true,
    };
  } catch {
    return null;
  }
}

function parseSolOutput(tx: any, walletAddress: string): number {
  try {
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const postBalances = tx.meta?.postBalances || [];
    const preBalances = tx.meta?.preBalances || [];
    const walletIndex = accountKeys.findIndex((k: any) => {
      const addr = typeof k === 'string' ? k : k.pubkey?.toBase58?.() || '';
      return addr === walletAddress;
    });
    if (walletIndex === -1) return 0;
    const pre = preBalances[walletIndex] || 0;
    const post = postBalances[walletIndex] || 0;
    return Math.max(0, (post - pre) / 10 ** 9);
  } catch {
    return 0;
  }
}

async function collectSolFee(
  privyWalletId: string,
  walletAddress: string,
  feeSOL: number,
  externalId: string
): Promise<string | null> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const fromPubkey = new PublicKey(walletAddress);
  const treasury = new PublicKey(TREASURY);

  const feeLamports = Math.floor(feeSOL * 10 ** 9);
  if (feeLamports < 1000) return null; // Skip dust

  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({ fromPubkey, toPubkey: treasury, lamports: feeLamports }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');

  try {
    const signature = await signTransaction(privyWalletId, txBase64);
    console.log(`[fee-watcher] Collected ${feeSOL.toFixed(6)} SOL from ${externalId}, tx: ${signature}`);
    return signature;
  } catch (err) {
    console.error(`[fee-watcher] SOL fee collection failed for ${externalId}:`, err);
    return null;
  }
}

/* ---------- core: handle one signature for one wallet ---------- */

async function processSignature(sig: string, wallet: WatchedWallet): Promise<void> {
  if (processedSignatures.has(sig)) return;
  processedSignatures.add(sig);

  const existingFee = await prisma.transactionFee.findFirst({ where: { swapTxSig: sig } });
  if (existingFee) return;

  const connection = new Connection(RPC_URL, 'confirmed');
  let tx;
  try {
    tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  } catch (err) {
    console.error(`[fee-watcher] getTransaction failed for ${sig}:`, err);
    return;
  }
  if (!tx) return;

  const detection = detectSwapTx(tx);
  if (!detection) return;

  const solOutput = parseSolOutput(tx, wallet.walletAddress);
  if (solOutput <= 0) return; // SOL was input, not output

  const fee = solOutput * FEE_RATE;
  if (fee < 0.0001) return; // Skip dust

  const feeSig = await collectSolFee(
    wallet.privyWalletId,
    wallet.walletAddress,
    fee,
    wallet.externalId
  );

  await prisma.transactionFee.create({
    data: {
      agentId: wallet.externalId,
      action: 'swap',
      amount: solOutput,
      fee,
      currency: 'SOL',
      collected: !!feeSig,
      txSignature: feeSig,
      swapTxSig: sig,
    },
  });

  console.log(
    `[fee-watcher] Swap detected for ${wallet.externalId}: ${solOutput.toFixed(4)} SOL output, fee: ${fee.toFixed(6)} SOL`
  );
}

/* ---------- WebSocket subscription manager ---------- */

class WatcherShard {
  private ws: WebSocket | null = null;
  private subIdToWallet = new Map<number, WatchedWallet>();
  private reqIdToWallet = new Map<number, WatchedWallet>();
  private readonly wallets = new Map<string, WatchedWallet>();
  private pendingWhileDisconnected: WatchedWallet[] = [];
  private nextReqId = 1;
  private reconnectAttempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly index: number;

  constructor(index: number, initialWallets: WatchedWallet[]) {
    this.index = index;
    for (const w of initialWallets) this.wallets.set(w.walletAddress, w);
  }

  size(): number {
    return this.wallets.size;
  }

  hasWallet(addr: string): boolean {
    return this.wallets.has(addr);
  }

  addWallet(w: WatchedWallet) {
    if (this.wallets.has(w.walletAddress)) return;
    this.wallets.set(w.walletAddress, w);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribe(w);
    } else {
      this.pendingWhileDisconnected.push(w);
    }
  }

  start() {
    this.connect();
  }

  private connect() {
    if (!WS_URL) return;
    console.log(`[fee-watcher] shard ${this.index}: connecting (${this.wallets.size} wallets)`);
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      console.log(`[fee-watcher] shard ${this.index}: open`);
      this.reconnectAttempts = 0;
      // Reconnect always means re-subscribing from scratch.
      this.subIdToWallet.clear();
      this.reqIdToWallet.clear();
      for (const w of this.wallets.values()) this.subscribe(w);
      const queued = this.pendingWhileDisconnected.splice(0);
      for (const w of queued) {
        if (!this.wallets.has(w.walletAddress)) {
          this.wallets.set(w.walletAddress, w);
          this.subscribe(w);
        }
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (data) => {
      this.handleMessage(data.toString()).catch((err) =>
        console.error(`[fee-watcher] shard ${this.index}: handler error:`, err)
      );
    });

    ws.on('close', (code) => {
      console.warn(`[fee-watcher] shard ${this.index}: closed (${code}), reconnecting...`);
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error(`[fee-watcher] shard ${this.index}: ws error:`, err);
    });
  }

  private scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  private subscribe(w: WatchedWallet) {
    const id = this.nextReqId++;
    this.reqIdToWallet.set(id, w);
    const msg = {
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [{ mentions: [w.walletAddress] }, { commitment: 'confirmed' }],
    };
    this.ws?.send(JSON.stringify(msg));
  }

  private async handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Subscription confirmation: { id, result: <numeric subId> }
    if (msg.id !== undefined && typeof msg.result === 'number') {
      const wallet = this.reqIdToWallet.get(msg.id);
      if (wallet) {
        this.subIdToWallet.set(msg.result, wallet);
        this.reqIdToWallet.delete(msg.id);
      }
      return;
    }

    // Subscription notification: { method, params: { subscription, result } }
    if (msg.method === 'logsNotification' && msg.params) {
      const subId = msg.params.subscription;
      const value = msg.params.result?.value;
      if (!value) return;
      const { signature, logs, err } = value;
      if (err) return; // skip failed txs
      if (!signature) return;

      const wallet = this.subIdToWallet.get(subId);
      if (!wallet) return;

      // Cheap log-side filter so we only fetch txs that look like Jupiter swaps.
      const hasJupiter =
        Array.isArray(logs) &&
        logs.some((l: string) => JUPITER_PROGRAM_LIST.some((p) => l.includes(p)));
      if (!hasJupiter) return;

      await processSignature(signature, wallet);
    }
  }
}

/* ---------- catch-up scan on boot ---------- */

async function catchUpScan(wallets: WatchedWallet[]): Promise<void> {
  // Walk recent signatures per wallet once at boot. Covers anything that
  // happened while the service was down. DB existing-fee check makes this
  // safely idempotent.
  const connection = new Connection(RPC_URL, 'confirmed');
  for (const wallet of wallets) {
    try {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(wallet.walletAddress),
        { limit: CATCHUP_SIGS_PER_WALLET }
      );
      for (const sigInfo of sigs) {
        await processSignature(sigInfo.signature, wallet);
      }
    } catch (err) {
      console.error(`[fee-watcher] catch-up failed for ${wallet.externalId}:`, err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/* ---------- entrypoint ---------- */

const shards: WatcherShard[] = [];

async function loadWallets(): Promise<WatchedWallet[]> {
  const rows = await prisma.butlerUser.findMany({
    where: {
      saidVerified: true,
      walletAddress: { not: null },
      privyWalletId: { not: null },
    },
    select: { externalId: true, walletAddress: true, privyWalletId: true },
  });
  return rows.map((r) => ({
    externalId: r.externalId,
    walletAddress: r.walletAddress!,
    privyWalletId: r.privyWalletId!,
  }));
}

function addWalletToBestShard(w: WatchedWallet) {
  // Find the shard with most headroom; create a new one if all are full.
  let target = shards.find((s) => s.size() < SUBS_PER_CONNECTION);
  if (!target) {
    target = new WatcherShard(shards.length, [w]);
    shards.push(target);
    target.start();
  } else {
    target.addWallet(w);
  }
}

// intervalMs is preserved in the signature for call-site compatibility but
// unused in WS mode.
export async function startFeeWatcher(_intervalMs = 60000): Promise<void> {
  if (!WS_URL) {
    console.error('[fee-watcher] QUICKNODE_WS_URL not set — fee watcher disabled.');
    console.error('[fee-watcher] Set QUICKNODE_WS_URL to your QuickNode wss:// endpoint to enable.');
    return;
  }

  const wallets = await loadWallets();
  console.log(`[fee-watcher] WS mode: subscribing to ${wallets.length} verified Privy-walleted agents`);

  // Shard wallets across N connections, respecting SUBS_PER_CONNECTION.
  for (let i = 0; i < wallets.length; i += SUBS_PER_CONNECTION) {
    const slice = wallets.slice(i, i + SUBS_PER_CONNECTION);
    shards.push(new WatcherShard(shards.length, slice));
  }
  if (shards.length === 0) {
    shards.push(new WatcherShard(0, []));
  }
  for (const s of shards) s.start();

  // Catch-up runs in the background so startup isn't blocked.
  catchUpScan(wallets)
    .then(() => console.log('[fee-watcher] catch-up scan complete'))
    .catch((err) => console.error('[fee-watcher] catch-up scan error:', err));

  // Periodic sync to pick up newly-provisioned wallets.
  setInterval(async () => {
    try {
      const current = await loadWallets();
      const newOnes = current.filter((c) => !shards.some((s) => s.hasWallet(c.walletAddress)));
      for (const w of newOnes) addWalletToBestShard(w);
      if (newOnes.length > 0) {
        console.log(`[fee-watcher] subscribed ${newOnes.length} newly provisioned wallets`);
      }
    } catch (err) {
      console.error('[fee-watcher] sync error:', err);
    }
  }, SYNC_INTERVAL_MS);
}
