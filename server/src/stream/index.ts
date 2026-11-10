import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { RpcClient } from '../solana/rpc.js';
import type { SettingsStore } from '../settings.js';
import type { UsageTracker } from '../util/usage.js';
import { EnhancedStream } from './enhancedStream.js';
import { LogsStream } from './logsStream.js';
import type { StreamStatus, WalletStream } from './types.js';

class DisabledStream extends EventEmitter implements WalletStream {
  private count = 0;
  constructor(private readonly reason: string) {
    super();
  }
  start() {}
  stop() {}
  setWallets(a: string[]) {
    this.count = a.length;
  }
  status(): StreamStatus {
    return { kind: 'disabled', connected: false, wallets: this.count, lastMessageAt: null, reconnects: 0, pendingLookups: 0, error: this.reason };
  }
}

export function createStream(cfg: Config, rpc: RpcClient, settings: SettingsStore, usage: UsageTracker, log: Logger): WalletStream {
  if (!cfg.wsUrl) {
    log.warn('HELIUS_API_KEY is not set – wallet monitoring is off. Add it to .env to start watching wallets.');
    return new DisabledStream('HELIUS_API_KEY not set');
  }
  if (cfg.heliusTier === 'developer') {
    log.info('monitoring mode: Enhanced WebSocket (transactionSubscribe)');
    return new EnhancedStream(cfg.wsUrl, log, usage);
  }
  log.info('monitoring mode: standard logsSubscribe + getTransaction (free tier)');
  return new LogsStream(cfg.wsUrl, rpc, settings, log, usage);
}
