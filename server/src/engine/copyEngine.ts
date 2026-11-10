import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  copyTrades,
  lots,
  myWallets,
  signals,
  traderGroups,
  watchedWallets,
  type CopyTrade,
  type Lot,
  type MyWallet,
  type Signal,
  type Token,
  type TraderGroup,
  type WatchedWallet,
} from '../db/schema.js';
import { publish } from '../events.js';
import { SwapError, type Submission, type Executor, type SwapFill, type SwapParams } from '../executor/executors.js';
import type { Keystore } from '../keystore/keystore.js';
import { parseWalletTrades, tradePriceInQuote, type ParsedTrade, type Venue } from '../parser/parseTrades.js';
import type { PriceService } from '../prices/priceService.js';
import type { SettingsStore } from '../settings.js';
import type { AccountService } from '../solana/accounts.js';
import { DEFAULT_QUOTE_MINTS, NON_TRADE_MINTS, USD1_MINT, USDC_MINT, USDT_MINT, WSOL_MINT } from '../solana/constants.js';
import { PRIORITY } from '../solana/rpc.js';
import type { TokenService } from '../solana/tokens.js';
import { involvedAddresses } from '../stream/normalize.js';
import type { StreamTx } from '../stream/types.js';
import { errorMessage, KeyedQueue, lamportsToSol, mulFraction, shortAddr, sleep, solToLamports } from '../util/misc.js';
import { cashBasis, missingCash, quoteValueUsd } from './basis.js';
import { applyBuy, applySell, splitAcrossLots, type LotState } from './lotMath.js';
import { sellSlippages, sizeBuy, sizeBuyBySize, sizeSell, type SizingResult } from './sizing.js';

const USD_QUOTES = new Set([USDC_MINT, USDT_MINT, USD1_MINT]);
const ROUTE_LABEL: Record<string, string> = { pumpfun: 'pump.fun direct', pumpswap: 'PumpSwap direct', jupiter: 'Jupiter' };

type Watched = WatchedWallet & { groupName: string };

export interface EngineDeps {
  cfg: Config;
  db: Db;
  settings: SettingsStore;
  keystore: Keystore;
  accounts: AccountService;
  tokens: TokenService;
  prices: PriceService;
  live: Executor;
  paper: Executor;
  log: Logger;
}

const toLotState = (l: Lot): LotState => ({
  tokenAmount: BigInt(l.tokenAmount),
  costLamports: l.costLamports,
  totalCostLamports: l.totalCostLamports,
  proceedsLamports: l.proceedsLamports,
  realizedLamports: l.realizedLamports,
  boughtAmount: BigInt(l.boughtAmount),
  soldAmount: BigInt(l.soldAmount),
  entryMcUsd: l.entryMcUsd,
  exitMcUsd: l.exitMcUsd,
});

const fromLotState = (s: LotState) => ({
  tokenAmount: s.tokenAmount.toString(),
  costLamports: s.costLamports,
  totalCostLamports: s.totalCostLamports,
  proceedsLamports: s.proceedsLamports,
  realizedLamports: s.realizedLamports,
  boughtAmount: s.boughtAmount.toString(),
  soldAmount: s.soldAmount.toString(),
  entryMcUsd: s.entryMcUsd,
  exitMcUsd: s.exitMcUsd,
});

export function marketCapUsd(priceUsd: number | null, token: Pick<Token, 'supply' | 'decimals'> | undefined): number | null {
  if (priceUsd == null || !token) return null;
  return (priceUsd * Number(BigInt(token.supply))) / 10 ** token.decimals;
}

/**
 * Turns trades detected on watched wallets into trades on your wallets.
 * Work for the same wallet+token is serialized, so a sell never overtakes the buy it belongs to.
 */
export class CopyEngine {
  private queue = new KeyedQueue();
  private admissions = new KeyedQueue();
  private reservations = new Map<number, { walletId: number; paper: boolean; mint: string; amount: number }>();
  private reservationId = 0;
  private active = new Set<number>();
  private recovering = false;
  private watched = new Map<string, Watched>();

  constructor(private readonly d: EngineDeps) {}

  /** Reloads the watched-wallet list; returns the addresses the stream should follow. */
  reloadWatched(): string[] {
    const rows = this.d.db
      .select({ w: watchedWallets, groupName: traderGroups.name })
      .from(watchedWallets)
      .innerJoin(traderGroups, eq(watchedWallets.groupId, traderGroups.id))
      .where(eq(watchedWallets.enabled, true))
      .all();
    this.watched = new Map(rows.map((r) => [r.w.address, { ...r.w, groupName: r.groupName }]));
    return [...this.watched.keys()];
  }

  quoteMints(): Set<string> {
    return new Set([...DEFAULT_QUOTE_MINTS, ...this.d.settings.get().extraQuoteMints]);
  }

  // ── detection ─────────────────────────────────────────────────────────────

  async onTx(st: StreamTx): Promise<void> {
    const involved = involvedAddresses(st.tx);
    const quoteMints = this.quoteMints();
    const found: Array<{ w: Watched; t: ParsedTrade }> = [];
    for (const [address, w] of this.watched) {
      if (!involved.has(address)) continue;
      const trades = parseWalletTrades(st.tx, address, quoteMints);
      if (!trades.length) this.d.log.debug({ signature: st.tx.signature, wallet: shortAddr(address) }, 'no trade in transaction');
      for (const t of trades) found.push({ w, t });
    }
    for (const { w, t } of found) await this.recordSignal(t, w, st);
  }

  private async recordSignal(t: ParsedTrade, w: Watched, st: StreamTx) {
    const { db, log } = this.d;
    const row = db
      .insert(signals)
      .values({
        signature: t.signature,
        watchedWalletId: w.id,
        address: w.address,
        slot: t.slot,
        blockTime: t.blockTime,
        detectedAt: st.detectedAt,
        side: t.side,
        mint: t.mint,
        tokenDecimals: t.tokenDecimals,
        tokenAmount: t.tokenAmount.toString(),
        preTokenBalance: t.preTokenBalance.toString(),
        postTokenBalance: t.postTokenBalance.toString(),
        quoteMint: t.quoteMint,
        quoteAmount: t.quoteMint ? t.quoteAmount.toString() : null,
        preQuoteBalance: t.quoteMint ? t.preQuoteBalance.toString() : null,
        pct: t.pct,
        fullExit: t.fullExit,
        source: st.source,
        venue: t.venue,
        note: t.note,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!row) return; // duplicate notification or backfill

    const who = w.label || shortAddr(w.address);
    const lag = t.blockTime ? ` (${((st.detectedAt - t.blockTime) / 1000).toFixed(1)}s after block)` : '';
    log.info(
      `${t.side.toUpperCase()} detected · ${w.groupName}/${who} · ${this.d.tokens.symbol(t.mint)} ${(t.pct * 100).toFixed(1)}%` +
        `${t.fullExit ? ' (full exit)' : ''}${lag}${t.note ? ` · ${t.note}` : ''}`,
    );
    publish({ type: 'signal', signal: row });

    if (t.side === 'buy' || t.side === 'sell' || t.side === 'transfer_out') {
      const group = db.select().from(traderGroups).where(eq(traderGroups.id, w.groupId)).get();
      if (group) {
        void this.queue
          .run(`${group.myWalletId}:${t.mint}`, () => this.processSignal(row, t, w, group, st))
          .catch((err) => log.error({ err: errorMessage(err), signature: t.signature }, 'copy failed'));
      }
    }
    // Trader's entry/exit market cap, filled in without delaying the copy.
    if (t.side === 'buy' || t.side === 'sell') void this.annotateSignal(row, t).catch(() => undefined);
  }

  private async annotateSignal(row: Signal, t: ParsedTrade) {
    const priceQuote = tradePriceInQuote(t);
    if (priceQuote == null || !t.quoteMint) return;
    const quoteUsd =
      t.quoteMint === WSOL_MINT ? await this.d.prices.solUsdFresh() : USD_QUOTES.has(t.quoteMint) ? 1 : this.d.prices.priceUsd(t.quoteMint);
    if (quoteUsd == null) return;
    const priceUsd = priceQuote * quoteUsd;
    const spentUsd = (Number(t.quoteAmount) / 10 ** t.quoteDecimals) * quoteUsd;
    const token = await this.d.tokens.get(t.mint);
    const mc = marketCapUsd(priceUsd, token);
    this.d.prices.observe(t.mint, priceUsd);
    const updated = this.d.db.update(signals).set({ priceUsd, marketCapUsd: mc, spentUsd }).where(eq(signals.id, row.id)).returning().get();
    if (updated) publish({ type: 'signal', signal: updated });
  }

  // ── copying ───────────────────────────────────────────────────────────────

  private async processSignal(signal: Signal, t: ParsedTrade, w: Watched, groupAtDetect: TraderGroup, st: StreamTx) {
    const { db, settings, cfg, keystore } = this.d;
    const group = db.select().from(traderGroups).where(eq(traderGroups.id, groupAtDetect.id)).get() ?? groupAtDetect;
    const wallet = db.select().from(myWallets).where(eq(myWallets.id, group.myWalletId)).get();
    if (!wallet) return;
    const s = settings.get();
    if (db.select().from(copyTrades).where(eq(copyTrades.signalId, signal.id)).get()) return;
    const side = t.side === 'buy' ? 'buy' : 'sell';
    const ctx: TradeCtx & { group: TraderGroup } = {
      group,
      wallet,
      paper: group.paper,
      sourceWalletId: w.id,
      signalId: signal.id,
      label: `${group.name}/${w.label || shortAddr(w.address)}`,
    };

    const skip = (reason: string) => this.recordSkip(ctx, side, t.mint, t.pct, reason);

    if (!ctx.paper && this.unresolved(wallet.id, t.mint, side === 'buy')) return skip('previous transaction outcome unresolved – waiting for recovery');
    if (s.paused) return skip(`bot is paused${s.pausedReason ? ` (${s.pausedReason})` : ''}`);
    if (!ctx.paper && !cfg.liveTrading) return skip('live trading is off (LIVE_TRADING=false in .env)');
    if (!ctx.paper && !keystore.isUnlocked) return skip('keystore is locked – log in to unlock');
    const ageSec = (Date.now() - (t.blockTime ?? st.detectedAt)) / 1000;
    if (ageSec > s.maxSignalAgeSec) return skip(`signal is ${ageSec.toFixed(0)}s old (max ${s.maxSignalAgeSec}s)`);
    if (s.blacklist.includes(t.mint)) return skip('token is blacklisted');

    if (side === 'buy') {
      if (!group.enabled) return skip('trader group is paused');
      if (!w.copyBuys) return skip('copying buys is off for this wallet');
      if (t.createdInTx && !s.copyCreatorBuys) return skip('the trader created this token in the same transaction (dev launch) – not copied');
      // Swapping into a stablecoin, staked SOL or wrapped BTC/ETH is cashing out or bridging, not a memecoin buy.
      if (NON_TRADE_MINTS.has(t.mint)) return skip(`swap into ${this.d.tokens.symbol(t.mint)} – looks like cashing out or bridging, not copied`);
      return this.copyBuy(ctx, t, w, st, signal.id);
    }
    if (t.liquidityOnly) return skip('liquidity or staking movement – not a wallet transfer');
    if (!w.copySells) return skip('copying sells is off for this wallet');
    return this.copySell(ctx, t.side === 'transfer_out' ? { ...t, side: 'sell', venue: null } : t);
  }

  private async copyBuy(ctx: TradeCtx & { group: TraderGroup }, t: ParsedTrade, w: Watched, st: StreamTx, signalId: number) {
    const { db, settings, accounts, tokens } = this.d;
    const s = settings.get();
    const { group, wallet, paper } = ctx;
    const skip = (reason: string, pct = t.pct) => this.recordSkip(ctx, 'buy', t.mint, pct, reason);

    const admission = await this.admissions.run(`${wallet.id}:${paper}`, async () => {
      if (!paper && this.unresolved(wallet.id, t.mint)) return skip('previous transaction outcome unresolved – waiting for recovery');
      const prior = this.reserved(wallet.id, paper);
      // Cheap local checks first, so no lookups are spent on a buy that won't be copied.
      const open = this.openLots(wallet.id, paper);
      const holds = open.filter((l) => l.mint === t.mint);
      if (group.skipIfHolding && holds.length) return skip('already holding this token');
      const openMints = new Set([...open.map((l) => l.mint), ...[...prior.values()].map((r) => r.mint)]);
      // 0 = no limit.
      if (group.maxOpenPositions > 0 && !holds.length && openMints.size >= group.maxOpenPositions)
        return skip(`max ${group.maxOpenPositions} open positions reached`);

      if (!paper && s.dailyLossLimitSol > 0) {
        const today = this.realizedToday(false);
        if (today <= -solToLamports(s.dailyLossLimitSol)) {
          settings.update({ paused: true, pausedReason: `daily loss limit of ${s.dailyLossLimitSol} SOL hit` });
          publish({ type: 'status' });
          const limitUsd = this.d.prices.solUsd ? ` ($${(s.dailyLossLimitSol * this.d.prices.solUsd).toFixed(2)})` : '';
          publish({ type: 'alert', text: `⛔ <b>Daily loss limit${limitUsd} hit – all trading paused.</b> Resume it on the dashboard.` });
          return skip('daily loss limit hit – bot paused');
        }
      }

      // Lookups at once: token safety, your balance, the SOL price (usually cached) and – only in
      // "% of their cash" mode – the trader's stablecoin balances.
      const sizeMode = group.sizingMode === 'size';
      const [tokenRes, basisRes, balanceRes, solUsdRes] = await Promise.allSettled([
        tokens.get(t.mint),
        sizeMode ? Promise.resolve(null) : this.traderCash(t, st),
        paper ? Promise.resolve(this.paperCash(group, wallet.id)) : accounts.solBalance(wallet.pubkey, 0, PRIORITY.trade),
        this.d.prices.solUsdFresh(),
      ]);
      if (!paper && this.unresolved(wallet.id, t.mint)) return skip('previous transaction outcome unresolved – waiting for recovery');
      if (tokenRes.status === 'rejected') return skip(`could not read token: ${errorMessage(tokenRes.reason)}`);
      const token = tokenRes.value;
      if (s.skipFreezeAuthority && token.freezeAuthority) return skip('token has a freeze authority (could be frozen/unsellable)');
      if (s.skipMintAuthority && token.mintAuthority) return skip('more of this token can still be minted (mint authority active)');
      if (s.skipRiskyToken2022 && token.riskyExtensions) return skip(`risky token: ${token.riskyExtensions}`);
      if (token.transferFeeBps && token.transferFeeBps > s.maxTransferFeePct * 100)
        return skip(`transfer fee ${token.transferFeeBps / 100}% is above your ${s.maxTransferFeePct}% limit`);
      if (balanceRes.status === 'rejected') return skip(`could not read balance: ${errorMessage(balanceRes.reason)}`);
      // Include reservations that completed while the balance request was in flight.
      const reserved = new Map([...prior, ...this.reserved(wallet.id, paper)]);
      const balance = balanceRes.value - [...reserved.values()].reduce((sum, r) => sum + r.amount, 0);
      const exposure = holds.reduce((sum, l) => sum + l.costLamports, 0);
      const solUsd = solUsdRes.status === 'fulfilled' ? solUsdRes.value : null;

      let pct = t.pct;
      let size: SizingResult;
      if (sizeMode) {
        // Copy a fixed % of the dollars they spent.
        if (!solUsd) return skip('SOL price unavailable – can’t convert dollar amounts');
        const theirSpentUsd = quoteValueUsd(t, solUsd, (m) => this.d.prices.priceUsd(m));
        if (theirSpentUsd == null) return skip(`can’t value their payment in ${this.d.tokens.symbol(t.quoteMint ?? WSOL_MINT)}`);
        size = sizeBuyBySize({
          theirSpentUsd,
          copyPct: group.copyPct,
          solUsd,
          balanceLamports: balance,
          reserveLamports: Math.max(solToLamports(group.reserveSol), this.feeReserve(paper)),
          minUsd: group.minUsd,
          maxPctOfBalance: group.maxPct,
          tokenExposureLamports: exposure,
          maxUsdPerToken: group.maxUsdPerToken,
        });
      } else {
        // Their % of SOL + USDC + USDT + USD1. Falls back to the share of the asset they paid with.
        const basis = basisRes.status === 'fulfilled' ? basisRes.value : null;
        if (basisRes.status === 'rejected')
          this.d.log.warn(
            { err: errorMessage(basisRes.reason) },
            `could not read ${w.label || shortAddr(w.address)}'s stablecoin balances – using their ${this.d.tokens.symbol(t.quoteMint ?? WSOL_MINT)} balance only`,
          );
        pct = basis?.pct ?? t.pct;
        if (basis) {
          const updated = db.update(signals).set({ pct, basisUsd: basis.basisUsd, spentUsd: basis.spentUsd }).where(eq(signals.id, signalId)).returning().get();
          if (updated) publish({ type: 'signal', signal: updated });
        }
        size = sizeBuy({
          pct,
          balanceLamports: balance,
          reserveLamports: Math.max(solToLamports(group.reserveSol), this.feeReserve(paper)),
          multiplier: group.multiplier,
          minLamports: solToLamports(group.minSol),
          maxLamports: solToLamports(group.maxSol),
          maxPct: group.maxPct,
          tokenExposureLamports: exposure,
          maxPerTokenLamports: solToLamports(group.maxSolPerToken),
        });
      }
      if (!size.ok) return skip(size.reason, pct);

      const id = ++this.reservationId;
      this.reservations.set(id, { walletId: wallet.id, paper, mint: t.mint, amount: size.lamports + this.feeReserve(paper) });
      return { id, size, pct, token };
    });
    if (!admission) return;
    try {
      await this.executeBuy(ctx, t.mint, BigInt(admission.size.lamports), admission.pct, admission.token, t.venue, admission.size.clampedBy);
    } finally { this.reservations.delete(admission.id); }
  }

  /** The trader's buy as a share of all their cash (SOL + stablecoins), reading only what the tx doesn't show. */
  private async traderCash(t: ParsedTrade, st: StreamTx) {
    const missing = missingCash(st.tx, t.wallet);
    const [solUsd, fetched] = await Promise.all([
      this.d.prices.solUsdFresh(),
      missing.stables.length || missing.sol ? this.d.accounts.cashBalances(t.wallet, missing.stables, missing.sol) : Promise.resolve(null),
    ]);
    return solUsd ? cashBasis(t, st.tx, solUsd, fetched) : null;
  }

  private async executeBuy(ctx: TradeCtx, mint: string, lamports: bigint, pct: number | null, token: Token, venue: Venue, note: string | null = null) {
    const { db } = this.d;
    const { group, wallet, paper } = ctx;
    const exec = paper ? this.d.paper : this.d.live;
    const trade = this.insertTrade(ctx, 'buy', mint, pct, { status: 'pending', solLamports: Number(lamports), tokenDecimals: token.decimals, recovery: JSON.stringify({ lotIds: [] }), skipReason: note });
    publish({ type: 'trade', trade });

    let fill: SwapFill;
    this.active.add(trade.id);
    try {
      fill = await exec.swap({
        wallet: wallet.pubkey,
        inputMint: WSOL_MINT,
        outputMint: mint,
        amount: lamports,
        slippageBps: group?.slippageBps ?? null,
        venue,
        tokenProgram: token.tokenProgram,
        onSubmit: this.submissionRecorder(trade, []),
      });
    } catch (err) {
      await this.executionError(trade, err, 1);
      return;
    } finally { this.active.delete(trade.id); }
    this.bookBuy(ctx, trade, fill, token, note);
  }

  private bookBuy(ctx: TradeCtx, trade: CopyTrade, fill: SwapFill, token: Pick<Token, 'decimals' | 'supply'>, note: string | null) {
    const { db, log, accounts, prices } = this.d;
    const { group, wallet, paper } = ctx;
    const mint = trade.mint;
    // Book immediately using the cached price; metadata requests must not delay persistence.
    const solUsd = prices.solUsd;
    const priceSol = lamportsToSol(fill.inAmount) / (Number(fill.outAmount) / 10 ** token.decimals);
    const priceUsd = solUsd ? priceSol * solUsd : null;
    const mc = marketCapUsd(priceUsd, token);
    if (priceUsd) prices.observe(mint, priceUsd);

    const done = db.transaction((tx) => {
      const updated = tx
        .update(copyTrades)
        .set({
          status: 'confirmed',
          error: null,
          recovery: null,
          solLamports: Number(fill.inAmount),
          tokenAmount: fill.outAmount.toString(),
          feeLamports: fill.feeLamports,
          signature: fill.signature,
          route: paper ? `paper:${fill.route}` : fill.route,
          priceUsd,
          solUsd,
          marketCapUsd: mc,
          attempts: 1,
          sentAt: fill.sentAt,
          confirmedAt: fill.confirmedAt,
          skipReason: note,
        })
        .where(eq(copyTrades.id, trade.id))
        .returning()
        .get()!;
      const existing = tx
        .select()
        .from(lots)
        .where(
          and(
            eq(lots.myWalletId, wallet.id),
            ctx.sourceWalletId === null ? sql`${lots.sourceWalletId} IS NULL` : eq(lots.sourceWalletId, ctx.sourceWalletId),
            eq(lots.mint, mint),
            eq(lots.paper, paper),
            eq(lots.status, 'open'),
          ),
        )
        .get();
      const state = applyBuy(existing ? toLotState(existing) : null, {
        tokens: fill.outAmount,
        costLamports: Number(fill.inAmount) + fill.feeLamports,
        mcUsd: mc,
      });
      if (existing) {
        tx.update(lots).set({ ...fromLotState(state), lastPriceSol: priceSol }).where(eq(lots.id, existing.id)).run();
      } else {
        tx.insert(lots)
          .values({
            myWalletId: wallet.id,
            groupId: group?.id ?? null,
            sourceWalletId: ctx.sourceWalletId,
            mint,
            paper,
            tokenDecimals: token.decimals,
            openedAt: Date.now(),
            lastPriceSol: priceSol,
            ...fromLotState(state),
          })
          .run();
      }
      return updated;
    });

    accounts.invalidate(wallet.pubkey);
    log.info(
      `${paper ? 'paper' : 'LIVE'} BUY ✓ · ${ctx.label} · ${lamportsToSol(fill.inAmount).toFixed(4)} SOL → ${this.d.tokens.symbol(mint)}` +
        `${mc ? ` @ MC $${compact(mc)}` : ''} · via ${ROUTE_LABEL[fill.route]} · ${fill.confirmedAt - fill.sentAt}ms${note ? ` · ${note}` : ''}`,
    );
    publish({ type: 'trade', trade: done });
    publish({ type: 'positions' });
  }

  private async copySell(ctx: TradeCtx, t: ParsedTrade) {
    const { db, log, accounts } = this.d;
    const { wallet, paper } = ctx;
    const lot = db
      .select()
      .from(lots)
      .where(
        and(
          eq(lots.myWalletId, wallet.id),
          eq(lots.sourceWalletId, ctx.sourceWalletId!),
          eq(lots.mint, t.mint),
          eq(lots.paper, paper),
          eq(lots.status, 'open'),
        ),
      )
      .get();
    if (!lot) {
      // Nothing to sell. Still report it when this group tried to copy the token, so you see the exit.
      const reason = this.noPositionReason(ctx, t.mint);
      if (reason) return this.recordSkip(ctx, 'sell', t.mint, t.pct, reason);
      log.debug({ mint: t.mint }, `sell by ${ctx.label} ignored – no position copied from this wallet`);
      return;
    }
    let amount = sizeSell(BigInt(lot.tokenAmount), t.pct, t.fullExit);
    let closeAll = false;
    if (!paper) {
      const onChain = await accounts.tokenBalance(wallet.pubkey, t.mint).catch(() => null);
      if (onChain === 0n) {
        this.closeLotsOutside([lot], 'token balance is zero on-chain (sold or moved outside the bot)');
        return this.recordSkip(ctx, 'sell', t.mint, t.pct, 'nothing left to sell on-chain');
      }
      // Asked for more than is there (e.g. a token's transfer fee kept back part of the buy): sell
      // everything and close the position, instead of leaving a remainder that doesn't exist.
      if (onChain != null && amount > onChain) {
        amount = onChain;
        closeAll = true;
      }
    }
    if (amount === 0n) return this.recordSkip(ctx, 'sell', t.mint, t.pct, 'nothing to sell');
    await this.executeSell(ctx, t.mint, amount, t.pct, [lot], t.venue, closeAll);
  }

  /** Sells `amount` and books the result across `lotsToReduce` (one lot for copies, all lots for manual closes). */
  private async executeSell(ctx: TradeCtx, mint: string, amount: bigint, pct: number | null, lotsToReduce: Lot[], venue: Venue = null, closeAll = false) {
    const { db, log, settings, tokens } = this.d;
    const { group, wallet, paper } = ctx;
    const exec = paper ? this.d.paper : this.d.live;
    const decimals = lotsToReduce[0].tokenDecimals;
    const trade = this.insertTrade(ctx, 'sell', mint, pct, { status: 'pending', tokenAmount: amount.toString(), tokenDecimals: decimals, recovery: JSON.stringify({ lotIds: lotsToReduce.map((l) => l.id) }) });
    publish({ type: 'trade', trade });

    // Failing to exit is the biggest risk, so sells retry with progressively wider slippage.
    const slippages = sellSlippages(group?.slippageBps ?? null, settings.get().sellRetries);
    let fill: SwapFill | null = null;
    let lastError = '';
    let attempts = 0;
    this.active.add(trade.id);
    try {
      for (const slippageBps of slippages) {
        attempts++;
        try {
          const p: SwapParams = {
            wallet: wallet.pubkey,
            inputMint: mint,
            outputMint: WSOL_MINT,
            amount,
            slippageBps,
            venue,
            tokenProgram: tokens.cached(mint)?.tokenProgram,
            onSubmit: this.submissionRecorder(trade, lotsToReduce.map((l) => l.id), attempts),
          };
          fill = await exec.swap(p);
          break;
        } catch (err) {
          lastError = errorMessage(err);
          const pending = this.d.db.select().from(copyTrades).where(eq(copyTrades.id, trade.id)).get()!;
          if (pending.status === 'sent' && !(err instanceof SwapError && err.definitive)) {
            await this.executionError(trade, err, attempts);
            return;
          }
          // A definitive rejection permits a new transaction; clear the old identity first.
          db.update(copyTrades).set({ status: 'pending', signature: null, recovery: JSON.stringify({ lotIds: lotsToReduce.map((l) => l.id) }) }).where(eq(copyTrades.id, trade.id)).run();
          log.warn(`sell attempt ${attempts}/${slippages.length} failed (slippage ${slippageBps == null ? 'auto' : `${slippageBps / 100}%`}): ${lastError}`);
          if (attempts < slippages.length) await sleep(400);
        }
      }
      if (!fill) {
        const failed = db.update(copyTrades).set({ status: 'failed', error: lastError, attempts }).where(eq(copyTrades.id, trade.id)).returning().get()!;
        log.error(`${paper ? 'paper' : 'LIVE'} SELL FAILED after ${attempts} attempts · ${ctx.label} · ${tokens.symbol(mint)} · ${lastError}`);
        publish({ type: 'trade', trade: failed });
        return;
      }

      this.bookSell(ctx, trade, fill, lotsToReduce, attempts, closeAll);
    } finally { this.active.delete(trade.id); }
  }

  /** `closeAll`: the sell took everything the wallet held, so the positions close whatever their recorded size. */
  private bookSell(ctx: TradeCtx, trade: CopyTrade, fill: SwapFill, lotsToReduce: Lot[], attempts: number, closeAll = false) {
    const { db, log, settings, accounts, prices, tokens } = this.d;
    const { wallet, paper } = ctx;
    const mint = trade.mint;
    const decimals = trade.tokenDecimals!;
    const token = tokens.cached(mint);
    const solUsd = prices.solUsd;
    const priceSol = lamportsToSol(fill.outAmount) / (Number(fill.inAmount) / 10 ** decimals);
    const priceUsd = solUsd ? priceSol * solUsd : null;
    const mc = marketCapUsd(priceUsd, token);
    if (priceUsd) prices.observe(mint, priceUsd);
    const proceeds = Number(fill.outAmount) - fill.feeLamports;

    let realized = 0;
    let allClosed = true;
    const done = db.transaction((tx) => {
      const held = lotsToReduce.map((l) => ({ ...l, tokenAmount: BigInt(l.tokenAmount) }));
      const booked = closeAll ? held.reduce((sum, l) => sum + l.tokenAmount, 0n) : fill.inAmount;
      for (const part of splitAcrossLots(held, booked, proceeds)) {
        const fresh = tx.select().from(lots).where(eq(lots.id, part.lot.id)).get()!;
        const r = applySell(toLotState(fresh), { tokens: part.tokens, proceedsLamports: part.proceeds, mcUsd: mc });
        realized += r.realized;
        if (!r.closed) allClosed = false;
        tx.update(lots)
          .set({ ...fromLotState(r.lot), lastPriceSol: priceSol, status: r.closed ? 'closed' : 'open', closedAt: r.closed ? Date.now() : null })
          .where(eq(lots.id, fresh.id))
          .run();
      }
      return tx
        .update(copyTrades)
        .set({
          status: 'confirmed',
          error: null,
          recovery: null,
          solLamports: Number(fill.outAmount),
          tokenAmount: fill.inAmount.toString(),
          feeLamports: fill.feeLamports,
          realizedLamports: realized,
          signature: fill.signature,
          route: paper ? `paper:${fill.route}` : fill.route,
          priceUsd,
          solUsd,
          marketCapUsd: mc,
          attempts,
          sentAt: fill.sentAt,
          confirmedAt: fill.confirmedAt,
        })
        .where(eq(copyTrades.id, trade.id))
        .returning()
        .get()!;
    });

    accounts.invalidate(wallet.pubkey);
    log.info(
      `${paper ? 'paper' : 'LIVE'} SELL ✓ · ${ctx.label} · ${tokens.symbol(mint)} → ${lamportsToSol(fill.outAmount).toFixed(4)} SOL` +
        `${mc ? ` @ MC $${compact(mc)}` : ''} · via ${ROUTE_LABEL[fill.route]} · PnL ${realized >= 0 ? '+' : ''}${lamportsToSol(realized).toFixed(4)} SOL`,
    );
    publish({ type: 'trade', trade: done });
    publish({ type: 'positions' });

    if (!paper && this.d.cfg.liveTrading && this.d.keystore.isUnlocked && allClosed && settings.get().closeEmptyAccounts && !this.openLots(wallet.id, false).some((l) => l.mint === mint)) {
      // Reclaim the ~0.002 SOL rent of the now-empty token account. Failing here costs nothing but that refund.
      const rentUsd = prices.solUsd ? ` (~$${(0.00204 * prices.solUsd).toFixed(2)})` : '';
      void accounts
        .closeEmptyAccounts(wallet.pubkey, mint)
        .catch((err) =>
          log.warn(
            { err: errorMessage(err).slice(0, 160) },
            `couldn't reclaim the rent${rentUsd} from your empty ${tokens.symbol(mint)} token account after 3 tries – the trade itself is fine; use "Reclaim rent" on My wallets to try again`,
          ),
        );
    }
  }

  // ── manual actions (UI buttons) ───────────────────────────────────────────

  /** Sells `pct` (0..1] of your whole position in `mint` on one wallet. */
  async manualSell(myWalletId: number, mint: string, pct: number, paper: boolean): Promise<CopyTrade | undefined> {
    return this.queue.run(`${myWalletId}:${mint}`, async () => {
      const { db, accounts, cfg, keystore } = this.d;
      const wallet = db.select().from(myWallets).where(eq(myWallets.id, myWalletId)).get();
      if (!wallet) throw new Error('Wallet not found');
      if (!paper && this.unresolved(myWalletId, mint, false)) throw new Error('Previous transaction outcome unresolved – waiting for recovery');
      if (!paper && !cfg.liveTrading) throw new Error('Live trading is off (LIVE_TRADING=false in .env)');
      if (!paper && !keystore.isUnlocked) throw new Error('Keystore is locked');
      const held = this.openLots(myWalletId, paper).filter((l) => l.mint === mint);
      if (!held.length) throw new Error('No open position');
      const total = held.reduce((s, l) => s + BigInt(l.tokenAmount), 0n);
      let amount = pct >= 1 ? total : mulFraction(total, pct);
      if (!paper) {
        const onChain = await accounts.tokenBalance(wallet.pubkey, mint);
        if (onChain === 0n) {
          this.closeLotsOutside(held, 'token balance is zero on-chain (sold or moved outside the bot)');
          throw new Error('Nothing left on-chain – position marked closed');
        }
        // Closing 100% sells whatever is actually there; partial sells never exceed it.
        if (pct >= 1 || amount > onChain) amount = onChain;
      }
      const closeAll = !paper && pct >= 1;
      const group = held[0].groupId ? db.select().from(traderGroups).where(eq(traderGroups.id, held[0].groupId)).get() : undefined;
      const ctx: TradeCtx = { group: group ?? null, wallet, paper, sourceWalletId: null, signalId: null, label: 'manual', manual: true };
      await this.executeSell(ctx, mint, amount, pct, held, null, closeAll);
      return db.select().from(copyTrades).where(eq(copyTrades.myWalletId, myWalletId)).orderBy(sql`${copyTrades.id} DESC`).get();
    });
  }

  async manualBuy(myWalletId: number, mint: string, sol: number, paper: boolean): Promise<void> {
    const { db, cfg, keystore, tokens } = this.d;
    const wallet = db.select().from(myWallets).where(eq(myWallets.id, myWalletId)).get();
    if (!wallet) throw new Error('Wallet not found');
    if (!paper && !cfg.liveTrading) throw new Error('Live trading is off (LIVE_TRADING=false in .env)');
    if (!paper && !keystore.isUnlocked) throw new Error('Keystore is locked');
    const token = await tokens.get(mint);
    const group = db.select().from(traderGroups).where(eq(traderGroups.myWalletId, myWalletId)).get();
    const ctx: TradeCtx = { group: group ?? null, wallet, paper, sourceWalletId: null, signalId: null, label: 'manual', manual: true };
    await this.queue.run(`${myWalletId}:${mint}`, async () => {
      if (!paper && this.unresolved(myWalletId, mint)) throw new Error('Previous transaction outcome unresolved – waiting for recovery');
      const id = await this.admissions.run(`${myWalletId}:${paper}`, async () => {
        const prior = this.reserved(myWalletId, paper);
        const balance = paper ? this.paperCash(group ?? { paperStartSol: 1 }, myWalletId) : await this.d.accounts.solBalance(wallet.pubkey, 0, PRIORITY.trade);
        if (!paper && this.unresolved(myWalletId, mint)) throw new Error('Previous transaction outcome unresolved – waiting for recovery');
        const reserved = new Map([...prior, ...this.reserved(myWalletId, paper)]);
        const available = balance - [...reserved.values()].reduce((sum, r) => sum + r.amount, 0);
        const amount = solToLamports(sol) + this.feeReserve(paper);
        if (amount > available) throw new Error('Insufficient unreserved balance, including fees');
        const id = ++this.reservationId;
        this.reservations.set(id, { walletId: myWalletId, paper, mint, amount });
        return id;
      });
      try { await this.executeBuy(ctx, mint, BigInt(solToLamports(sol)), null, token, null); }
      finally { this.reservations.delete(id); }
    });
  }

  /** Sells 100% of every open position of a trader group. */
  async closeAllForGroup(groupId: number): Promise<number> {
    const rows = this.d.db.select().from(lots).where(and(eq(lots.groupId, groupId), eq(lots.status, 'open'))).all();
    const keys = new Map<string, { wallet: number; mint: string; paper: boolean }>();
    for (const l of rows) keys.set(`${l.myWalletId}:${l.mint}:${l.paper}`, { wallet: l.myWalletId, mint: l.mint, paper: l.paper });
    await Promise.allSettled([...keys.values()].map((k) => this.manualSell(k.wallet, k.mint, 1, k.paper)));
    return keys.size;
  }

  /** On startup, checks live positions against real token balances (e.g. after selling in Phantom). */
  async reconcile(): Promise<void> {
    const { db, accounts, log } = this.d;
    const open = db.select().from(lots).where(and(eq(lots.status, 'open'), eq(lots.paper, false))).all();
    const byKey = new Map<string, Lot[]>();
    for (const l of open) byKey.set(`${l.myWalletId}:${l.mint}`, [...(byKey.get(`${l.myWalletId}:${l.mint}`) ?? []), l]);
    for (const [key, group] of byKey) {
      const [walletId, mint] = key.split(':');
      const wallet = db.select().from(myWallets).where(eq(myWallets.id, Number(walletId))).get();
      if (!wallet) continue;
      try {
        if (this.unresolved(wallet.id, mint, false)) continue;
        const onChain = await accounts.tokenBalance(wallet.pubkey, mint, PRIORITY.background);
        const total = group.reduce((s, l) => s + BigInt(l.tokenAmount), 0n);
        if (onChain >= total) continue;
        if (onChain === 0n) {
          this.closeLotsOutside(group, 'not found on-chain at startup (sold or moved outside the bot)');
          log.warn(`position ${this.d.tokens.symbol(mint)} on ${wallet.label} is gone on-chain – marked closed`);
          continue;
        }
        db.transaction((tx) => {
          for (const l of group) {
            const scaled = (BigInt(l.tokenAmount) * onChain) / total;
            const keepCost = Math.round(l.costLamports * (Number(onChain) / Number(total)));
            tx.update(lots).set({ tokenAmount: scaled.toString(), costLamports: keepCost, note: 'reduced to match on-chain balance' }).where(eq(lots.id, l.id)).run();
          }
        });
        log.warn(`position ${this.d.tokens.symbol(mint)} on ${wallet.label} reduced to match on-chain balance`);
      } catch (err) {
        log.warn({ err: errorMessage(err) }, `could not reconcile ${mint}`);
      }
    }
    publish({ type: 'positions' });
  }

  private feeReserve(paper: boolean): number {
    const s = this.d.settings.get();
    return paper ? solToLamports(s.paperFeeSol) : Math.max(20_000_000, solToLamports(s.tipSol + s.priorityFeeSol) + 5_000_000);
  }

  private reserved(walletId: number, paper: boolean) {
    return new Map([...this.reservations].filter(([, r]) => r.walletId === walletId && r.paper === paper));
  }

  private unresolved(walletId: number, mint: string, buying = true): boolean {
    return this.d.db.select().from(copyTrades).where(and(eq(copyTrades.myWalletId, walletId), eq(copyTrades.paper, false), eq(copyTrades.status, 'sent')))
      .all().some((t) => !this.active.has(t.id) && ((buying && t.side === 'buy') || t.mint === mint));
  }

  private submissionRecorder(trade: CopyTrade, lotIds: number[], attempts = 1) {
    return (submission: Submission) => {
      this.d.db.update(copyTrades).set({ status: 'sent', signature: submission.signature, sentAt: submission.sentAt,
        route: submission.route, attempts, recovery: JSON.stringify({ lotIds, submission }) }).where(eq(copyTrades.id, trade.id)).run();
    };
  }

  private async executionError(trade: CopyTrade, err: unknown, attempts: number) {
    const current = this.d.db.select().from(copyTrades).where(eq(copyTrades.id, trade.id)).get()!;
    const uncertain = current.status === 'sent' && !(err instanceof SwapError && err.definitive);
    const updated = this.d.db.update(copyTrades).set({ status: uncertain ? 'sent' : 'failed', error: errorMessage(err), attempts })
      .where(eq(copyTrades.id, trade.id)).returning().get()!;
    this.d.log.warn(`${uncertain ? 'transaction outcome unknown; recovery will check the original signature' : 'trade failed'}: ${errorMessage(err)}`);
    publish({ type: 'trade', trade: updated });
  }

  /** Runs before streams start and periodically for uncertain outcomes; never resubmits a swap. */
  async recoverPending(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const pending = this.d.db.select().from(copyTrades).where(inArray(copyTrades.status, ['pending', 'sent'])).all();
      for (const trade of pending) {
        if (this.active.has(trade.id)) continue;
        await this.queue.run(`${trade.myWalletId}:${trade.mint}`, async () => {
          const fresh = this.d.db.select().from(copyTrades).where(eq(copyTrades.id, trade.id)).get()!;
          if (!['pending', 'sent'].includes(fresh.status) || this.active.has(trade.id)) return;
          if (fresh.status === 'pending' && !fresh.paper && !fresh.recovery) {
            const legacy = this.d.db.update(copyTrades).set({ status: 'sent', error: 'Legacy pending trade has no saved signature; manual reconciliation required' }).where(eq(copyTrades.id, fresh.id)).returning().get()!;
            this.d.log.warn(legacy.error!);
            publish({ type: 'trade', trade: legacy });
            return;
          }
          if (fresh.status === 'pending') {
            this.d.db.update(copyTrades).set({ status: 'failed', error: 'Interrupted before submission; no automatic resubmission' }).where(eq(copyTrades.id, trade.id)).run();
            return;
          }
          try {
            const recovery = JSON.parse(fresh.recovery ?? '{}') as { lotIds?: number[]; submission?: Submission };
            if (!recovery.submission || !this.d.live.recover) throw new Error('Missing transaction recovery data');
            const wallet = this.d.db.select().from(myWallets).where(eq(myWallets.id, trade.myWalletId)).get();
            if (!wallet) throw new Error('Recovery wallet missing');
            const group = trade.groupId ? this.d.db.select().from(traderGroups).where(eq(traderGroups.id, trade.groupId)).get() : null;
            const ctx: TradeCtx = { wallet, group: group ?? null, paper: false, sourceWalletId: trade.sourceWalletId, signalId: trade.signalId, label: 'recovered', manual: trade.manual };
            const fill = await this.d.live.recover({ wallet: wallet.pubkey,
              inputMint: trade.side === 'buy' ? WSOL_MINT : trade.mint, outputMint: trade.side === 'buy' ? trade.mint : WSOL_MINT,
              amount: BigInt(trade.side === 'buy' ? trade.solLamports! : trade.tokenAmount!), slippageBps: null }, recovery.submission);
            if (!fill) return;
            if (trade.side === 'buy') {
              const token = this.d.tokens.cached(trade.mint) ?? { decimals: trade.tokenDecimals!, supply: '0' };
              this.bookBuy(ctx, fresh, fill, token, trade.skipReason);
            } else {
              const held = recovery.lotIds?.length ? this.d.db.select().from(lots).where(inArray(lots.id, recovery.lotIds)).all() : [];
              if (!held.length) throw new Error('Recovery position missing');
              this.bookSell(ctx, fresh, fill, held, fresh.attempts);
            }
          } catch (err) { await this.executionError(fresh, err, fresh.attempts); }
        });
      }
    } finally { this.recovering = false; }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Waits until all queued copy work is done. */
  idle(): Promise<void> {
    return this.queue.drain();
  }

  /** Copies (buys/sells) queued or in progress right now. */
  get busy(): number {
    return this.queue.size;
  }

  openLots(myWalletId?: number, paper?: boolean): Lot[] {
    const conds = [eq(lots.status, 'open')];
    if (myWalletId !== undefined) conds.push(eq(lots.myWalletId, myWalletId));
    if (paper !== undefined) conds.push(eq(lots.paper, paper));
    return this.d.db.select().from(lots).where(and(...conds)).all();
  }

  /** Mints with open positions (for price refreshes). */
  trackedMints(): string[] {
    return [...new Set(this.openLots().map((l) => l.mint))];
  }

  /** Virtual SOL balance of a paper-trading group: start balance − buys + sells − simulated fees. */
  paperCash(group: Pick<TraderGroup, 'paperStartSol'>, myWalletId: number): number {
    const row = this.d.db
      .select({
        buys: sql<number>`coalesce(sum(case when ${copyTrades.side} = 'buy' then ${copyTrades.solLamports} + coalesce(${copyTrades.feeLamports}, 0) else 0 end), 0)`,
        sells: sql<number>`coalesce(sum(case when ${copyTrades.side} = 'sell' then ${copyTrades.solLamports} - coalesce(${copyTrades.feeLamports}, 0) else 0 end), 0)`,
      })
      .from(copyTrades)
      .where(and(eq(copyTrades.myWalletId, myWalletId), eq(copyTrades.paper, true), eq(copyTrades.status, 'confirmed')))
      .get()!;
    return solToLamports(group.paperStartSol) - row.buys + row.sells;
  }

  realizedToday(paper: boolean): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const row = this.d.db
      .select({ total: sql<number>`coalesce(sum(${copyTrades.realizedLamports}), 0)` })
      .from(copyTrades)
      .where(and(eq(copyTrades.paper, paper), eq(copyTrades.status, 'confirmed'), gte(copyTrades.createdAt, start.getTime())))
      .get()!;
    return row.total;
  }

  private closeLotsOutside(rows: Lot[], note: string) {
    if (!rows.length) return;
    this.d.db
      .update(lots)
      .set({ status: 'closed', tokenAmount: '0', costLamports: 0, closedAt: Date.now(), note })
      .where(inArray(lots.id, rows.map((l) => l.id)))
      .run();
    publish({ type: 'positions' });
  }

  private insertTrade(ctx: TradeCtx, side: 'buy' | 'sell', mint: string, pct: number | null, extra: Partial<typeof copyTrades.$inferInsert>): CopyTrade {
    return this.d.db
      .insert(copyTrades)
      .values({
        signalId: ctx.signalId,
        groupId: ctx.group?.id ?? null,
        myWalletId: ctx.wallet.id,
        sourceWalletId: ctx.sourceWalletId,
        side,
        mint,
        paper: ctx.paper,
        manual: ctx.manual ?? false,
        pct,
        createdAt: Date.now(),
        status: 'pending',
        ...extra,
      })
      .returning()
      .get();
  }

  /** Why a sell can't be copied, for a token this group tried to copy before; null if it never did. */
  private noPositionReason(ctx: TradeCtx, mint: string): string | null {
    const { db } = this.d;
    const { wallet, paper, group } = ctx;
    const lastBuy = db
      .select()
      .from(copyTrades)
      .where(
        and(
          group ? eq(copyTrades.groupId, group.id) : eq(copyTrades.myWalletId, wallet.id),
          eq(copyTrades.mint, mint),
          eq(copyTrades.side, 'buy'),
          eq(copyTrades.paper, paper),
        ),
      )
      .orderBy(desc(copyTrades.id))
      .get();
    if (!lastBuy) return null;
    const heldViaOther = this.openLots(wallet.id, paper).some((l) => l.mint === mint);
    if (heldViaOther) return 'your position came from another wallet in this group – only that wallet’s sells sell it';
    if (lastBuy.status === 'skipped') return `not holding – the buy was skipped (${lastBuy.skipReason ?? 'unknown reason'})`;
    if (lastBuy.status === 'failed') return `not holding – the buy failed${lastBuy.error ? ` (${lastBuy.error})` : ''}`;
    if (lastBuy.status === 'confirmed') return 'not holding – position already closed';
    return `not holding – the buy is ${lastBuy.status}`;
  }

  private recordSkip(ctx: TradeCtx, side: 'buy' | 'sell', mint: string, pct: number, reason: string) {
    const trade = this.insertTrade(ctx, side, mint, pct, { status: 'skipped', skipReason: reason });
    this.d.log.info(`skipped ${side} · ${ctx.label} · ${this.d.tokens.symbol(mint)} · ${reason}`);
    publish({ type: 'trade', trade });
  }
}

interface TradeCtx {
  group: TraderGroup | null;
  wallet: MyWallet;
  paper: boolean;
  sourceWalletId: number | null;
  signalId: number | null;
  label: string;
  manual?: boolean;
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}
