import { parseWalletTrades, type ParsedTrade, type Venue } from '../parser/parseTrades.js';
import { NON_TRADE_MINTS, WSOL_MINT } from '../solana/constants.js';
import { PRIORITY } from '../solana/rpc.js';
import { normalizeTransaction, type RawTransaction } from '../stream/normalize.js';
import type { NormalizedTx } from '../stream/types.js';

/**
 * "What if I had copied this wallet?" – replays the wallet's last N tokens (buys and sells only, the
 * same detection as live copying) and prices every copy at the token's first trade at least
 * `delaySec` after the trader's, read from the chain. Sizing follows the "% of their trade size" rules.
 *
 * The live bot's rules apply: dev launches, blacklisted tokens and the token safety checks are
 * skipped, and the per-token budget counts only what is still held.
 *
 * Data: Helius getTransactionsForAddress, which lists any address's transactions in time order from
 * a given slot (≈10 credits per call: one history page = 100 transactions, one price lookup ≤ 50).
 */

export interface BacktestParams {
  wallet: string;
  /** How many of the wallet's most recent tokens to replay. */
  tokens: number;
  delaySec: number;
  /** % of their dollar amount you'd spend per buy. */
  copyPct: number;
  /** Smaller copies are raised to this. */
  minUsd: number;
  /** Total you'd put into one token. */
  maxUsdPerToken: number;
  /** Network + priority fee + tip you pay per trade, in SOL. */
  feePerTradeSol: number;
  copyCreatorBuys: boolean;
  /** The live bot's token checks (Settings → Safety). */
  safety: { skipFreezeAuthority: boolean; skipMintAuthority: boolean; skipRiskyToken2022: boolean; maxTransferFeePct: number; blacklist: readonly string[] };
  quoteMints: ReadonlySet<string>;
  /** Used to convert everything to dollars (today's price). */
  solUsd: number;
}

export interface BacktestTrade {
  signature: string;
  time: number | null;
  side: 'buy' | 'sell';
  /** Buy: share of their balance; sell: share of their position. */
  pct: number;
  theirUsd: number;
  theirMcUsd: number | null;
  /** null when not copied (see note). */
  yourUsd: number | null;
  yourMcUsd: number | null;
  /** Transaction whose price your copy used, and how long after the trader's it landed. */
  pricedBy: string | null;
  lagMs: number | null;
  note: string | null;
}

export interface BacktestToken {
  mint: string;
  symbol: string | null;
  trades: BacktestTrade[];
  theirCostUsd: number;
  theirProceedsUsd: number;
  /** Trader's result on the trades in the window (open part valued now). */
  theirPnlUsd: number;
  theirPnlPct: number | null;
  yourCostUsd: number;
  yourProceedsUsd: number;
  yourFeesUsd: number;
  /** Value of what you'd still hold, at the latest trade's price. */
  yourOpenUsd: number;
  yourPnlUsd: number;
  yourPnlPct: number | null;
  stillOpen: boolean;
}

export interface BacktestResult {
  wallet: string;
  delaySec: number;
  tokens: BacktestToken[];
  totals: { costUsd: number; proceedsUsd: number; openUsd: number; feesUsd: number; pnlUsd: number; pnlPct: number | null; theirPnlUsd: number; wins: number; losses: number };
  scannedTxs: number;
  creditsEstimate: number;
  warnings: string[];
}

/** What the bot knows about a token's mint (today's state). */
export interface TokenFacts {
  supply: bigint;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  riskyExtensions: string | null;
  transferFeeBps: number | null;
}

export interface BacktestRpc {
  call<T>(method: string, params: unknown[], priority?: number): Promise<T>;
}

interface Page {
  data: Array<RawTransaction & { transactionIndex?: number }>;
  paginationToken: string | null;
}

const PAGE = 100;
const MAX_PAGES = 30;
const PRICE_LOOKAHEAD = 50;
/** No trade within this long after your copy would land → the token was quiet; use the last trade before it. */
const QUIET_MS = 10_000;
/** Fewer raw units than this can't give a meaningful price (e.g. a split delivery). */
const MIN_PRICED_RAW = 1000n;
/**
 * Several tokens bought (or sold) for one payment: the parser splits the payment by what each
 * token's seller received, or evenly when it can't tell – too rough to price a copy from.
 */
const isSplit = (t: Pick<ParsedTrade, 'note'>) => t.note === 'multi-buy' || t.note === 'multi-sell';
/** Solana makes a block about every 400 ms. */
const SLOT_MS = 400;
/** Fee a trader pays on top of the pool price, by venue (used when your side differs from the trade that priced it). */
const VENUE_FEE: Record<string, number> = { pumpfun: 0.0125, pumpswap: 0.003, dex: 0.003 };

const LAMPORTS = 1e9;

export class Backtester {
  private credits = 0;
  private scanned = 0;

  constructor(
    private readonly rpc: BacktestRpc,
    private readonly symbol: (mint: string) => string | null = () => null,
    private readonly tokenFacts: (mint: string) => Promise<TokenFacts | null> = async () => null,
  ) {}

  async run(p: BacktestParams): Promise<BacktestResult> {
    const warnings: string[] = [];
    const { byMint, order } = await this.history(p, warnings);
    const tokens = await Promise.all(order.map((mint) => this.replay(mint, byMint.get(mint)!, p)));
    const t = tokens.reduce(
      (s, x) => ({
        costUsd: s.costUsd + x.yourCostUsd,
        proceedsUsd: s.proceedsUsd + x.yourProceedsUsd,
        openUsd: s.openUsd + x.yourOpenUsd,
        feesUsd: s.feesUsd + x.yourFeesUsd,
        pnlUsd: s.pnlUsd + x.yourPnlUsd,
        theirPnlUsd: s.theirPnlUsd + x.theirPnlUsd,
        wins: s.wins + (x.yourCostUsd > 0 && x.yourPnlUsd > 0 ? 1 : 0),
        losses: s.losses + (x.yourCostUsd > 0 && x.yourPnlUsd <= 0 ? 1 : 0),
      }),
      { costUsd: 0, proceedsUsd: 0, openUsd: 0, feesUsd: 0, pnlUsd: 0, theirPnlUsd: 0, wins: 0, losses: 0 },
    );
    return {
      wallet: p.wallet,
      delaySec: p.delaySec,
      tokens,
      totals: { ...t, pnlPct: t.costUsd > 0 ? (t.pnlUsd / t.costUsd) * 100 : null },
      scannedTxs: this.scanned,
      creditsEstimate: this.credits,
      warnings,
    };
  }

  /** Newest-first pages of the wallet until its `tokens` most recent bought tokens are found. */
  private async history(p: BacktestParams, warnings: string[]) {
    const byMint = new Map<string, ParsedTrade[]>();
    const order: string[] = [];
    let token: string | null = null;
    let pagesAfterFull = 0;
    let page = 0;
    for (; page < MAX_PAGES; page++) {
      const res: Page = await this.page(p.wallet, { sortOrder: 'desc', limit: PAGE, filters: { status: 'succeeded' }, ...(token ? { paginationToken: token } : {}) });
      for (const raw of res.data) {
        const tx = this.normalize(raw);
        if (!tx || tx.err) continue;
        for (const t of parseWalletTrades(tx, p.wallet, p.quoteMints)) {
          if ((t.side !== 'buy' && t.side !== 'sell') || !t.quoteMint || t.liquidityOnly || NON_TRADE_MINTS.has(t.mint)) continue;
          // Newest first: a token's sells show up before its buy, so keep everything and pick the
          // tokens by their most recent buy.
          const list = byMint.get(t.mint);
          if (list) list.push(t);
          else byMint.set(t.mint, [t]);
          if (t.side === 'buy' && order.length < p.tokens && !order.includes(t.mint)) order.push(t.mint);
        }
      }
      token = res.paginationToken;
      if (!token) break;
      // One more page after the last token appears, to pick up its earlier buys.
      if (order.length >= p.tokens && pagesAfterFull++ >= 1) break;
    }
    if (page === MAX_PAGES && order.length < p.tokens) warnings.push(`stopped after ${MAX_PAGES * PAGE} transactions – found ${order.length} tokens`);
    if (!order.length) warnings.push('no token buys found for this wallet');
    for (const list of byMint.values()) list.sort((a, b) => a.slot - b.slot);
    // Sells before the first buy in the window belong to an older position – not replayed.
    for (const mint of order) {
      const list = byMint.get(mint)!;
      byMint.set(mint, list.slice(list.findIndex((t) => t.side === 'buy')));
    }
    return { byMint, order };
  }

  private async replay(mint: string, trades: ParsedTrade[], p: BacktestParams): Promise<BacktestToken> {
    const usd = (lamports: number) => (lamports / LAMPORTS) * p.solUsd;
    const facts = await this.tokenFacts(mint).catch(() => null);
    const mc = (lamportsPerRaw: number | null) =>
      lamportsPerRaw == null || !facts ? null : usd(lamportsPerRaw * Number(facts.supply));
    const unsafe = this.unsafe(mint, facts, p);
    const feeLamports = p.feePerTradeSol * LAMPORTS;

    let held = 0; // your raw tokens
    let theirHeld = 0;
    // costL: everything you put in; openCostL: the part still held – the per-token budget, like the live bot.
    let costL = 0, openCostL = 0, proceedsL = 0, feesL = 0, theirCostL = 0, theirProceedsL = 0;
    let lastPrice: number | null = null;
    const out: BacktestTrade[] = [];

    for (const t of trades) {
      const theirL = this.quoteLamports(t, p);
      const theirPrice = t.tokenAmount >= MIN_PRICED_RAW && !isSplit(t) ? theirL / Number(t.tokenAmount) : null;
      // A fill with (almost) no tokens can't be valued – leave it out of the trader's result.
      if (theirPrice != null) {
        if (t.side === 'buy') { theirCostL += theirL; theirHeld += Number(t.tokenAmount); }
        else { theirProceedsL += theirL; theirHeld = Math.max(0, theirHeld - Number(t.tokenAmount)); }
      }
      const row: BacktestTrade = {
        signature: t.signature, time: t.blockTime, side: t.side as 'buy' | 'sell', pct: t.fullExit ? 1 : t.pct,
        theirUsd: usd(theirL), theirMcUsd: mc(theirPrice), yourUsd: null, yourMcUsd: null, pricedBy: null, lagMs: null, note: null,
      };
      out.push(row);
      if (theirPrice) lastPrice = theirPrice;
      // The live bot copies these too, with the payment split – shown so it's visible.
      if (isSplit(t)) row.note = `${t.side === 'buy' ? 'bought' : 'sold'} together with another token – their amount is split between them`;

      if (t.side === 'buy') {
        if (unsafe) { row.note = `not copied – ${unsafe}`; continue; }
        if (t.createdInTx && !p.copyCreatorBuys) { row.note = 'dev launch – not copied'; continue; }
        const minL = (p.minUsd / p.solUsd) * LAMPORTS;
        const budgetL = (p.maxUsdPerToken / p.solUsd) * LAMPORTS - openCostL;
        if (budgetL < minL) { row.note = `per-token budget of $${p.maxUsdPerToken} used up`; continue; }
        const spendL = Math.min(Math.max((theirL * p.copyPct) / 100, minL), budgetL);
        const q = (await this.priceAfter(mint, t, 'buy', p)) ?? (await this.priceBefore(mint, t, 'buy', p));
        if (!q) { row.note = 'no price for the copy'; continue; }
        if (q.note) row.note = row.note ? `${row.note}; ${q.note}` : q.note;
        held += spendL / q.price;
        costL += spendL;
        openCostL += spendL;
        feesL += feeLamports;
        lastPrice = q.last ?? lastPrice;
        Object.assign(row, { yourUsd: usd(spendL), yourMcUsd: mc(q.price), pricedBy: q.signature, lagMs: q.lagMs });
      } else {
        if (held <= 0) { row.note = costL > 0 ? 'already sold everything' : 'nothing held'; continue; }
        const sellTokens = t.fullExit || t.pct >= 0.995 ? held : held * t.pct;
        const q = (await this.priceAfter(mint, t, 'sell', p)) ?? (await this.priceBefore(mint, t, 'sell', p));
        if (!q) { row.note = 'no price for the copy'; continue; }
        if (q.note) row.note = row.note ? `${row.note}; ${q.note}` : q.note;
        const gotL = sellTokens * q.price;
        openCostL -= openCostL * (sellTokens / held);
        held -= sellTokens;
        proceedsL += gotL;
        feesL += feeLamports;
        lastPrice = q.last ?? lastPrice;
        Object.assign(row, { yourUsd: usd(gotL), yourMcUsd: mc(q.price), pricedBy: q.signature, lagMs: q.lagMs });
      }
    }

    // Whatever is still held (by you or them) is valued at the token's latest trade.
    let nowPrice = lastPrice;
    if (held > 1 || theirHeld > 1) nowPrice = (await this.latestPrice(mint, p).catch(() => null)) ?? lastPrice;
    const openL = held > 1 && nowPrice ? held * nowPrice : 0;
    const theirOpenL = theirHeld > 1 && nowPrice ? theirHeld * nowPrice : 0;
    const yourPnlL = proceedsL + openL - costL - feesL;
    return {
      mint,
      symbol: this.symbol(mint),
      trades: out,
      theirCostUsd: usd(theirCostL),
      theirProceedsUsd: usd(theirProceedsL),
      theirPnlUsd: usd(theirProceedsL + theirOpenL - theirCostL),
      theirPnlPct: theirCostL > 0 ? ((theirProceedsL + theirOpenL - theirCostL) / theirCostL) * 100 : null,
      yourCostUsd: usd(costL),
      yourProceedsUsd: usd(proceedsL),
      yourFeesUsd: usd(feesL),
      yourOpenUsd: usd(openL),
      yourPnlUsd: usd(yourPnlL),
      yourPnlPct: costL > 0 ? (yourPnlL / costL) * 100 : null,
      stillOpen: held > 1,
    };
  }

  /** Why the live bot wouldn't buy this token (Settings → Safety), or null. */
  private unsafe(mint: string, f: TokenFacts | null, p: BacktestParams): string | null {
    const s = p.safety;
    if (s.blacklist.includes(mint)) return 'token is blacklisted';
    if (!f) return null;
    if (s.skipFreezeAuthority && f.freezeAuthority) return 'token has a freeze authority';
    if (s.skipMintAuthority && f.mintAuthority) return 'more of this token can still be minted';
    if (s.skipRiskyToken2022 && f.riskyExtensions) return `risky token: ${f.riskyExtensions}`;
    if (f.transferFeeBps && f.transferFeeBps > s.maxTransferFeePct * 100) return `transfer fee ${f.transferFeeBps / 100}% is above your ${s.maxTransferFeePct}% limit`;
    return null;
  }

  /** SOL value of the quote leg (stablecoins converted at today's SOL price). */
  private quoteLamports(t: Pick<ParsedTrade, 'quoteMint' | 'quoteAmount' | 'quoteDecimals'>, p: BacktestParams): number {
    if (!t.quoteMint || t.quoteMint === WSOL_MINT) return Number(t.quoteAmount);
    return ((Number(t.quoteAmount) / 10 ** t.quoteDecimals) / p.solUsd) * LAMPORTS;
  }

  /**
   * Nothing traded soon after: the price stood where the last trade before your copy left it
   * (usually the trader's own; other wallets' trades are used to price it).
   */
  private async priceBefore(mint: string, t: ParsedTrade, side: 'buy' | 'sell', p: BacktestParams) {
    const atSlot = t.slot + Math.max(1, Math.ceil((p.delaySec * 1000) / SLOT_MS));
    const res = await this.page(mint, { sortOrder: 'desc', limit: PRICE_LOOKAHEAD, filters: { status: 'succeeded', slot: { lte: atSlot } } });
    for (const raw of res.data) {
      const tx = this.normalize(raw);
      const seen = tx && !tx.err ? this.swapIn(tx, mint, t.wallet, p) : null;
      if (!seen || !tx) continue;
      return { price: this.adjust(seen, side), last: seen.price, signature: tx.signature, lagMs: Math.round(p.delaySec * 1000), note: 'quiet token – priced at the last trade before your copy' };
    }
    return null;
  }

  /** A buyer pays pool price + fee, a seller gets pool price − fee: convert when the sides differ. */
  private adjust(seen: { price: number; side: 'buy' | 'sell'; venue: Venue }, side: 'buy' | 'sell'): number {
    if (seen.side === side) return seen.price;
    const fee = VENUE_FEE[seen.venue ?? 'dex'] ?? 0.003;
    return side === 'buy' ? (seen.price * (1 + fee)) / (1 - fee) : (seen.price * (1 - fee)) / (1 + fee);
  }

  /**
   * Price (lamports per raw token) you'd have got: the token's first trade at least `delaySec` after
   * theirs. null when nothing traded within QUIET_MS after that.
   */
  private async priceAfter(mint: string, t: ParsedTrade, side: 'buy' | 'sell', p: BacktestParams) {
    const delaySlots = Math.max(1, Math.ceil((p.delaySec * 1000) / SLOT_MS));
    const fromSlot = t.slot + delaySlots;
    const res = await this.page(mint, {
      sortOrder: 'asc',
      limit: PRICE_LOOKAHEAD,
      filters: { status: 'succeeded', slot: { gte: fromSlot, lte: fromSlot + Math.ceil(QUIET_MS / SLOT_MS) } },
    });
    for (const raw of res.data) {
      const tx = this.normalize(raw);
      if (!tx || tx.err) continue;
      const seen = this.swapIn(tx, mint, t.wallet, p);
      if (!seen) continue;
      return {
        price: this.adjust(seen, side),
        last: seen.price,
        signature: tx.signature,
        // Slots are finer than block times (whole seconds).
        lagMs: (tx.slot - t.slot) * SLOT_MS,
        note: null as string | null,
      };
    }
    return null;
  }

  private async latestPrice(mint: string, p: BacktestParams): Promise<number | null> {
    const res = await this.page(mint, { sortOrder: 'desc', limit: PRICE_LOOKAHEAD, filters: { status: 'succeeded' } });
    for (const raw of res.data) {
      const tx = this.normalize(raw);
      const seen = tx && !tx.err ? this.swapIn(tx, mint, null, p) : null;
      if (seen) return seen.price;
    }
    return null;
  }

  /**
   * A buy or sell of `mint` in this transaction, by anyone but `exclude`. The signer is tried first:
   * a pool's or bonding curve's own token account would show the same trade from the other side.
   */
  private swapIn(tx: NormalizedTx, mint: string, exclude: string | null, p: BacktestParams): { price: number; side: 'buy' | 'sell'; venue: Venue } | null {
    const signer = tx.accountKeys[0];
    if (exclude && signer === exclude) return null;
    const owners = new Set<string>(signer ? [signer] : []);
    for (const b of [...tx.preTokenBalances, ...tx.postTokenBalances]) if (b.mint === mint && b.owner) owners.add(b.owner);
    for (const owner of owners) {
      if (owner === exclude) continue;
      for (const s of parseWalletTrades(tx, owner, p.quoteMints)) {
        if (s.mint !== mint || (s.side !== 'buy' && s.side !== 'sell') || !s.quoteMint || s.tokenAmount < MIN_PRICED_RAW || isSplit(s)) continue;
        return { price: this.quoteLamports(s, p) / Number(s.tokenAmount), side: s.side, venue: s.venue };
      }
    }
    return null;
  }

  private async page(address: string, opts: Record<string, unknown>): Promise<Page> {
    const res = await this.rpc.call<Page>(
      'getTransactionsForAddress',
      [address, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, ...opts }],
      PRIORITY.background,
    );
    this.scanned += res.data.length;
    this.credits += Math.max(10, Math.ceil(res.data.length / 100) * 10);
    return res;
  }

  private normalize(raw: RawTransaction): NormalizedTx | null {
    const signature = (raw.transaction?.signatures ?? [])[0];
    return normalizeTransaction({ ...raw, signature });
  }
}
