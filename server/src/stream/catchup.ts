import type { Logger } from 'pino';
import { PRIORITY, type RpcClient } from '../solana/rpc.js';
import { shortAddr } from '../util/misc.js';
import { normalizeTransaction, type RawTransaction } from './normalize.js';
import type { StreamTx } from './types.js';

interface SignatureInfo {
  signature: string;
  err: unknown;
  blockTime: number | null;
}

/**
 * After a start or restart (e.g. an automatic deploy), looks back `maxAgeSec` for trades the watched
 * wallets made while the bot was down and feeds the ones not seen yet in like live trades – so they
 * are still copied if they are fresh enough. One lookup per wallet, plus one per missed transaction.
 */
export async function catchUp(opts: {
  rpc: RpcClient;
  addresses: string[];
  maxAgeSec: number;
  alreadySeen: (signature: string) => boolean;
  emit: (st: StreamTx) => void;
  log: Logger;
}): Promise<number> {
  const cutoff = Date.now() / 1000 - opts.maxAgeSec;
  let found = 0;
  await Promise.all(
    opts.addresses.map(async (address) => {
      try {
        const sigs = await opts.rpc.call<SignatureInfo[]>('getSignaturesForAddress', [address, { limit: 10, commitment: 'confirmed' }], PRIORITY.stream);
        // Oldest first, so a buy is processed before the sell that follows it.
        for (const s of [...sigs].reverse()) {
          if (s.err || !s.blockTime || s.blockTime < cutoff || opts.alreadySeen(s.signature)) continue;
          const raw = await opts.rpc.call<RawTransaction | null>(
            'getTransaction',
            [s.signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
            PRIORITY.stream,
          );
          const tx = raw && normalizeTransaction({ ...raw, signature: s.signature });
          if (!tx) continue;
          found++;
          opts.emit({ tx, detectedAt: Date.now(), source: 'backfill' });
        }
      } catch (err) {
        opts.log.warn({ err: (err as Error).message }, `catch-up for ${shortAddr(address)} failed`);
      }
    }),
  );
  if (found) opts.log.info(`caught up on ${found} transaction(s) made while the bot was restarting`);
  return found;
}
