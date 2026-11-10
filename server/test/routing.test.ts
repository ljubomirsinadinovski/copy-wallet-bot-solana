import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { isPumpCandidate, RoutingExecutor, SwapError, type Executor, type SwapFill, type SwapParams } from '../src/executor/executors.js';
import { NotRoutableError } from '../src/executor/pump.js';
import { WSOL_MINT } from '../src/solana/constants.js';

const fill = (route: SwapFill['route']): SwapFill => ({ signature: 's', inAmount: 1n, outAmount: 1n, feeLamports: 0, sentAt: 0, confirmedAt: 0, route });

function setup(opts: { direct?: 'ok' | 'notRoutable' | 'failedAfterSend'; enabled?: boolean; paper?: boolean } = {}) {
  const calls: string[] = [];
  const direct = {
    async swap() {
      calls.push('direct.swap');
      if (opts.direct === 'notRoutable') throw new NotRoutableError('pool not priced in SOL');
      if (opts.direct === 'failedAfterSend') throw new SwapError('failed on-chain', 'sig');
      return fill('pumpfun');
    },
    async quote() {
      calls.push('direct.quote');
      return fill('pumpswap');
    },
  };
  const jupiter: Executor = {
    paper: false,
    async swap() {
      calls.push('jupiter');
      return fill('jupiter');
    },
  };
  const settings = { get: () => ({ directPumpTrades: opts.enabled ?? true }) };
  const router = new RoutingExecutor(opts.paper ?? false, direct as any, jupiter, settings as any, pino({ level: 'silent' }));
  return { router, calls };
}

const buy = (mint: string, venue: SwapParams['venue']): SwapParams => ({ wallet: 'W', inputMint: WSOL_MINT, outputMint: mint, amount: 1000n, slippageBps: null, venue });

describe('trade routing', () => {
  it('trades pump.fun tokens directly when the trader used pump.fun or PumpSwap', async () => {
    const { router, calls } = setup();
    expect((await router.swap(buy('Mint', 'pumpfun'))).route).toBe('pumpfun');
    expect((await router.swap(buy('Mint', 'pumpswap'))).route).toBe('pumpfun');
    expect(calls).toEqual(['direct.swap', 'direct.swap']);
  });

  it('uses Jupiter for other DEXes', async () => {
    const { router, calls } = setup();
    expect((await router.swap(buy('Mint', 'dex'))).route).toBe('jupiter');
    expect(calls).toEqual(['jupiter']);
  });

  it('falls back to Jupiter when the direct route cannot be built (nothing was sent)', async () => {
    const { router, calls } = setup({ direct: 'notRoutable' });
    expect((await router.swap(buy('Mint', 'pumpfun'))).route).toBe('jupiter');
    expect(calls).toEqual(['direct.swap', 'jupiter']);
  });

  it('never retries on Jupiter after a direct transaction was sent (no double trades)', async () => {
    const { router, calls } = setup({ direct: 'failedAfterSend' });
    await expect(router.swap(buy('Mint', 'pumpfun'))).rejects.toBeInstanceOf(SwapError);
    expect(calls).toEqual(['direct.swap']);
  });

  it('respects the setting', async () => {
    const { router, calls } = setup({ enabled: false });
    await router.swap(buy('Mint', 'pumpfun'));
    expect(calls).toEqual(['jupiter']);
  });

  it('paper mode quotes the curve/pool instead of sending', async () => {
    const { router, calls } = setup({ paper: true });
    expect((await router.swap(buy('Mint', 'pumpfun'))).route).toBe('pumpswap');
    expect(calls).toEqual(['direct.quote']);
  });

  it('manual trades (no trader venue) go direct for pump.fun mints', () => {
    expect(isPumpCandidate(buy('94KQMVqhZkpWjsUMGPGW7CkX9fcgP8oBUqd29qbjpump', null))).toBe(true);
    expect(isPumpCandidate(buy('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', null))).toBe(false);
    expect(isPumpCandidate(buy('94KQMVqhZkpWjsUMGPGW7CkX9fcgP8oBUqd29qbjpump', 'dex'))).toBe(false);
  });
});
