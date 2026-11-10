import { DEFAULT_QUOTE_MINTS, PUMP_PROGRAM, PUMPSWAP_PROGRAM, SWAP_PROGRAMS, WSOL_MINT } from '../solana/constants.js';
import { LIQUIDITY_INSTRUCTION, SWAP_INSTRUCTION } from '../stream/prefilter.js';
import type { NormalizedTx } from '../stream/types.js';
import { ratio } from '../util/misc.js';

export type TradeSide = 'buy' | 'sell' | 'transfer_in' | 'transfer_out';

/**
 * Where the trade happened, read from the program IDs in the trader's own transaction (no extra
 * API call): pump.fun bonding curve, PumpSwap pool, another DEX/aggregator, or none at all.
 */
export type Venue = 'pumpfun' | 'pumpswap' | 'dex' | null;

export function detectVenue(tx: Pick<NormalizedTx, 'accountKeys' | 'logs'>): Venue {
  const keys = new Set(tx.accountKeys);
  if (keys.has(PUMP_PROGRAM)) return 'pumpfun';
  if (keys.has(PUMPSWAP_PROGRAM)) return 'pumpswap';
  for (const id of Object.keys(SWAP_PROGRAMS)) if (keys.has(id)) return 'dex';
  if (tx.logs.some((l) => SWAP_INSTRUCTION.test(l))) return 'dex';
  return null;
}

export interface ParsedTrade {
  signature: string;
  slot: number;
  blockTime: number | null;
  wallet: string;
  side: TradeSide;
  mint: string;
  tokenDecimals: number;
  /** Absolute amount of the token that moved (raw). */
  tokenAmount: bigint;
  preTokenBalance: bigint;
  postTokenBalance: bigint;
  /** WSOL mint for SOL trades, the quote mint (USDC, USDT, ...) otherwise, null when no quote leg (transfers, token→token). */
  quoteMint: string | null;
  quoteDecimals: number;
  quoteAmount: bigint;
  preQuoteBalance: bigint;
  /** buy: share of the quote balance spent; sell: share of the token position sold (0..1). */
  pct: number;
  fullExit: boolean;
  venue: Venue;
  /** The token's mint was created in this same transaction (a dev launching and buying their own coin). */
  createdInTx: boolean;
  /** Pool/staking movements are not wallet transfers and must not trigger transfer exits. */
  liquidityOnly?: boolean;
  note: string | null;
}

const SOL_DUST = 100_000n; // 0.0001 SOL – below this a SOL change is just tips/noise
/** Non-SOL quote changes below 1/100 of a whole unit (e.g. 0.01 USDC) are noise. */
const quoteDust = (decimals: number) => 10n ** BigInt(Math.max(0, decimals - 2));
/** If less than 1% of the position is left after a sell, treat it as selling everything. */
const FULL_EXIT_REMAINDER = 0.01;
/**
 * A token the wallet kept less than this share of, out of what its sellers handed out in the
 * transaction, was a hop in a multi-step route – e.g. USDC → SOL → GTA → BAWSAQ, where BAWSAQ's
 * curve is priced in GTA and 1 raw GTA is left over – not something the trader bought.
 */
const ROUTE_LEFTOVER_SHARE = 0.05;

/** Per-owner balance change of every token in the transaction (mint → owner → delta). */
function ownerDeltas(tx: NormalizedTx): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>();
  const add = (b: NormalizedTx['preTokenBalances'][number], sign: 1n | -1n) => {
    if (!b.owner) return;
    let byOwner = out.get(b.mint);
    if (!byOwner) out.set(b.mint, (byOwner = new Map()));
    byOwner.set(b.owner, (byOwner.get(b.owner) ?? 0n) + sign * BigInt(b.amount));
  };
  for (const b of tx.preTokenBalances) add(b, -1n);
  for (const b of tx.postTokenBalances) add(b, 1n);
  return out;
}

export interface MintBalance {
  mint: string;
  decimals: number;
  pre: bigint;
  post: bigint;
  delta: bigint;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * Net balance changes of `wallet` in `tx`. SOL = native + wrapped, excluding the network fee (when the
 * wallet paid it) and rent moved into/out of the wallet's token accounts.
 */
export function walletDeltas(tx: NormalizedTx, wallet: string): { balances: Map<string, MintBalance>; solDelta: bigint; preSol: bigint } {
  const walletIdx = tx.accountKeys.indexOf(wallet);
  const ownedAccounts = new Set<number>();
  const balances = new Map<string, MintBalance>();

  const addBalance = (b: NormalizedTx['preTokenBalances'][number], which: 'pre' | 'post') => {
    if (b.owner !== wallet) return;
    ownedAccounts.add(b.accountIndex);
    let m = balances.get(b.mint);
    if (!m) {
      m = { mint: b.mint, decimals: b.decimals, pre: 0n, post: 0n, delta: 0n };
      balances.set(b.mint, m);
    }
    m[which] += BigInt(b.amount);
  };
  for (const b of tx.preTokenBalances) addBalance(b, 'pre');
  for (const b of tx.postTokenBalances) addBalance(b, 'post');
  for (const m of balances.values()) m.delta = m.post - m.pre;

  // SOL leg: wallet lamports + lamports of its token accounts (covers WSOL wrapping and rent moving
  // into/out of token accounts), plus the fee if the wallet paid it.
  let solDelta = 0n;
  let preSol = 0n;
  if (walletIdx >= 0) {
    solDelta += BigInt((tx.postBalances[walletIdx] ?? 0) - (tx.preBalances[walletIdx] ?? 0));
    preSol += BigInt(tx.preBalances[walletIdx] ?? 0);
    if (walletIdx === 0) solDelta += BigInt(tx.fee);
  }
  for (const idx of ownedAccounts) {
    solDelta += BigInt((tx.postBalances[idx] ?? 0) - (tx.preBalances[idx] ?? 0));
  }
  const wsol = balances.get(WSOL_MINT);
  if (wsol) preSol += wsol.pre;
  balances.delete(WSOL_MINT);
  return { balances, solDelta, preSol };
}

/**
 * Works out what `wallet` traded in `tx`, from balance changes alone – so it works for any DEX,
 * aggregator or app (pump.fun, PumpSwap, Jupiter, Raydium, fomo's router, ...).
 *
 * SOL is measured as native SOL + wrapped SOL, with the network fee and token-account rent
 * (creating/closing accounts) excluded so they don't distort the trade size. `quoteMints` are other
 * assets traders pay with (USDC, USDT, USD1, ...); a buy paid in one is sized as a share of that balance.
 */
export function parseWalletTrades(tx: NormalizedTx, wallet: string, quoteMints: ReadonlySet<string> = DEFAULT_QUOTE_MINTS): ParsedTrade[] {
  if (tx.err) return [];
  const { balances, solDelta, preSol } = walletDeltas(tx, wallet);

  const all = [...balances.values()];
  const stables = all.filter((m) => quoteMints.has(m.mint));
  const tokens = all.filter((m) => !quoteMints.has(m.mint) && m.delta !== 0n);
  const moves = ownerDeltas(tx);
  /** Others' balance changes of `mint` in this transaction (counterparties of the wallet). */
  const others = (mint: string) => [...(moves.get(mint) ?? new Map<string, bigint>())].filter(([owner]) => owner !== wallet);
  /** Share the wallet kept of what this token's sellers handed out in the transaction (1 = all of it). */
  const keptShare = (m: MintBalance) => {
    const handedOut = others(m.mint).reduce((sum, [, d]) => (d < 0n ? sum - d : sum), 0n);
    return handedOut > 0n ? ratio(m.delta, handedOut) : 1;
  };
  const received = tokens.filter((m) => m.delta > 0n);
  const downs = tokens.filter((m) => m.delta < 0n);
  // Only when another token moved too: a bundler buying one token for 30 wallets in one transaction
  // also leaves each wallet a small share, and those are real buys.
  let leftovers = tokens.length > 1 ? received.filter((m) => keptShare(m) < ROUTE_LEFTOVER_SHARE) : [];
  if (leftovers.length && leftovers.length === received.length && !downs.length) {
    // Something was bought: keep the token the wallet got the largest share of.
    const main = [...received].sort((x, y) => keptShare(y) - keptShare(x))[0];
    leftovers = leftovers.filter((m) => m !== main);
  }
  const ups = received.filter((m) => !leftovers.includes(m));

  // If several quote assets moved, use the one that moved the largest share of its balance.
  const share = (s: MintBalance) => ratio(abs(s.delta), s.pre > 0n ? s.pre : abs(s.delta));
  const stableSpent = stables.filter((s) => -s.delta > quoteDust(s.decimals)).sort((a, b) => share(b) - share(a))[0];
  const stableGained = stables.filter((s) => s.delta > quoteDust(s.decimals)).sort((a, b) => share(b) - share(a))[0];

  type Quote = Pick<ParsedTrade, 'quoteMint' | 'quoteDecimals' | 'quoteAmount' | 'preQuoteBalance'>;
  const quote = (dir: 'spent' | 'gained'): Quote | null => {
    const s = dir === 'spent' ? stableSpent : stableGained;
    if (s) return { quoteMint: s.mint, quoteDecimals: s.decimals, quoteAmount: abs(s.delta), preQuoteBalance: s.pre };
    const solMoved = dir === 'spent' ? solDelta < -SOL_DUST : solDelta > SOL_DUST;
    if (solMoved) return { quoteMint: WSOL_MINT, quoteDecimals: 9, quoteAmount: abs(solDelta), preQuoteBalance: preSol };
    return null;
  };
  const noQuote: Quote = { quoteMint: null, quoteDecimals: 0, quoteAmount: 0n, preQuoteBalance: 0n };

  const venue = detectVenue(tx);
  const base = { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, wallet, venue, createdInTx: false };
  const createdHere = (mint: string) => {
    const i = tx.accountKeys.indexOf(mint);
    return i >= 0 && (tx.preBalances[i] ?? 0) === 0 && (tx.postBalances[i] ?? 0) > 0;
  };
  const tokenPart = (m: MintBalance) => ({
    createdInTx: createdHere(m.mint),
    mint: m.mint,
    tokenDecimals: m.decimals,
    tokenAmount: abs(m.delta),
    preTokenBalance: m.pre,
    postTokenBalance: m.post,
  });
  const sellPct = (m: MintBalance) => {
    const fullExit = m.post === 0n || ratio(m.post, m.pre) <= FULL_EXIT_REMAINDER;
    return { pct: fullExit ? 1 : Math.min(1, ratio(abs(m.delta), m.pre)), fullExit };
  };

  const out: ParsedTrade[] = [];

  /**
   * Splits one payment over several tokens by what each token's counterparties received (buys) or
   * paid (sells) in this transaction; evenly when that can't be read (e.g. paid in another token).
   */
  const splitQuote = (list: MintBalance[], q: Quote, dir: 'buy' | 'sell'): bigint[] => {
    if (list.length === 1) return [q.quoteAmount];
    const seen = new Set<string>();
    const values: bigint[] = [];
    for (const m of list) {
      let v = 0n;
      for (const [owner, d] of others(m.mint)) {
        if (dir === 'buy' ? d >= 0n : d <= 0n) continue;
        if (seen.has(owner)) return list.map(() => q.quoteAmount / BigInt(list.length)); // one pool on both sides
        seen.add(owner);
        const got = q.quoteMint === WSOL_MINT ? walletDeltas(tx, owner).solDelta : (moves.get(q.quoteMint!)?.get(owner) ?? 0n);
        v += dir === 'buy' ? got : -got;
      }
      values.push(v);
    }
    const total = values.reduce((a, b) => a + b, 0n);
    if (values.some((v) => v <= 0n) || total <= 0n) return list.map(() => q.quoteAmount / BigInt(list.length));
    let left = q.quoteAmount;
    return values.map((v, i) => {
      const share = i === values.length - 1 ? left : (q.quoteAmount * v) / total;
      left -= share;
      return share;
    });
  };
  const routedNote = leftovers.length ? `routed through ${leftovers.length === 1 ? 'another token' : `${leftovers.length} other tokens`}` : null;
  // Change left over from a route is recorded as received, never copied as a buy.
  for (const m of leftovers)
    out.push({ ...base, ...tokenPart(m), ...noQuote, side: 'transfer_in', pct: 0, fullExit: false, note: 'left over from a multi-step route – not a purchase' });

  // Adding/removing liquidity, staking or locking moves tokens without buying or selling them.
  // Copying that as a trade would sell your position when the trader merely put tokens in a pool.
  const liquidityOnly = tx.logs.some((l) => LIQUIDITY_INSTRUCTION.test(l)) && !tx.logs.some((l) => SWAP_INSTRUCTION.test(l));
  if (liquidityOnly) {
    for (const m of downs) out.push({ ...base, ...tokenPart(m), ...noQuote, side: 'transfer_out', liquidityOnly: true, ...sellPct(m), note: 'put into a liquidity pool / staking' });
    for (const m of ups) out.push({ ...base, ...tokenPart(m), ...noQuote, side: 'transfer_in', pct: 0, fullExit: false, note: 'taken out of a liquidity pool / staking' });
    return out;
  }

  if (downs.length === 0 && ups.length > 0) {
    // A buy must go through a DEX/launchpad. Tokens arriving any other way (bridge, deposit,
    // airdrop claim) are recorded as received, even if the wallet paid a fee for it.
    const q = venue ? quote('spent') : null;
    const shares = q ? splitQuote(ups, q, 'buy') : [];
    for (const [i, m] of ups.entries()) {
      if (q) {
        // Several tokens bought in one transaction is rare; the spend is split by what each cost.
        const share = shares[i];
        out.push({
          ...base,
          ...tokenPart(m),
          ...q,
          quoteAmount: share,
          side: 'buy',
          pct: Math.min(1, ratio(share, q.preQuoteBalance)),
          fullExit: false,
          note: ups.length > 1 ? 'multi-buy' : routedNote,
        });
      } else {
        out.push({
          ...base,
          ...tokenPart(m),
          ...noQuote,
          side: 'transfer_in',
          pct: 0,
          fullExit: false,
          note: venue ? null : 'received without a DEX swap (bridge, deposit or transfer)',
        });
      }
    }
  } else if (downs.length > 0 && ups.length === 0) {
    const q = quote('gained');
    const shares = q ? splitQuote(downs, q, 'sell') : [];
    for (const [i, m] of downs.entries()) {
      if (q) {
        out.push({ ...base, ...tokenPart(m), ...q, quoteAmount: shares[i], side: 'sell', ...sellPct(m), note: downs.length > 1 ? 'multi-sell' : routedNote });
      } else if (venue) {
        // Sold on a DEX but the proceeds left the wallet in the same transaction (e.g. sell + withdraw).
        // Still an exit, so it is copied.
        out.push({ ...base, ...tokenPart(m), ...noQuote, side: 'sell', ...sellPct(m), note: 'sold; proceeds sent elsewhere in the same transaction' });
      } else {
        // Tokens sent to another wallet or an exchange – a withdrawal, not a trade.
        out.push({ ...base, ...tokenPart(m), ...noQuote, side: 'transfer_out', ...sellPct(m), note: 'sent to another wallet or exchange' });
      }
    }
  } else if (downs.length > 0 && ups.length > 0) {
    // Token → token rotation: copy the exit, record (but don't copy) the entry, since its size
    // can't be expressed as a share of the SOL balance.
    const into = ups.map((m) => m.mint).join(',');
    for (const m of downs) out.push({ ...base, ...tokenPart(m), ...noQuote, side: 'sell', ...sellPct(m), note: `rotation into ${into}` });
    for (const m of ups) out.push({ ...base, ...tokenPart(m), ...noQuote, side: 'transfer_in', pct: 0, fullExit: false, note: 'bought via token swap (not copied)' });
  }

  return out;
}

/** Price of one whole token in the quote asset (SOL or USD for stables), or null. */
export function tradePriceInQuote(t: Pick<ParsedTrade, 'quoteMint' | 'quoteAmount' | 'quoteDecimals' | 'tokenAmount' | 'tokenDecimals'>): number | null {
  if (!t.quoteMint || t.quoteAmount === 0n || t.tokenAmount === 0n) return null;
  return Number(t.quoteAmount) / 10 ** t.quoteDecimals / (Number(t.tokenAmount) / 10 ** t.tokenDecimals);
}
