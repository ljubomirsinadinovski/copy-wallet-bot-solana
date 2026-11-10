import { ratio } from '../util/misc.js';

export interface LotState {
  tokenAmount: bigint;
  costLamports: number;
  totalCostLamports: number;
  proceedsLamports: number;
  realizedLamports: number;
  boughtAmount: bigint;
  soldAmount: bigint;
  entryMcUsd: number | null;
  exitMcUsd: number | null;
}

const weighted = (prev: number | null, prevWeight: number, next: number | null, weight: number) => {
  if (next == null) return prev;
  if (prev == null || prevWeight <= 0) return next;
  return (prev * prevWeight + next * weight) / (prevWeight + weight);
};

/** Adds a buy fill. `costLamports` includes fees. Entry market cap is averaged by SOL invested. */
export function applyBuy(lot: LotState | null, fill: { tokens: bigint; costLamports: number; mcUsd: number | null }): LotState {
  const base: LotState = lot ?? {
    tokenAmount: 0n,
    costLamports: 0,
    totalCostLamports: 0,
    proceedsLamports: 0,
    realizedLamports: 0,
    boughtAmount: 0n,
    soldAmount: 0n,
    entryMcUsd: null,
    exitMcUsd: null,
  };
  return {
    ...base,
    tokenAmount: base.tokenAmount + fill.tokens,
    costLamports: base.costLamports + fill.costLamports,
    totalCostLamports: base.totalCostLamports + fill.costLamports,
    boughtAmount: base.boughtAmount + fill.tokens,
    entryMcUsd: weighted(base.entryMcUsd, base.totalCostLamports, fill.mcUsd, fill.costLamports),
  };
}

/**
 * Removes a sell fill using average cost: the sold share of the remaining cost basis is matched
 * against the proceeds (net of fees) to give realized profit.
 */
export function applySell(
  lot: LotState,
  fill: { tokens: bigint; proceedsLamports: number; mcUsd: number | null },
): { lot: LotState; costRemoved: number; realized: number; closed: boolean } {
  const sold = fill.tokens > lot.tokenAmount ? lot.tokenAmount : fill.tokens;
  const remaining = lot.tokenAmount - sold;
  const costRemoved = remaining === 0n ? lot.costLamports : Math.round(lot.costLamports * ratio(sold, lot.tokenAmount));
  const realized = fill.proceedsLamports - costRemoved;
  return {
    lot: {
      ...lot,
      tokenAmount: remaining,
      costLamports: lot.costLamports - costRemoved,
      proceedsLamports: lot.proceedsLamports + fill.proceedsLamports,
      realizedLamports: lot.realizedLamports + realized,
      soldAmount: lot.soldAmount + sold,
      exitMcUsd: weighted(lot.exitMcUsd, lot.proceedsLamports, fill.mcUsd, Math.max(fill.proceedsLamports, 1)),
    },
    costRemoved,
    realized,
    closed: remaining === 0n,
  };
}

/** Splits one sell across several lots in proportion to the tokens each holds. */
export function splitAcrossLots<T extends { tokenAmount: bigint }>(
  lots: T[],
  soldTokens: bigint,
  proceedsLamports: number,
): Array<{ lot: T; tokens: bigint; proceeds: number }> {
  const total = lots.reduce((s, l) => s + l.tokenAmount, 0n);
  if (total === 0n) return [];
  let tokensLeft = soldTokens;
  let proceedsLeft = proceedsLamports;
  return lots.map((lot, i) => {
    const last = i === lots.length - 1;
    const tokens = last ? tokensLeft : (soldTokens * lot.tokenAmount) / total;
    const proceeds = last ? proceedsLeft : Math.round(proceedsLamports * ratio(lot.tokenAmount, total));
    tokensLeft -= tokens;
    proceedsLeft -= proceeds;
    return { lot, tokens, proceeds };
  });
}
