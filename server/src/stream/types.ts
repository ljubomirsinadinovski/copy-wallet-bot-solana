import type { EventEmitter } from 'node:events';

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  /** Raw integer amount as a string. */
  amount: string;
  decimals: number;
}

/** A transaction with the fields the swap parser needs, independent of where it came from. */
export interface NormalizedTx {
  signature: string;
  slot: number;
  /** Milliseconds; null when not known yet (processed-commitment notifications). */
  blockTime: number | null;
  err: unknown;
  fee: number;
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  logs: string[];
}

export interface StreamTx {
  tx: NormalizedTx;
  /** When the stream first told us about this transaction. */
  detectedAt: number;
  source: 'enhanced' | 'logs' | 'backfill';
}

export interface StreamStatus {
  kind: 'enhanced' | 'logs' | 'disabled';
  connected: boolean;
  wallets: number;
  lastMessageAt: number | null;
  reconnects: number;
  pendingLookups: number;
  error: string | null;
}

/** Emits 'tx' (StreamTx) and 'status' (StreamStatus). */
export interface WalletStream extends EventEmitter {
  start(): void;
  stop(): void;
  setWallets(addresses: string[]): void;
  status(): StreamStatus;
}
