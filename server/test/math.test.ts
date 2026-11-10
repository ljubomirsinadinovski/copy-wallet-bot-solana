import { describe, expect, it } from 'vitest';
import { applyBuy, applySell, splitAcrossLots } from '../src/engine/lotMath.js';
import { sellSlippages, sizeBuy, sizeBuyBySize, sizeSell } from '../src/engine/sizing.js';

const SOL = 1_000_000_000;
const base = {
  pct: 0.1,
  balanceLamports: 2 * SOL,
  reserveLamports: 0.02 * SOL,
  multiplier: 1,
  minLamports: 0.01 * SOL,
  maxLamports: 0.5 * SOL,
  maxPct: 25,
  tokenExposureLamports: 0,
  maxPerTokenLamports: 1 * SOL,
};

describe('sizeBuy', () => {
  it('mirrors the trader ratio on balance minus reserve', () => {
    const r = sizeBuy(base);
    expect(r).toEqual({ ok: true, lamports: Math.floor(0.1 * 1.98 * SOL), clampedBy: null });
  });

  it('caps at max % per trade (bundler wallets often spend ~100%)', () => {
    const r = sizeBuy({ ...base, pct: 1 });
    expect(r.ok && r.lamports).toBe(Math.floor(1.98 * SOL * 0.25));
    expect(r.ok && r.clampedBy).toBe('max 25% per trade');
  });

  it('caps at max SOL per trade', () => {
    const r = sizeBuy({ ...base, balanceLamports: 100 * SOL, pct: 0.2 });
    expect(r.ok && r.lamports).toBe(0.5 * SOL);
  });

  it('respects remaining per-token exposure', () => {
    const r = sizeBuy({ ...base, balanceLamports: 100 * SOL, pct: 0.2, maxLamports: 10 * SOL, tokenExposureLamports: 0.8 * SOL });
    expect(r.ok && r.lamports).toBe(0.2 * SOL);
    const full = sizeBuy({ ...base, tokenExposureLamports: 1 * SOL });
    expect(full).toEqual({ ok: false, reason: 'limit reached (max 1 SOL per token)' });
  });

  it('skips trades below the minimum', () => {
    const r = sizeBuy({ ...base, pct: 0.001 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/below the 0.01 SOL minimum/);
  });

  it('never spends the reserve', () => {
    expect(sizeBuy({ ...base, balanceLamports: 0.02 * SOL }).ok).toBe(false);
  });

  it('applies the multiplier', () => {
    const r = sizeBuy({ ...base, multiplier: 2 });
    expect(r.ok && r.lamports).toBe(Math.floor(0.2 * 1.98 * SOL));
  });
});

describe('sizeSell', () => {
  it('sells the same share', () => expect(sizeSell(1000n, 0.4, false)).toBe(400n));
  it('sells everything on a full exit', () => expect(sizeSell(1000n, 0.5, true)).toBe(1000n));
  it('rounds ~100% up to everything', () => expect(sizeSell(1000n, 0.997, false)).toBe(1000n));
  it('handles huge raw amounts', () => expect(sizeSell(10n ** 24n, 0.5, false)).toBe(5n * 10n ** 23n));
});

describe('sellSlippages', () => {
  it('starts with auto and widens', () => expect(sellSlippages(null, 3)).toEqual([null, 2500, 4000, 6000]));
  it('starts with the group value and only widens', () => expect(sellSlippages(2000, 3)).toEqual([2000, 2500, 4000, 6000]));
  it('honours the retry count', () => expect(sellSlippages(null, 1)).toEqual([null, 2500]));
});

describe('lot accounting', () => {
  it('tracks cost, average entry MC, partial and full exits', () => {
    let lot = applyBuy(null, { tokens: 1000n, costLamports: 1 * SOL, mcUsd: 50_000 });
    lot = applyBuy(lot, { tokens: 500n, costLamports: 1 * SOL, mcUsd: 150_000 });
    expect(lot.tokenAmount).toBe(1500n);
    expect(lot.totalCostLamports).toBe(2 * SOL);
    expect(lot.entryMcUsd).toBe(100_000); // weighted by SOL invested

    // Sell a third for 1 SOL: cost removed = 2/3 SOL → realized +1/3 SOL
    const s1 = applySell(lot, { tokens: 500n, proceedsLamports: 1 * SOL, mcUsd: 200_000 });
    expect(s1.closed).toBe(false);
    expect(s1.costRemoved).toBe(Math.round((2 * SOL) / 3));
    expect(s1.realized).toBe(SOL - Math.round((2 * SOL) / 3));
    expect(s1.lot.tokenAmount).toBe(1000n);

    // Sell the rest for 0.5 SOL
    const s2 = applySell(s1.lot, { tokens: 1000n, proceedsLamports: 0.5 * SOL, mcUsd: 50_000 });
    expect(s2.closed).toBe(true);
    expect(s2.lot.costLamports).toBe(0);
    expect(s2.lot.realizedLamports).toBe(1.5 * SOL - 2 * SOL); // total proceeds − total cost
    expect(s2.lot.exitMcUsd).toBeCloseTo((200_000 * 1 + 50_000 * 0.5) / 1.5, 6);
  });

  it('never sells more than the lot holds', () => {
    const lot = applyBuy(null, { tokens: 100n, costLamports: SOL, mcUsd: null });
    const s = applySell(lot, { tokens: 500n, proceedsLamports: SOL, mcUsd: null });
    expect(s.lot.tokenAmount).toBe(0n);
    expect(s.lot.soldAmount).toBe(100n);
  });

  it('splits a manual close across lots proportionally', () => {
    const parts = splitAcrossLots([{ tokenAmount: 300n }, { tokenAmount: 100n }], 400n, 1000);
    expect(parts.map((p) => p.tokens)).toEqual([300n, 100n]);
    expect(parts.map((p) => p.proceeds)).toEqual([750, 250]);
    const half = splitAcrossLots([{ tokenAmount: 3n }, { tokenAmount: 3n }, { tokenAmount: 3n }], 4n, 100);
    expect(half.reduce((s, p) => s + p.tokens, 0n)).toBe(4n);
    expect(half.reduce((s, p) => s + p.proceeds, 0)).toBe(100);
  });
});

describe('sizeBuyBySize', () => {
  const base = {
    theirSpentUsd: 100,
    copyPct: 10,
    solUsd: 100,
    balanceLamports: 10 * SOL, // $1000
    reserveLamports: 0,
    minUsd: 3,
    maxPctOfBalance: 25,
    tokenExposureLamports: 0,
    maxUsdPerToken: 50,
  };
  const usdOf = (r: ReturnType<typeof sizeBuyBySize>) => (r.ok ? (r.lamports / SOL) * 100 : null);

  it('copies the % of their dollars', () => expect(usdOf(sizeBuyBySize(base))).toBeCloseTo(10, 6));
  it('raises small copies to the minimum', () => expect(usdOf(sizeBuyBySize({ ...base, theirSpentUsd: 10 }))).toBeCloseTo(3, 6));
  it('limits big copies to max % of your balance', () => {
    const r = sizeBuyBySize({ ...base, theirSpentUsd: 1000, balanceLamports: 0.6 * SOL, maxUsdPerToken: 1000 });
    expect(usdOf(r)).toBeCloseTo(15, 6); // $60 × 25%
  });
  it('never goes past the per-token budget', () => {
    expect(usdOf(sizeBuyBySize({ ...base, theirSpentUsd: 1000, maxUsdPerToken: 30 }))).toBeCloseTo(30, 6);
    expect(sizeBuyBySize({ ...base, tokenExposureLamports: 0.49 * SOL }).ok).toBe(false);
  });
  it('the minimum wins over the % cap on a small wallet, but never spends more than you have', () => {
    expect(usdOf(sizeBuyBySize({ ...base, theirSpentUsd: 10, balanceLamports: 0.08 * SOL }))).toBeCloseTo(3, 6);
    expect(sizeBuyBySize({ ...base, balanceLamports: 0.02 * SOL }).ok).toBe(false);
  });
  it('fills only what is left of the per-token budget: hold $25, cap $30, $35 copy → $5', () => {
    const r = sizeBuyBySize({ ...base, theirSpentUsd: 350, maxUsdPerToken: 30, tokenExposureLamports: 0.25 * SOL, maxPctOfBalance: 100 });
    expect(usdOf(r)).toBeCloseTo(5, 6);
    expect(r.ok && r.clampedBy).toMatch(/per-token budget/);
  });
  it('skips when less than the minimum is left in the budget: hold $28, cap $30', () => {
    const r = sizeBuyBySize({ ...base, maxUsdPerToken: 30, tokenExposureLamports: 0.28 * SOL });
    expect(r.ok).toBe(false);
  });
});
