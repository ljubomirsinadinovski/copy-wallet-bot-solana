import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { RpcClient, PRIORITY } from '../src/solana/rpc.js';
import { RpcLimiter } from '../src/util/rateLimit.js';
import { looksLikeTradeOrTransfer } from '../src/stream/prefilter.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('free-tier RPC scheduling', () => {
  it('allows an immediate burst and gives queued trade work the next available slot', async () => {
    vi.useFakeTimers();
    const limiter = new RpcLimiter(10);
    const calls: string[] = [];
    const jobs = Array.from({ length: 10 }, () => limiter.schedule(async () => { calls.push('first'); }));
    jobs.push(limiter.schedule(async () => { calls.push('background'); }, PRIORITY.background));
    jobs.push(limiter.schedule(async () => { calls.push('trade'); }, PRIORITY.trade));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(jobs);
    expect(calls.slice(10)).toEqual(['trade', 'background']);
  });

  it('shares the same limit between custom RPC and SDK calls', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url, init) => {
      const req = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { context: { slot: 1 }, value: 100 } }));
    });
    vi.stubGlobal('fetch', fetch);
    const usage = { rpc: vi.fn() };
    const rpc = new RpcClient('https://example.test', 2, usage as any);
    const a = rpc.call('getBalance', []);
    const b = rpc.connection.getBalance(new PublicKey('11111111111111111111111111111111'));
    const c = rpc.call('getBalance', []);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([a, b, c]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(usage.rpc).toHaveBeenCalledTimes(3);
  });

  it('enforces the separate send cap without delaying ordinary RPC work', async () => {
    vi.useFakeTimers();
    const limiter = new RpcLimiter(10, 1);
    const calls: Array<{ kind: string; at: number }> = [];
    const send = () => limiter.schedule(async () => { calls.push({ kind: 'send', at: Date.now() }); }, PRIORITY.trade, true);
    const jobs = [send(), send()];
    await vi.advanceTimersByTimeAsync(0);
    jobs.push(limiter.schedule(async () => { calls.push({ kind: 'read', at: Date.now() }); }, PRIORITY.trade));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.kind)).toEqual(['send', 'read']);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(jobs);
    expect(calls[2].at - calls[0].at).toBeGreaterThanOrEqual(1000);
  });

  it('lets token transfers through the free-tier prefilter', () => {
    expect(looksLikeTradeOrTransfer(['Program log: Instruction: Transfer'])).toBe(true);
    expect(looksLikeTradeOrTransfer(['Program log: Instruction: TransferChecked'])).toBe(true);
    expect(looksLikeTradeOrTransfer(['Program log: Instruction: TransferCheckedWithFee'])).toBe(true);
    expect(looksLikeTradeOrTransfer(['Program log: Instruction: Approve'])).toBe(false);
  });
});
