import { LAMPORTS_PER_SOL as LAMPORTS, lamportsToSol, mulFraction } from '../util/misc.js';

export interface BuySizingInput {
  /** Share of their balance the trader spent (0..1). */
  pct: number;
  balanceLamports: number;
  reserveLamports: number;
  multiplier: number;
  minLamports: number;
  maxLamports: number;
  /** Max share of the available balance per trade, 0..100. */
  maxPct: number;
  /** SOL already invested in this token (open lots). */
  tokenExposureLamports: number;
  maxPerTokenLamports: number;
}

export type SizingResult = { ok: true; lamports: number; clampedBy: string | null } | { ok: false; reason: string };

const fmt = (l: number) => lamportsToSol(l).toFixed(4).replace(/\.?0+$/, '');

/**
 * Mirror the trader's ratio on your balance: they spent X% → you spend X% of (balance − reserve),
 * times the multiplier, then apply the caps.
 */
export function sizeBuy(i: BuySizingInput): SizingResult {
  const available = i.balanceLamports - i.reserveLamports;
  if (available <= 0) return { ok: false, reason: `balance ${fmt(i.balanceLamports)} SOL is at or below the ${fmt(i.reserveLamports)} SOL reserve` };

  let amount = i.pct * available * i.multiplier;
  let clampedBy: string | null = null;
  const caps: Array<[number, string]> = [
    [(available * i.maxPct) / 100, `max ${i.maxPct}% per trade`],
    [i.maxLamports, `max ${fmt(i.maxLamports)} SOL per trade`],
    [i.maxPerTokenLamports - i.tokenExposureLamports, `max ${fmt(i.maxPerTokenLamports)} SOL per token`],
    [available, 'available balance'],
  ];
  for (const [cap, label] of caps) {
    if (amount > cap) {
      amount = cap;
      clampedBy = label;
    }
  }
  amount = Math.floor(amount);
  if (amount <= 0) return { ok: false, reason: clampedBy ? `limit reached (${clampedBy})` : 'nothing to buy' };
  if (amount < i.minLamports) return { ok: false, reason: `${fmt(amount)} SOL is below the ${fmt(i.minLamports)} SOL minimum` };
  return { ok: true, lamports: amount, clampedBy };
}

export interface SizeCopyInput {
  /** Dollars the trader spent on this buy. */
  theirSpentUsd: number;
  /** % of their dollar amount to copy. */
  copyPct: number;
  solUsd: number;
  balanceLamports: number;
  reserveLamports: number;
  /** Smaller copies are raised to this. */
  minUsd: number;
  /** Max share of your available balance one buy may use, 0..100. */
  maxPctOfBalance: number;
  /** What you already have in this token (cost basis). */
  tokenExposureLamports: number;
  maxUsdPerToken: number;
}

const dollars = (v: number) => `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;

/**
 * "Copy a % of their size": every buy and add is the same fraction of what they spent, so your
 * position keeps their shape. Then, in order:
 * - below the minimum → raised to the minimum (tiny copies would be eaten by fees otherwise);
 * - more than you can afford → at most `maxPctOfBalance` of your available balance, so one big
 *   bet can't empty the wallet and you keep room for their adds and next trades;
 * - never past the per-token budget.
 */
export function sizeBuyBySize(i: SizeCopyInput): SizingResult {
  const toLamports = (usd: number) => Math.floor((usd / i.solUsd) * LAMPORTS);
  const toUsd = (lamports: number) => (lamports / LAMPORTS) * i.solUsd;
  const available = i.balanceLamports - i.reserveLamports;
  const min = toLamports(i.minUsd);
  if (available < min) return { ok: false, reason: `available balance ${dollars(Math.max(0, toUsd(available)))} is below the ${dollars(i.minUsd)} minimum` };
  const budgetLeft = toLamports(i.maxUsdPerToken) - i.tokenExposureLamports;
  if (budgetLeft < min) return { ok: false, reason: `per-token budget of ${dollars(i.maxUsdPerToken)} is used up` };

  const targetUsd = (i.theirSpentUsd * i.copyPct) / 100;
  let amount = toLamports(targetUsd);
  let note: string | null = null;
  if (amount < min) {
    amount = min;
    note = `raised to the ${dollars(i.minUsd)} minimum (${i.copyPct}% would be ${dollars(targetUsd)})`;
  }
  const perBuy = Math.max(min, Math.floor((available * i.maxPctOfBalance) / 100));
  if (amount > perBuy) {
    amount = perBuy;
    note = `can't afford the full ${dollars(targetUsd)} copy – used ${dollars(toUsd(perBuy))}, ${i.maxPctOfBalance}% of your balance`;
  }
  if (amount > budgetLeft) {
    amount = budgetLeft;
    note = `capped by the ${dollars(i.maxUsdPerToken)} per-token budget`;
  }
  return { ok: true, lamports: Math.min(amount, available), clampedBy: note };
}

/** Sell the same share of your lot that the trader sold of their position. */
export function sizeSell(lotAmount: bigint, pct: number, fullExit: boolean): bigint {
  if (fullExit || pct >= 0.995) return lotAmount;
  return mulFraction(lotAmount, pct);
}

/** Slippage for each sell attempt: auto (null) or the group's value first, then progressively wider. */
export function sellSlippages(base: number | null, retries: number): Array<number | null> {
  const ladder = [2500, 4000, 6000];
  const out: Array<number | null> = [base];
  for (const s of ladder) {
    if (out.length > retries) break;
    if (base == null || s > base) out.push(s);
  }
  return out;
}
