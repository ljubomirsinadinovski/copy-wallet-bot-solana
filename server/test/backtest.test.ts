import { describe, expect, it } from 'vitest';
import { Backtester, type BacktestParams } from '../src/backtest/backtest.js';
import { DEFAULT_QUOTE_MINTS } from '../src/solana/constants.js';

const TRADER = 'Trader1111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOL = 1_000_000_000;
const RENT = 2_039_280;

/** A raw (RPC-format) swap: `owner` pays/gets SOL for tokens on pump.fun. */
function swap(sig: string, slot: number, owner: string, solDelta: number, tokBefore: bigint, tokAfter: bigint) {
  return {
    slot,
    blockTime: 1_700_000_000 + Math.floor((slot * 400) / 1000),
    transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: owner }, { pubkey: `${owner.slice(0, 10)}Ata` }, { pubkey: PUMP }] } },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [100 * SOL, RENT, 1],
      postBalances: [100 * SOL + solDelta - 5000, RENT, 1],
      preTokenBalances: [{ accountIndex: 1, mint: MINT, owner, uiTokenAmount: { amount: String(tokBefore), decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 1, mint: MINT, owner, uiTokenAmount: { amount: String(tokAfter), decimals: 6 } }],
      logMessages: [],
    },
  };
}

type Raw = ReturnType<typeof swap>;

/** Fake getTransactionsForAddress over a fixed set of transactions. */
function fakeRpc(byAddress: Record<string, Raw[]>) {
  const calls: Array<{ address: string; opts: any }> = [];
  return {
    calls,
    async call<T>(_method: string, [address, opts]: [string, any]): Promise<T> {
      calls.push({ address, opts });
      let list = [...(byAddress[address] ?? [])].sort((a, b) => a.slot - b.slot);
      const f = opts.filters?.slot ?? {};
      if (f.gte != null) list = list.filter((x) => x.slot >= f.gte);
      if (f.lte != null) list = list.filter((x) => x.slot <= f.lte);
      if (opts.sortOrder === 'desc') list.reverse();
      return { data: list.slice(0, opts.limit), paginationToken: null } as T;
    },
  };
}

const params = (over: Partial<BacktestParams> = {}): BacktestParams => ({
  wallet: TRADER,
  tokens: 15,
  delaySec: 1,
  copyPct: 10,
  minUsd: 3,
  maxUsdPerToken: 50,
  feePerTradeSol: 0,
  copyCreatorBuys: false,
  safety: { skipFreezeAuthority: true, skipMintAuthority: true, skipRiskyToken2022: true, maxTransferFeePct: 5, blacklist: [] },
  quoteMints: DEFAULT_QUOTE_MINTS,
  solUsd: 100,
  ...over,
});

describe('backtest', () => {
  // Trader buys 1M tokens for 2 SOL ($200) at slot 100, sells all for 4 SOL at slot 1000.
  const buy = swap('tBuy', 100, TRADER, -2 * SOL, 0n, 1_000_000_000_000n);
  const sell = swap('tSell', 1000, TRADER, 4 * SOL, 1_000_000_000_000n, 0n);
  // Another wallet buys 3 slots (1.2 s) later at a higher price: 1 SOL for 400k tokens.
  const after1 = swap('oBuy', 103, OTHER, -1 * SOL, 0n, 400_000_000_000n);
  // …and sells 3 slots after the trader's exit at 1 SOL per 300k tokens.
  const after2 = swap('oSell', 1003, OTHER, 1 * SOL, 300_000_000_000n, 0n);

  it('prices each copy at the first trade after the delay and sums the profit', async () => {
    const rpc = fakeRpc({ [TRADER]: [buy, sell], [MINT]: [buy, after1, sell, after2] });
    const r = await new Backtester(rpc).run(params());
    expect(r.tokens).toHaveLength(1);
    const t = r.tokens[0];
    // You copy 10% of $200 = $20 at 2.5 SOL per 1M tokens → 80k tokens…
    expect(t.yourCostUsd).toBeCloseTo(20, 6);
    expect(t.trades[0].pricedBy).toBe('oBuy');
    expect(t.trades[0].lagMs).toBe(1200);
    // …and sell them all at 1 SOL per 300k tokens: 80k × (1/300k) SOL = 0.2667 SOL = $26.67.
    expect(t.yourProceedsUsd).toBeCloseTo((80_000 / 300_000) * 100, 4);
    expect(t.yourPnlUsd).toBeCloseTo(t.yourProceedsUsd - 20, 6);
    expect(t.stillOpen).toBe(false);
    // The trader made $200 on the same token.
    expect(t.theirPnlUsd).toBeCloseTo(200, 6);
    expect(r.totals.wins).toBe(1);
  });

  it('never prices a copy with the trader’s own transaction, and waits the delay', async () => {
    const rpc = fakeRpc({ [TRADER]: [buy, sell], [MINT]: [buy, after1, sell, after2] });
    await new Backtester(rpc).run(params({ delaySec: 1 }));
    const lookups = rpc.calls.filter((c) => c.address === MINT && c.opts.sortOrder === 'asc');
    expect(lookups[0].opts.filters.slot.gte).toBe(103); // 1 s = 3 slots after slot 100
  });

  it('falls back to the last trade before the copy when the token is quiet', async () => {
    const early = swap('oEarly', 90, OTHER, -1 * SOL, 0n, 500_000_000_000n); // 2 SOL per 1M
    const rpc = fakeRpc({ [TRADER]: [buy], [MINT]: [early, buy] });
    const r = await new Backtester(rpc).run(params());
    const row = r.tokens[0].trades[0];
    expect(row.pricedBy).toBe('oEarly');
    expect(row.note).toMatch(/quiet token/);
  });

  it('respects the minimum and the per-token budget', async () => {
    const small = swap('tSmall', 100, TRADER, -0.1 * SOL, 0n, 50_000_000_000n); // $10 → 10% = $1 → raised to $3
    const big = swap('tBig', 200, TRADER, -10 * SOL, 50_000_000_000n, 5_050_000_000_000n); // $1000 → $100, capped by $50 − $3
    const o1 = swap('o1', 103, OTHER, -1 * SOL, 0n, 500_000_000_000n);
    const o2 = swap('o2', 203, OTHER, -1 * SOL, 0n, 500_000_000_000n);
    const rpc = fakeRpc({ [TRADER]: [small, big], [MINT]: [small, o1, big, o2] });
    const r = await new Backtester(rpc).run(params());
    const [a, b] = r.tokens[0].trades;
    expect(a.yourUsd).toBeCloseTo(3, 6);
    expect(b.yourUsd).toBeCloseTo(47, 6);
    expect(r.tokens[0].yourCostUsd).toBeCloseTo(50, 6);
  });

  it('frees the per-token budget once the position is sold, like the live bot', async () => {
    // $1000 buys (copy $100 → capped at $50), a full exit, then another $1000 buy.
    const b1 = swap('b1', 100, TRADER, -10 * SOL, 0n, 1_000_000_000_000n);
    const s1 = swap('s1', 200, TRADER, 10 * SOL, 1_000_000_000_000n, 0n);
    const b2 = swap('b2', 300, TRADER, -10 * SOL, 0n, 1_000_000_000_000n);
    const others = [103, 203, 303].map((slot) => swap(`o${slot}`, slot, OTHER, -1 * SOL, 0n, 100_000_000_000n));
    const rpc = fakeRpc({ [TRADER]: [b1, s1, b2], [MINT]: [b1, s1, b2, ...others] });
    const r = await new Backtester(rpc).run(params());
    expect(r.tokens[0].trades.map((x) => x.yourUsd)).toEqual([50, expect.any(Number), 50]);
  });

  it('skips tokens the live bot’s safety checks reject', async () => {
    const rpc = fakeRpc({ [TRADER]: [buy], [MINT]: [buy, after1] });
    const facts = async () => ({ supply: 10n ** 15n, freezeAuthority: null, mintAuthority: null, riskyExtensions: null, transferFeeBps: 800 });
    const r = await new Backtester(rpc, () => null, facts).run(params());
    expect(r.tokens[0].trades[0].yourUsd).toBeNull();
    expect(r.tokens[0].trades[0].note).toBe('not copied – transfer fee 8% is above your 5% limit');
    expect(r.totals.costUsd).toBe(0);
  });

  it('prices from the signer, not the bonding curve’s side of the same trade', async () => {
    const CURVE = 'Curve1111111111111111111111111111111111111';
    // OTHER buys 400k tokens for 1 SOL; the curve's token account is listed first.
    const t = swap('oBuy', 103, OTHER, -1 * SOL, 0n, 400_000_000_000n);
    t.transaction.message.accountKeys.push({ pubkey: CURVE });
    t.meta.preBalances.push(50 * SOL);
    t.meta.postBalances.push(50 * SOL + 0.99 * SOL);
    t.meta.preTokenBalances.unshift({ accountIndex: 3, mint: MINT, owner: CURVE, uiTokenAmount: { amount: '900000000000000', decimals: 6 } });
    t.meta.postTokenBalances.unshift({ accountIndex: 3, mint: MINT, owner: CURVE, uiTokenAmount: { amount: '899600000000000', decimals: 6 } });
    const rpc = fakeRpc({ [TRADER]: [buy], [MINT]: [buy, t] });
    const r = await new Backtester(rpc).run(params());
    // Priced as OTHER's buy: 1 SOL per 400k tokens → $20 buys 80k tokens, no side conversion.
    expect(r.tokens[0].trades[0].pricedBy).toBe('oBuy');
    expect(r.tokens[0].trades[0].note).toBeNull();
    // From the curve's side it would be a 'sell' at 0.99 SOL, converted to ≈1.015 SOL → only ≈$19.70 held.
    expect(r.tokens[0].yourOpenUsd).toBeCloseTo(20, 6);
  });

  it('never prices from a split buy of several tokens, and labels the trader’s', async () => {
    const SIDE = 'Side111111111111111111111111111111111111111';
    /** `owner` pays `sol` for MINT and a dust amount of SIDE in one transaction. */
    const splitBuy = (sig: string, slot: number, owner: string, sol: number, tok: bigint) => {
      const t = swap(sig, slot, owner, -sol * SOL, 0n, tok);
      t.meta.preTokenBalances.push({ accountIndex: 1, mint: SIDE, owner, uiTokenAmount: { amount: '0', decimals: 6 } });
      t.meta.postTokenBalances.push({ accountIndex: 1, mint: SIDE, owner, uiTokenAmount: { amount: '5000', decimals: 6 } });
      return t;
    };
    const tBuy = splitBuy('tSplit', 100, TRADER, 2, 1_000_000_000_000n);
    const oSplit = splitBuy('oSplit', 103, OTHER, 1, 400_000_000_000n); // would say half the real price
    const oReal = swap('oReal', 104, OTHER, -1 * SOL, 0n, 400_000_000_000n);
    const rpc = fakeRpc({ [TRADER]: [tBuy], [MINT]: [tBuy, oSplit, oReal] });
    const r = await new Backtester(rpc).run(params({ tokens: 1 }));
    const row = r.tokens.find((x) => x.mint === MINT)!.trades[0];
    expect(row.pricedBy).toBe('oReal');
    expect(row.note).toMatch(/together with another token/);
    expect(row.theirMcUsd).toBeNull();
  });
});
