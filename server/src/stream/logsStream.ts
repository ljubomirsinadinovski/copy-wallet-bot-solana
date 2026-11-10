import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { PRIORITY, RpcError, type RpcClient } from '../solana/rpc.js';
import type { SettingsStore } from '../settings.js';
import { LruSet, shortAddr, sleep } from '../util/misc.js';
import type { UsageTracker } from '../util/usage.js';
import { normalizeTransaction, type RawTransaction } from './normalize.js';
import { looksLikeTradeOrTransfer } from './prefilter.js';
import type { StreamStatus, WalletStream } from './types.js';
import { JsonRpcWs } from './wsClient.js';

interface LogsNotification {
  context: { slot: number };
  value: { signature: string; err: unknown; logs: string[] };
}

/**
 * Free-tier stream: one standard `logsSubscribe` per wallet. The notification only carries the
 * signature and logs, so swaps are then looked up with getTransaction (available once confirmed).
 */
export class LogsStream extends EventEmitter implements WalletStream {
  private ws: JsonRpcWs;
  private subs = new Map<string, number>();
  private seen = new LruSet(50_000);
  private lastSig = new Map<string, string>();
  private lookups = 0;
  private everConnected = false;
  private maxTxVersion = 1;

  constructor(
    wsUrl: string,
    private readonly rpc: RpcClient,
    private readonly settings: SettingsStore,
    private readonly log: Logger,
    usage: UsageTracker,
  ) {
    super();
    this.ws = new JsonRpcWs(wsUrl, log, usage);
    this.ws.on('open', () => {
      if (this.everConnected) void this.backfill();
      this.everConnected = true;
      this.emit('status', this.status());
    });
    this.ws.on('close', () => this.emit('status', this.status()));
  }

  start() {
    this.ws.start();
  }

  stop() {
    this.ws.stop();
  }

  setWallets(addresses: string[]) {
    const wanted = new Set(addresses);
    for (const [addr, sub] of this.subs) {
      if (!wanted.has(addr)) {
        this.ws.unsubscribe(sub);
        this.subs.delete(addr);
      }
    }
    for (const addr of wanted) {
      if (this.subs.has(addr)) continue;
      const sub = this.ws.subscribe('logsSubscribe', [{ mentions: [addr] }, { commitment: 'processed' }], 'logsUnsubscribe', (r) =>
        this.onLogs(addr, r),
      );
      this.subs.set(addr, sub);
    }
    this.emit('status', this.status());
  }

  status(): StreamStatus {
    return {
      kind: 'logs',
      connected: this.ws.connected,
      wallets: this.subs.size,
      lastMessageAt: this.ws.lastMessageAt,
      reconnects: this.ws.reconnects,
      pendingLookups: this.lookups,
      error: this.ws.lastError,
    };
  }

  private onLogs(address: string, n: LogsNotification) {
    const { signature, err, logs } = n.value;
    this.lastSig.set(address, signature);
    if (err || this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.settings.get().prefilterLogs && !looksLikeTradeOrTransfer(logs)) {
      this.log.debug({ signature, wallet: shortAddr(address) }, 'skipped non-swap transaction');
      return;
    }
    void this.lookup(signature, Date.now(), 'logs');
  }

  private async lookup(signature: string, detectedAt: number, source: 'logs' | 'backfill') {
    this.lookups++;
    try {
      // getTransaction only returns data once the transaction is confirmed (~0.5–1.5 s after it lands).
      for (let attempt = 0; attempt < 30; attempt++) {
        const raw = await this.getTransaction(signature);
        if (raw) {
          const tx = normalizeTransaction({ ...raw, signature });
          if (tx) this.emit('tx', { tx, detectedAt, source });
          return;
        }
        await sleep(attempt < 10 ? 250 : 1000);
      }
      this.log.warn({ signature }, 'transaction not found after retries (dropped?)');
    } catch (err) {
      this.log.error({ signature, err: (err as Error).message }, 'transaction lookup failed');
    } finally {
      this.lookups--;
    }
  }

  private async getTransaction(signature: string): Promise<RawTransaction | null> {
    try {
      return await this.rpc.call<RawTransaction | null>(
        'getTransaction',
        [signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: this.maxTxVersion }],
        PRIORITY.stream,
      );
    } catch (err) {
      // Only downgrade if the RPC rejects the parameter itself – not for "Transaction version (1) is not supported".
      if (err instanceof RpcError && this.maxTxVersion === 1 && err.code === -32602 && /maxSupportedTransactionVersion/i.test(err.message) && !/Transaction version/i.test(err.message)) {
        this.maxTxVersion = 0;
        return this.getTransaction(signature);
      }
      throw err;
    }
  }

  /** After a reconnect, picks up transactions that happened while we were offline. */
  private async backfill() {
    for (const [address, until] of this.lastSig) {
      if (!this.subs.has(address)) continue;
      try {
        const sigs = await this.rpc.call<Array<{ signature: string; err: unknown }>>(
          'getSignaturesForAddress',
          [address, { until, limit: 25, commitment: 'confirmed' }],
          PRIORITY.stream,
        );
        for (const s of sigs.reverse()) {
          if (s.err || this.seen.has(s.signature)) continue;
          this.seen.add(s.signature);
          void this.lookup(s.signature, Date.now(), 'backfill');
        }
        if (sigs.length) this.log.info({ wallet: shortAddr(address), count: sigs.length }, 'backfilled missed transactions');
      } catch (err) {
        this.log.warn({ wallet: shortAddr(address), err: (err as Error).message }, 'backfill failed');
      }
    }
  }
}
