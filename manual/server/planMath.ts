/**
 * The arithmetic of a sell plan, free of I/O so it can be tested.
 *
 * pump.fun curves and PumpSwap pools are constant-product: the price is quote / base reserve, and
 * selling t tokens pays out quote·t / (base + t) before fees. "Quote" amounts are in the pool's own
 * currency (lamports for SOL, micro-USDC for USDC).
 */
import { mulFraction } from '../../server/src/util/misc.js';

export interface PlanLevel {
  /** Stays the same when the plan is edited, so sold tokens stay with their level. */
  id: number;
  /** Market cap (USD) from which this level sells. */
  mcUsd: number;
  /** Share of the original bag this level sells (%). */
  pct: number;
  /** Tokens sold for this level so far (raw units). */
  soldTokens: string;
  doneAt: number | null;
}

/** How often the pool is read: while selling, when the next level or a trailing stop is close, otherwise. */
export const CHECK_MS = { selling: 4_000, near: 15_000, idle: 60_000 } as const;
/** "Close to the next level" = at least this share of its market cap. */
export const NEAR_LEVEL = 0.7;
/** Less than this isn't worth a sell's fees (~0.0002 SOL): it's left in the wallet instead. */
export const DUST_SOL = 0.001;

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export const levelTarget = (bag: bigint, pct: number) => mulFraction(bag, pct / 100);

export function levelLeft(l: PlanLevel, bag: bigint): bigint {
  const left = levelTarget(bag, l.pct) - BigInt(l.soldTokens);
  return left > 0n ? left : 0n;
}

/** What the plan never sells: the share of the bag no level covers. */
export function moonBagTokens(levels: PlanLevel[], bag: bigint): bigint {
  const planned = levels.reduce((s, l) => s + levelTarget(bag, l.pct), 0n);
  return planned < bag ? bag - planned : 0n;
}

/** Levels that may sell now: the ones whose market cap is reached, or every unfinished one once the stop fired. */
export function openLevels(levels: PlanLevel[], mcUsd: number, exiting: boolean): PlanLevel[] {
  return levels.filter((l) => l.doneAt == null && (exiting || mcUsd >= l.mcUsd));
}

export function sellableTokens(levels: PlanLevel[], bag: bigint, mcUsd: number, exiting: boolean): bigint {
  return openLevels(levels, mcUsd, exiting).reduce((s, l) => s + levelLeft(l, bag), 0n);
}

/** The lowest level not reached yet, if any. */
export function nextLevel(levels: PlanLevel[], mcUsd: number): PlanLevel | null {
  return levels.find((l) => l.doneAt == null && mcUsd < l.mcUsd) ?? null;
}

/**
 * Books `sold` tokens on the open levels, lowest market cap first, and marks the ones that are now
 * complete. Returns the new levels and the ones that just finished.
 */
export function bookSold(levels: PlanLevel[], bag: bigint, sold: bigint, mcUsd: number, exiting: boolean, now: number) {
  let rest = sold;
  const finished: PlanLevel[] = [];
  const open = new Set(openLevels(levels, mcUsd, exiting));
  const next = levels.map((l) => {
    if (!open.has(l) || rest <= 0n) return l;
    const take = min(rest, levelLeft(l, bag));
    rest -= take;
    const updated = { ...l, soldTokens: (BigInt(l.soldTokens) + take).toString() };
    if (levelLeft(updated, bag) === 0n) {
      updated.doneAt = now;
      finished.push(updated);
    }
    return updated;
  });
  return { levels: next, finished };
}

/** Marks the open levels done without selling – what's left of them is dust. */
export function finishOpenLevels(levels: PlanLevel[], mcUsd: number, exiting: boolean, now: number) {
  const open = new Set(openLevels(levels, mcUsd, exiting));
  const finished: PlanLevel[] = [];
  const next = levels.map((l) => {
    if (!open.has(l)) return l;
    const done = { ...l, doneAt: now };
    finished.push(done);
    return done;
  });
  return { levels: next, finished };
}

/** Tokens that move the price down by at most `pct`% when sold into a pool holding `base` tokens. */
export function impactCapTokens(base: bigint, pct: number): bigint {
  return mulFraction(base, 1 / Math.sqrt(1 - pct / 100) - 1);
}

/** Tokens to sell to receive `amount` of quote (before fees). More than the pool could ever pay = everything. */
export function tokensForQuote(base: bigint, quote: bigint, amount: bigint): bigint {
  if (amount <= 0n) return 0n;
  if (amount >= quote) return base * 1_000n;
  return (base * amount) / (quote - amount);
}

export function quoteForTokens(base: bigint, quote: bigint, tokens: bigint): bigint {
  return tokens <= 0n ? 0n : (quote * tokens) / (base + tokens);
}

/**
 * Others' net flow into the pool since the last check: buys add `participationPct` of it to what
 * the plan may sell, sells by others take the same share back. Never below zero.
 */
export function nextAllowance(allowance: bigint, inflow: bigint, participationPct: number): bigint {
  const share = participationPct / 100;
  const next = allowance + (inflow >= 0n ? mulFraction(inflow, share) : -mulFraction(-inflow, share));
  return next > 0n ? next : 0n;
}

export interface SliceInput {
  /** Tokens the open levels may still sell (already capped by what the wallet holds above the moon bag). */
  sellable: bigint;
  base: bigint;
  quote: bigint;
  /** Quote the plan may sell into, earned from others' buys. */
  allowance: bigint;
  maxImpactPct: number;
  minSell: bigint;
  /** Below this a sell isn't worth its fees (quote units). */
  dust: bigint;
  /** The trailing stop fired: sell without waiting for buys (still capped per sell). */
  exiting: boolean;
}

/**
 * How many tokens to sell now: never more than the price-move cap, normally no more than the buys
 * paid for, and nothing when that is below the smallest sell – unless the cap or the remainder is
 * smaller still, so a thin pool or the last few tokens never get stuck. A sell never leaves a
 * remainder too small to sell later: that is sold with it.
 */
export function sliceTokens(i: SliceInput): bigint {
  if (i.sellable <= 0n || i.base <= 0n || i.quote <= 0n) return 0n;
  const cap = min(i.sellable, impactCapTokens(i.base, i.maxImpactPct));
  const want = i.exiting ? cap : min(cap, tokensForQuote(i.base, i.quote, i.allowance));
  const floor = min(tokensForQuote(i.base, i.quote, i.minSell), cap);
  if (want <= 0n || want < floor) return 0n;
  const tail = tokensForQuote(i.base, i.quote, i.minSell > i.dust ? i.minSell : i.dust);
  return i.sellable - want < tail ? i.sellable : want;
}

/** Whether `tokens` would fetch less than `dust` (a sell's fees). */
export const isDust = (base: bigint, quote: bigint, tokens: bigint, dust: bigint) => quoteForTokens(base, quote, tokens) < dust;

/**
 * The trailing stop after a check. It arms when the first level is reached, and its high is counted
 * from then – what the coin did before doesn't count. Fires once the market cap is `stopDropPct`%
 * below that high.
 */
export function trackStop(
  s: { armedAt: number | null; highMcUsd: number | null; exiting: boolean; stopDropPct: number | null; firstLevelMcUsd: number },
  mcUsd: number,
  now: number,
) {
  let { armedAt, highMcUsd } = s;
  if (armedAt == null) {
    if (mcUsd >= s.firstLevelMcUsd) {
      armedAt = now;
      highMcUsd = mcUsd;
    }
  } else if (highMcUsd == null || mcUsd > highMcUsd) highMcUsd = mcUsd;
  const fire = s.stopDropPct != null && armedAt != null && highMcUsd != null && !s.exiting && mcUsd <= highMcUsd * (1 - s.stopDropPct / 100);
  return { armedAt, highMcUsd, fire };
}

export function nextCheckMs(p: { selling: boolean; mcUsd: number; nextLevelMcUsd: number | null; stopArmed: boolean }): number {
  if (p.selling) return CHECK_MS.selling;
  if (p.stopArmed || (p.nextLevelMcUsd != null && p.mcUsd >= p.nextLevelMcUsd * NEAR_LEVEL)) return CHECK_MS.near;
  return CHECK_MS.idle;
}

export function usdShort(v: number): string {
  if (v >= 1e9) return `$${+(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${+(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${+(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}
