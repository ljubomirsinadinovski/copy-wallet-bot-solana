import { describe, expect, it } from 'vitest';
import {
  CHECK_MS,
  bookSold,
  finishOpenLevels,
  impactCapTokens,
  isDust,
  moonBagTokens,
  nextAllowance,
  nextCheckMs,
  nextLevel,
  quoteForTokens,
  sellableTokens,
  sliceTokens,
  tokensForQuote,
  trackStop,
  type PlanLevel,
} from './planMath.js';

const SOL = 1_000_000_000n;
const TOKEN = 1_000_000n; // pump.fun coins have 6 decimals
// A freshly graduated PumpSwap pool: ~85 SOL against ~206.9M tokens.
const BASE = 206_900_000n * TOKEN;
const QUOTE = 85n * SOL;
const BAG = 20_000_000n * TOKEN; // 2% of supply

const level = (mcUsd: number, pct: number, soldTokens = 0n, doneAt: number | null = null): PlanLevel => ({ id: mcUsd, mcUsd, pct, soldTokens: soldTokens.toString(), doneAt });
const ladder = () => [level(100_000, 10), level(200_000, 15), level(500_000, 15), level(1_000_000, 20), level(2_000_000, 20), level(3_000_000, 10)];

describe('price impact', () => {
  it('selling the capped amount moves the price by that %', () => {
    for (const pct of [0.5, 1.5, 5]) {
      const t = impactCapTokens(BASE, pct);
      // Constant product: after selling t, price = quote·base / (base + t)².
      const ratio = (Number(BASE) / Number(BASE + t)) ** 2;
      expect(1 - ratio).toBeCloseTo(pct / 100, 4);
    }
  });

  it('tokensForQuote is the inverse of quoteForTokens', () => {
    const tokens = tokensForQuote(BASE, QUOTE, SOL);
    const back = quoteForTokens(BASE, QUOTE, tokens);
    expect(Number(back)).toBeGreaterThan(Number(SOL) * 0.9999);
    expect(Number(back)).toBeLessThanOrEqual(Number(SOL));
    expect(tokensForQuote(BASE, QUOTE, 0n)).toBe(0n);
    expect(tokensForQuote(BASE, QUOTE, QUOTE)).toBeGreaterThan(BASE);
  });
});

describe('slice size', () => {
  const base = { sellable: BAG, base: BASE, quote: QUOTE, maxImpactPct: 1.5, minSell: SOL / 10n, dust: SOL / 1000n, exiting: false };

  it('waits while the buys paid for less than the smallest sell', () => {
    expect(sliceTokens({ ...base, allowance: SOL / 20n })).toBe(0n);
  });

  it('sells what the buys paid for', () => {
    const slice = sliceTokens({ ...base, allowance: SOL / 2n });
    expect(slice).toBe(tokensForQuote(BASE, QUOTE, SOL / 2n));
  });

  it('never moves the price more than the cap, however much was bought', () => {
    expect(sliceTokens({ ...base, allowance: 50n * SOL })).toBe(impactCapTokens(BASE, 1.5));
  });

  it('after a trailing stop sells capped pieces without waiting for buys', () => {
    expect(sliceTokens({ ...base, allowance: 0n, exiting: true })).toBe(impactCapTokens(BASE, 1.5));
  });

  it('sells a remainder smaller than the smallest sell once the buys cover it', () => {
    const tail = tokensForQuote(BASE, QUOTE, SOL / 50n);
    expect(sliceTokens({ ...base, sellable: tail, allowance: SOL / 40n })).toBe(tail);
    expect(sliceTokens({ ...base, sellable: tail, allowance: SOL / 100n })).toBe(0n);
  });

  it('in a pool too thin for the smallest sell, sells the capped amount', () => {
    const slice = sliceTokens({ ...base, maxImpactPct: 0.1, minSell: 5n * SOL, allowance: 10n * SOL });
    expect(slice).toBe(impactCapTokens(BASE, 0.1));
  });

  it('never leaves a remainder too small to sell later', () => {
    const sellable = tokensForQuote(BASE, QUOTE, SOL / 2n + SOL / 20n);
    expect(sliceTokens({ ...base, sellable, allowance: SOL / 2n })).toBe(sellable);
    // A larger remainder stays for later.
    const bigger = tokensForQuote(BASE, QUOTE, SOL);
    expect(sliceTokens({ ...base, sellable: bigger, allowance: SOL / 2n })).toBe(tokensForQuote(BASE, QUOTE, SOL / 2n));
  });

  it('calls a few tokens dust, worth less than the fees', () => {
    const dust = SOL / 1000n;
    expect(isDust(BASE, QUOTE, 1n, dust)).toBe(true);
    expect(isDust(BASE, QUOTE, tokensForQuote(BASE, QUOTE, SOL / 2000n), dust)).toBe(true);
    expect(isDust(BASE, QUOTE, tokensForQuote(BASE, QUOTE, SOL / 100n), dust)).toBe(false);
  });

  it('sells nothing when nothing is sellable', () => {
    expect(sliceTokens({ ...base, sellable: 0n, allowance: 10n * SOL })).toBe(0n);
  });
});

describe('allowance from buys', () => {
  it('adds a share of net buys and takes it back on net sells, never below zero', () => {
    let a = nextAllowance(0n, 10n * SOL, 30);
    expect(a).toBe(3n * SOL);
    a = nextAllowance(a, -5n * SOL, 30);
    expect(a).toBe(SOL + SOL / 2n);
    expect(nextAllowance(a, -100n * SOL, 30)).toBe(0n);
  });
});

describe('trailing stop', () => {
  const s0 = { armedAt: null, highMcUsd: null, exiting: false, stopDropPct: 40, firstLevelMcUsd: 10_000 };

  it('ignores what the coin did before the first level was reached', () => {
    // Waiting below the first level: no high is kept.
    let s = { ...s0, ...trackStop(s0, 9_000, 1) };
    expect(s.armedAt).toBeNull();
    expect(s.highMcUsd).toBeNull();
    // The first level is reached at $11.3k: armed, high = $11.3k – an earlier $19.3k doesn't count.
    const armed = trackStop(s, 11_300, 2);
    expect(armed).toEqual({ armedAt: 2, highMcUsd: 11_300, fire: false });
    s = { ...s, ...armed };
    s = { ...s, ...trackStop(s, 20_000, 3) };
    expect(s.highMcUsd).toBe(20_000);
    expect(trackStop(s, 12_500, 4).fire).toBe(false); // −37.5%
    expect(trackStop(s, 11_900, 5).fire).toBe(true); // −40.5%
  });

  it('never fires without a stop, or twice', () => {
    const armed = { ...s0, armedAt: 1, highMcUsd: 20_000 };
    expect(trackStop({ ...armed, stopDropPct: null }, 1_000, 2).fire).toBe(false);
    expect(trackStop({ ...armed, exiting: true }, 1_000, 2).fire).toBe(false);
  });
});

describe('levels', () => {
  it('only reached levels sell; the moon bag never does', () => {
    const levels = ladder();
    expect(moonBagTokens(levels, BAG)).toBe(BAG / 10n);
    expect(sellableTokens(levels, BAG, 90_000, false)).toBe(0n);
    expect(sellableTokens(levels, BAG, 250_000, false)).toBe((BAG * 25n) / 100n);
    // After the trailing stop every unfinished level sells, whatever the market cap.
    expect(sellableTokens(levels, BAG, 50_000, true)).toBe((BAG * 90n) / 100n);
  });

  it('books sells on the lowest open level first and finishes it', () => {
    const levels = ladder();
    const first = (BAG * 10n) / 100n;
    const { levels: next, finished } = bookSold(levels, BAG, first + 1_000n, 250_000, false, 42);
    expect(next[0].doneAt).toBe(42);
    expect(next[0].soldTokens).toBe(first.toString());
    expect(next[1].soldTokens).toBe('1000');
    expect(next[1].doneAt).toBeNull();
    expect(next[2].soldTokens).toBe('0'); // 500k not reached
    expect(finished.map((l) => l.mcUsd)).toEqual([100_000]);
  });

  it('closes only the open levels when what they have left is dust', () => {
    const { levels, finished } = finishOpenLevels(ladder(), 250_000, false, 7);
    expect(finished.map((l) => l.mcUsd)).toEqual([100_000, 200_000]);
    expect(levels[2].doneAt).toBeNull();
  });

  it('finds the next level to wait for', () => {
    const levels = ladder();
    expect(nextLevel(levels, 150_000)?.mcUsd).toBe(200_000);
    expect(nextLevel(levels, 5_000_000)).toBeNull();
  });

  it('checks often only when it matters', () => {
    expect(nextCheckMs({ selling: true, mcUsd: 1, nextLevelMcUsd: 100, stopArmed: false })).toBe(CHECK_MS.selling);
    expect(nextCheckMs({ selling: false, mcUsd: 80, nextLevelMcUsd: 100, stopArmed: false })).toBe(CHECK_MS.near);
    expect(nextCheckMs({ selling: false, mcUsd: 20, nextLevelMcUsd: 100, stopArmed: true })).toBe(CHECK_MS.near);
    expect(nextCheckMs({ selling: false, mcUsd: 20, nextLevelMcUsd: 100, stopArmed: false })).toBe(CHECK_MS.idle);
  });
});
