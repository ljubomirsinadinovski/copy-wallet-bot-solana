import { walletDeltas, type ParsedTrade } from '../parser/parseTrades.js';
import { CASH_STABLES, WSOL_MINT } from '../solana/constants.js';
import type { NormalizedTx } from '../stream/types.js';

export interface CashBasis {
  /** Share of the trader's cash (SOL + stablecoins) they spent, 0..1. */
  pct: number;
  basisUsd: number;
  spentUsd: number;
}

export interface CashBalances {
  lamports: number | null;
  stables: Map<string, { raw: bigint; decimals: number }>;
}

const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** Dollar value of what the trader paid (buy) or received (sell), or null if it can't be priced. */
export function quoteValueUsd(
  t: Pick<ParsedTrade, 'quoteMint' | 'quoteAmount' | 'quoteDecimals'>,
  solUsd: number | null,
  priceUsd: (mint: string) => number | null,
): number | null {
  if (!t.quoteMint || t.quoteAmount <= 0n) return null;
  if (t.quoteMint === WSOL_MINT) return solUsd == null ? null : units(t.quoteAmount, 9) * solUsd;
  if (CASH_STABLES.includes(t.quoteMint)) return units(t.quoteAmount, t.quoteDecimals);
  const p = priceUsd(t.quoteMint);
  return p == null ? null : units(t.quoteAmount, t.quoteDecimals) * p;
}

/** Which balances the transaction doesn't show and must be read separately. */
export function missingCash(tx: NormalizedTx, wallet: string): { stables: string[]; sol: boolean } {
  const { balances } = walletDeltas(tx, wallet);
  return { stables: CASH_STABLES.filter((m) => !balances.has(m)), sol: !tx.accountKeys.includes(wallet) };
}

/**
 * The trader's buy as a share of ALL their cash right before it: SOL + USDC + USDT + USD1, in dollars.
 * Balances the transaction touched come from the transaction itself (exact pre-trade values);
 * the others from `fetched` (read just after, unchanged by this trade).
 * Returns null for trades paid in something else (e.g. an extra quote token) – those keep the
 * share-of-that-token's-balance rule.
 */
export function cashBasis(t: ParsedTrade, tx: NormalizedTx, solUsd: number, fetched: CashBalances | null): CashBasis | null {
  if (!t.quoteMint || (t.quoteMint !== WSOL_MINT && !CASH_STABLES.includes(t.quoteMint)) || t.quoteAmount <= 0n) return null;
  const d = walletDeltas(tx, t.wallet);
  const walletInTx = tx.accountKeys.includes(t.wallet);
  const solLamports = Number(d.preSol) + (walletInTx ? 0 : (fetched?.lamports ?? 0));
  let basisUsd = (solLamports / 1e9) * solUsd;
  for (const m of CASH_STABLES) {
    const inTx = d.balances.get(m);
    const known = inTx ? { raw: inTx.pre, decimals: inTx.decimals } : fetched?.stables.get(m);
    if (known) basisUsd += units(known.raw, known.decimals);
  }
  const spentUsd = t.quoteMint === WSOL_MINT ? units(t.quoteAmount, 9) * solUsd : units(t.quoteAmount, t.quoteDecimals);
  if (basisUsd <= 0) return null;
  return { pct: Math.min(1, spentUsd / basisUsd), basisUsd, spentUsd };
}
