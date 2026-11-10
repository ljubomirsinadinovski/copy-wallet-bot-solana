import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { catchUp } from '../src/stream/catchup.js';
import type { StreamTx } from '../src/stream/types.js';

const now = () => Math.floor(Date.now() / 1000);

function fakeRpc(sigs: Array<{ signature: string; blockTime: number; err?: unknown }>) {
  const fetched: string[] = [];
  return {
    fetched,
    rpc: {
      call: async (method: string, params: any[]) => {
        if (method === 'getSignaturesForAddress') return sigs.map((s) => ({ err: null, ...s })); // newest first, like the RPC
        fetched.push(params[0]);
        return {
          slot: 1,
          blockTime: sigs.find((s) => s.signature === params[0])!.blockTime,
          transaction: { signatures: [params[0]], message: { accountKeys: ['W'] } },
          meta: { err: null, fee: 5000, preBalances: [1], postBalances: [1], preTokenBalances: [], postTokenBalances: [], logMessages: [] },
        };
      },
    } as any,
  };
}

describe('catch-up after a restart', () => {
  it('replays only fresh, unseen, successful transactions – oldest first', async () => {
    const { rpc, fetched } = fakeRpc([
      { signature: 'sell-5s-ago', blockTime: now() - 5 },
      { signature: 'buy-12s-ago', blockTime: now() - 12 },
      { signature: 'already-copied', blockTime: now() - 14 },
      { signature: 'failed', blockTime: now() - 15, err: { InstructionError: [0, 'x'] } },
      { signature: 'too-old', blockTime: now() - 300 },
    ]);
    const emitted: StreamTx[] = [];
    const n = await catchUp({
      rpc,
      addresses: ['W'],
      maxAgeSec: 20,
      alreadySeen: (s) => s === 'already-copied',
      emit: (st) => emitted.push(st),
      log: pino({ level: 'silent' }),
    });
    expect(n).toBe(2);
    expect(emitted.map((e) => e.tx.signature)).toEqual(['buy-12s-ago', 'sell-5s-ago']);
    expect(emitted.every((e) => e.source === 'backfill')).toBe(true);
    expect(fetched).toEqual(['buy-12s-ago', 'sell-5s-ago']);
  });
});
