import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { LruSet } from '../util/misc.js';
import type { UsageTracker } from '../util/usage.js';
import { normalizeTransaction } from './normalize.js';
import type { StreamStatus, WalletStream } from './types.js';
import { JsonRpcWs } from './wsClient.js';

interface TransactionNotification {
  signature: string;
  slot: number;
  transaction: { transaction: any; meta: any };
}

/**
 * Developer-tier stream: Helius Enhanced WebSocket `transactionSubscribe`. One subscription covers
 * every watched wallet and each notification already contains the full transaction with balances,
 * at processed commitment – no extra lookup needed.
 */
export class EnhancedStream extends EventEmitter implements WalletStream {
  private ws: JsonRpcWs;
  private sub: number | null = null;
  private wallets: string[] = [];
  private seen = new LruSet(50_000);
  private pendingUpdate: NodeJS.Timeout | null = null;

  constructor(
    wsUrl: string,
    private readonly log: Logger,
    usage: UsageTracker,
  ) {
    super();
    this.ws = new JsonRpcWs(wsUrl, log, usage);
    this.ws.on('open', () => this.emit('status', this.status()));
    this.ws.on('close', () => this.emit('status', this.status()));
  }

  start() {
    this.ws.start();
  }

  stop() {
    this.ws.stop();
  }

  setWallets(addresses: string[]) {
    const next = [...new Set(addresses)].sort();
    if (next.join() === this.wallets.join()) return;
    this.wallets = next;
    // Debounce so adding several wallets in a row results in one resubscribe.
    if (this.pendingUpdate) clearTimeout(this.pendingUpdate);
    this.pendingUpdate = setTimeout(() => this.resubscribe(), 300);
  }

  status(): StreamStatus {
    return {
      kind: 'enhanced',
      connected: this.ws.connected,
      wallets: this.wallets.length,
      lastMessageAt: this.ws.lastMessageAt,
      reconnects: this.ws.reconnects,
      pendingLookups: 0,
      error: this.ws.lastError,
    };
  }

  private resubscribe() {
    const old = this.sub;
    // Subscribe to the new set before dropping the old one; duplicates are filtered by signature.
    this.sub = this.wallets.length
      ? this.ws.subscribe(
          'transactionSubscribe',
          [
            { accountInclude: this.wallets, failed: false, vote: false },
            {
              commitment: 'processed',
              encoding: 'jsonParsed',
              transactionDetails: 'full',
              showRewards: false,
              maxSupportedTransactionVersion: 1,
            },
          ],
          'transactionUnsubscribe',
          (r) => this.onTransaction(r),
        )
      : null;
    if (old !== null) this.ws.unsubscribe(old);
    this.log.info({ wallets: this.wallets.length }, 'transaction stream subscribed');
    this.emit('status', this.status());
  }

  private onTransaction(n: TransactionNotification) {
    const detectedAt = Date.now();
    if (this.seen.has(n.signature)) return;
    this.seen.add(n.signature);
    const tx = normalizeTransaction({
      slot: n.slot,
      signature: n.signature,
      transaction: n.transaction.transaction,
      meta: n.transaction.meta,
    });
    if (tx) this.emit('tx', { tx, detectedAt, source: 'enhanced' });
  }
}
