/**
 * Sell plans: sell a manual position step by step as the coin's market cap reaches your levels, a
 * little at a time and only into other people's buys, so the chart isn't dumped.
 *
 * While a plan is active it reads the coin's pump.fun curve / PumpSwap pool (one request each time):
 * every 60 s while far from the next level, every 15 s when close (or when a trailing stop is set and
 * armed), every 4 s while a level is selling. Each read compares the pool's SOL with the last one;
 * a share of what others bought (net) may be sold, each sell capped so it moves the price at most a
 * set %. Plans are stored in this data folder and carry on after a restart. Nothing runs for paused,
 * finished or cancelled plans.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { config as appConfig } from '../../server/src/config.js';
import type { Db } from '../../server/src/db/client.js';
import { copyTrades, myWallets } from '../../server/src/db/schema.js';
import { marketCapUsd, type CopyEngine } from '../../server/src/engine/copyEngine.js';
import type { Keystore } from '../../server/src/keystore/keystore.js';
import type { moduleLogger } from '../../server/src/logger.js';
import type { PriceService } from '../../server/src/prices/priceService.js';
import type { AccountService } from '../../server/src/solana/accounts.js';
import type { TokenService } from '../../server/src/solana/tokens.js';
import { errorMessage } from '../../server/src/util/misc.js';
import type { MarketReader } from './market.js';
import {
  CHECK_MS,
  DUST_SOL,
  bookSold,
  finishOpenLevels,
  isDust,
  levelTarget,
  moonBagTokens,
  nextAllowance,
  nextCheckMs,
  nextLevel,
  openLevels,
  sellableTokens,
  sliceTokens,
  trackStop,
  usdShort,
  type PlanLevel,
} from './planMath.js';

/**
 * Set around the sells a plan makes: the router uses the plan's slippage, and a failed attempt is not
 * retried at the engine's wider slippages (25–60%) – the next check sizes the sell again instead.
 */
export const planSellScope = new AsyncLocalStorage<{ slippageBps: number; attempts: number; firstError: string | null }>();

/** A plan pauses itself after this many failed sells in a row. */
const MAX_FAILURES = 3;

export type PlanStatus = 'active' | 'paused' | 'done' | 'cancelled';

export interface PlanSettings {
  /** `id` names an existing level when editing (its sold tokens stay with it). */
  levels: Array<{ id?: number; mcUsd: number; pct: number }>;
  /** Share of others' net buys that may be sold (%). */
  participationPct: number;
  /** Most a single sell may move the price down (%). */
  maxImpactPct: number;
  /** Smaller sells wait for more buys (unless the price cap or the remainder is smaller). */
  minSellUsd: number;
  slippagePct: number;
  /** Trailing stop: once the first level is reached, a fall of this % from the high sells the rest of the levels. */
  stopDropPct: number | null;
}

interface PlanData extends Omit<PlanSettings, 'levels'> {
  levels: PlanLevel[];
  /** Tokens held when the plan started: the levels' % are of this. */
  bagTokens: string;
  decimals: number;
  /** Highest market cap since the trailing stop armed (null before). */
  highMcUsd: number | null;
  /** When the first level was first reached (arms the trailing stop). */
  armedAt: number | null;
  /** The trailing stop fired: the rest of the levels sells without waiting for buys. */
  exiting: boolean;
  soldTokens: string;
  proceedsLamports: number;
  sells: number;
  failures: number;
  lastError: string | null;
  endReason: string | null;
}

interface PlanRow {
  id: number;
  walletId: number;
  mint: string;
  paper: boolean;
  status: PlanStatus;
  data: PlanData;
  createdAt: number;
  updatedAt: number;
}

/** Kept in memory only: what the last check saw. Restarting begins a fresh comparison. */
interface Runtime {
  timer: NodeJS.Timeout | null;
  /** The check in progress: changes from the page wait for it, so neither overwrites the other. */
  running: Promise<void> | null;
  lastQuote: bigint | null;
  lastVenue: string | null;
  allowance: bigint;
  market: { mcUsd: number; priceUsd: number; venue: string; at: number } | null;
  note: string;
  nextAt: number | null;
}

interface Deps {
  db: Db;
  cfg: typeof appConfig;
  engine: CopyEngine;
  keystore: Keystore;
  accounts: AccountService;
  tokens: TokenService;
  prices: PriceService;
  market: MarketReader;
  log: ReturnType<typeof moduleLogger>;
}

const LAMPORTS = 1e9;

export class SellPlans {
  private rt = new Map<number, Runtime>();
  private stopped = false;

  constructor(private readonly d: Deps) {
    d.db.run(sql`CREATE TABLE IF NOT EXISTS manual_sell_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      paper INTEGER NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  /** Picks up the plans that were active when the tool last stopped. */
  start() {
    const active = this.rows().filter((r) => r.status === 'active');
    active.forEach((r, i) => this.schedule(r.id, 1_000 + i * 500));
    if (active.length) this.d.log.info(`${active.length} sell plan${active.length === 1 ? '' : 's'} active – carrying on`);
  }

  stop() {
    this.stopped = true;
    for (const r of this.rt.values()) if (r.timer) clearTimeout(r.timer);
  }

  // ── storage ────────────────────────────────────────────────────────────────

  private rows(): PlanRow[] {
    return this.d.db
      .all<{ id: number; wallet_id: number; mint: string; paper: number; status: PlanStatus; data: string; created_at: number; updated_at: number }>(
        sql`SELECT * FROM manual_sell_plans ORDER BY id DESC`,
      )
      .map((r) => {
        const data = JSON.parse(r.data) as PlanData;
        data.levels = data.levels.map((l, i) => ({ ...l, id: l.id ?? i }));
        return { id: r.id, walletId: r.wallet_id, mint: r.mint, paper: r.paper === 1, status: r.status, data, createdAt: r.created_at, updatedAt: r.updated_at };
      });
  }

  private row(id: number): PlanRow | undefined {
    return this.rows().find((r) => r.id === id);
  }

  private save(id: number, status: PlanStatus, data: PlanData) {
    this.d.db.run(sql`UPDATE manual_sell_plans SET status = ${status}, data = ${JSON.stringify(data)}, updated_at = ${Date.now()} WHERE id = ${id}`);
  }

  private runtime(id: number): Runtime {
    let r = this.rt.get(id);
    if (!r) {
      r = { timer: null, running: null, lastQuote: null, lastVenue: null, allowance: 0n, market: null, note: 'starting', nextAt: null };
      this.rt.set(id, r);
    }
    return r;
  }

  /** The unfinished plan (active or paused) on this position, if any. */
  current(walletId: number, mint: string, paper: boolean): PlanRow | undefined {
    return this.rows().find((r) => r.walletId === walletId && r.mint === mint && r.paper === paper && (r.status === 'active' || r.status === 'paused'));
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async create(walletId: number, mint: string, paper: boolean, s: PlanSettings): Promise<number> {
    const { db, engine, accounts, tokens } = this.d;
    const wallet = db.select().from(myWallets).where(eq(myWallets.id, walletId)).get();
    if (!wallet || wallet.archived) throw new Error('Wallet not found');
    const held = engine.openLots(walletId, paper).filter((l) => l.mint === mint);
    if (!held.some((l) => l.sourceWalletId === null)) throw new Error('No manual position in this token on this wallet');
    if (held.some((l) => l.sourceWalletId !== null)) throw new Error('This wallet also holds this token from copy trading – a plan would mix the two');
    if (this.current(walletId, mint, paper)) throw new Error('This position already has a sell plan – cancel it first');

    const levels = checkLevels(s.levels);

    const token = await tokens.get(mint);
    await this.d.market.read(mint); // refuses coins that aren't on pump.fun / PumpSwap (priced in SOL or USDC)
    const recorded = held.reduce((sum, l) => sum + BigInt(l.tokenAmount), 0n);
    const bag = paper ? recorded : await accounts.tokenBalance(wallet.pubkey, mint);
    if (bag === 0n) throw new Error('No tokens in the wallet');

    const data: PlanData = {
      ...s,
      levels: levels.map((l, i) => ({ id: i, mcUsd: l.mcUsd, pct: l.pct, soldTokens: '0', doneAt: null })),
      bagTokens: bag.toString(),
      decimals: token.decimals,
      highMcUsd: null,
      armedAt: null,
      exiting: false,
      soldTokens: '0',
      proceedsLamports: 0,
      sells: 0,
      failures: 0,
      lastError: null,
      endReason: null,
    };
    const now = Date.now();
    const { id } = db.get<{ id: number }>(
      sql`INSERT INTO manual_sell_plans (wallet_id, mint, paper, status, data, created_at, updated_at)
          VALUES (${walletId}, ${mint}, ${paper ? 1 : 0}, 'active', ${JSON.stringify(data)}, ${now}, ${now}) RETURNING id`,
    )!;
    this.d.log.info(
      `${paper ? 'paper ' : ''}sell plan #${id} started on ${wallet.label} · ${tokens.symbol(mint)}: ` +
        levels.map((l) => `${l.pct}% at ${usdShort(l.mcUsd)}`).join(', '),
    );
    this.schedule(id, 0);
    return id;
  }

  /**
   * Changes the levels and settings, keeping what was sold. The % stay of the bag the plan started
   * with. A level that already sold can be moved or raised, but not removed or set below what it sold.
   */
  async edit(id: number, s: PlanSettings) {
    await this.idle(id);
    const r = this.mustRow(id);
    if (r.status !== 'active' && r.status !== 'paused') throw new Error('This plan has already ended');
    const p = r.data;
    const bag = BigInt(p.bagTokens);
    const old = new Map(p.levels.map((l) => [l.id, l]));
    const wanted = checkLevels(s.levels);
    const kept = new Set<number>();
    let nextId = Math.max(-1, ...p.levels.map((l) => l.id)) + 1;
    const levels: PlanLevel[] = wanted.map((w) => {
      const before = w.id != null ? old.get(w.id) : undefined;
      if (w.id != null && !before) throw new Error('A level of this plan changed meanwhile – reload the page');
      if (!before) return { id: nextId++, mcUsd: w.mcUsd, pct: w.pct, soldTokens: '0', doneAt: null };
      if (kept.has(before.id)) throw new Error('A level appears twice');
      kept.add(before.id);
      const sold = BigInt(before.soldTokens);
      // A little rounding slack: a finished level sold a hair less than its exact share.
      if (levelTarget(bag, w.pct) + bag / 1_000_000n < sold)
        throw new Error(`The ${usdShort(before.mcUsd)} level already sold ${pctOf(sold, bag)}% – it can’t be set lower`);
      const level = { ...before, mcUsd: w.mcUsd, pct: w.pct };
      level.doneAt = w.pct === before.pct ? before.doneAt : levelTarget(bag, w.pct) <= sold ? (before.doneAt ?? Date.now()) : null;
      return level;
    });
    for (const l of p.levels)
      if (!kept.has(l.id) && BigInt(l.soldTokens) > 0n) throw new Error(`The ${usdShort(l.mcUsd)} level already sold ${pctOf(BigInt(l.soldTokens), bag)}% – it can’t be removed`);

    const { levels: _, ...settings } = s;
    const next: PlanData = { ...p, ...settings, levels, failures: 0, lastError: null };
    // Turning the trailing stop off ends a stop sell-off in progress.
    if (next.stopDropPct == null) next.exiting = false;
    // A new first level re-arms the stop from scratch: it arms (and its high starts) when that level is reached.
    if (!next.exiting && levels[0].mcUsd !== p.levels[0].mcUsd) {
      next.armedAt = null;
      next.highMcUsd = null;
    }
    this.save(id, r.status, next);
    this.d.log.info(`sell plan #${id} changed: ` + levels.map((l) => `${l.pct}% at ${usdShort(l.mcUsd)}`).join(', '));
    if (r.status === 'active') this.schedule(id, 0);
  }

  async pause(id: number) {
    await this.idle(id);
    const r = this.mustRow(id);
    if (r.status !== 'active') throw new Error('Only an active plan can be paused');
    this.save(id, 'paused', r.data);
    this.unschedule(id, 'paused');
  }

  async resume(id: number) {
    await this.idle(id);
    const r = this.mustRow(id);
    if (r.status !== 'paused') throw new Error('Only a paused plan can be resumed');
    this.save(id, 'active', { ...r.data, failures: 0, lastError: null });
    this.schedule(id, 0);
  }

  async cancel(id: number) {
    await this.idle(id);
    const r = this.mustRow(id);
    if (r.status !== 'active' && r.status !== 'paused') throw new Error('This plan has already ended');
    this.save(id, 'cancelled', { ...r.data, endReason: 'cancelled by you' });
    this.unschedule(id, 'cancelled');
  }

  /** Waits for a check in progress (a sell takes a few seconds). */
  private async idle(id: number) {
    await this.rt.get(id)?.running?.catch(() => undefined);
  }

  private mustRow(id: number): PlanRow {
    const r = this.row(id);
    if (!r) throw new Error('Plan not found');
    return r;
  }

  // ── the page ───────────────────────────────────────────────────────────────

  /** Unfinished plans, then the 20 most recent finished ones. */
  list() {
    const { db, tokens } = this.d;
    const wallets = new Map(db.select().from(myWallets).all().map((w) => [w.id, w]));
    const rows = this.rows();
    const open = rows.filter((r) => r.status === 'active' || r.status === 'paused');
    const ended = rows.filter((r) => r.status === 'done' || r.status === 'cancelled').slice(0, 20);
    return [...open, ...ended].map((r) => {
      const p = r.data;
      const bag = BigInt(p.bagTokens);
      const rt = this.rt.get(r.id);
      const mc = rt?.market?.mcUsd ?? null;
      const t = tokens.cached(r.mint);
      const w = wallets.get(r.walletId);
      return {
        /** Whole tokens in existence (for "worth at that market cap"). */
        supply: t ? Number(BigInt(t.supply)) / 10 ** t.decimals : null,
        id: r.id,
        status: r.status,
        paper: r.paper,
        wallet: w ? { id: w.id, label: w.label } : null,
        token: { mint: r.mint, symbol: t?.symbol ?? null, name: t?.name ?? null, icon: null, decimals: p.decimals },
        bagTokens: p.bagTokens,
        moonBagTokens: moonBagTokens(p.levels, bag).toString(),
        levels: p.levels.map((l) => ({
          id: l.id,
          mcUsd: l.mcUsd,
          pct: l.pct,
          targetTokens: levelTarget(bag, l.pct).toString(),
          soldTokens: l.soldTokens,
          doneAt: l.doneAt,
          selling: r.status === 'active' && l.doneAt == null && mc != null && (p.exiting || mc >= l.mcUsd),
        })),
        settings: { participationPct: p.participationPct, maxImpactPct: p.maxImpactPct, minSellUsd: p.minSellUsd, slippagePct: p.slippagePct, stopDropPct: p.stopDropPct },
        highMcUsd: p.highMcUsd,
        exiting: p.exiting,
        soldTokens: p.soldTokens,
        proceedsLamports: p.proceedsLamports,
        sells: p.sells,
        lastError: p.lastError,
        endReason: p.endReason,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        // What the last check saw (only while the tool runs).
        mcUsd: mc,
        checkedAt: rt?.market?.at ?? null,
        venue: rt?.market?.venue ?? null,
        note: r.status === 'active' ? (rt?.note ?? 'starting') : null,
        nextCheckAt: r.status === 'active' ? (rt?.nextAt ?? null) : null,
      };
    });
  }

  // ── the loop ───────────────────────────────────────────────────────────────

  private schedule(id: number, delayMs: number) {
    if (this.stopped) return;
    const rt = this.runtime(id);
    if (rt.timer) clearTimeout(rt.timer);
    rt.nextAt = Date.now() + delayMs;
    rt.timer = setTimeout(() => void this.tick(id), delayMs);
  }

  private unschedule(id: number, note: string) {
    const rt = this.runtime(id);
    if (rt.timer) clearTimeout(rt.timer);
    Object.assign(rt, { timer: null, nextAt: null, lastQuote: null, lastVenue: null, allowance: 0n, note });
  }

  private async tick(id: number) {
    const rt = this.runtime(id);
    rt.timer = null;
    if (rt.running) return;
    let delay: number | null = CHECK_MS.near;
    rt.running = (async () => {
      try {
        const row = this.row(id);
        delay = row?.status === 'active' ? await this.step(row, rt) : null;
      } catch (err) {
        rt.note = `check failed: ${errorMessage(err).slice(0, 200)}`;
        this.d.log.warn({ err: errorMessage(err) }, `sell plan #${id}: check failed`);
      }
    })();
    await rt.running;
    rt.running = null;
    // A plan paused or ended during the check stays stopped.
    if (delay != null && this.row(id)?.status === 'active') this.schedule(id, delay);
    else rt.nextAt = null;
  }

  /** One check. Returns when to check again, or null when the plan ended. */
  private async step(row: PlanRow, rt: Runtime): Promise<number | null> {
    const { cfg, engine, keystore, accounts, tokens, prices, db, log } = this.d;
    const p = row.data;
    const bag = BigInt(p.bagTokens);
    const label = `sell plan #${row.id} (${tokens.symbol(row.mint)})`;

    // Live plans can't sell without keys and LIVE_TRADING – and then the pool isn't read either.
    if (!row.paper && !cfg.liveTrading) return this.wait(rt, 'LIVE_TRADING is off – waiting', CHECK_MS.idle);
    if (!row.paper && !keystore.isUnlocked) return this.wait(rt, 'wallet keys are locked – log in on the page', CHECK_MS.idle);
    const wallet = db.select().from(myWallets).where(eq(myWallets.id, row.walletId)).get();
    if (!wallet) return this.end(row, 'cancelled', 'the wallet is gone');
    const lots = engine.openLots(row.walletId, row.paper).filter((l) => l.mint === row.mint);
    if (!lots.length) return this.end(row, 'done', 'the position is closed');
    if (lots.some((l) => l.sourceWalletId !== null)) return this.pauseWith(row, 'this wallet now also holds the token from copy trading');

    const token = await tokens.get(row.mint);
    const solUsd = await prices.solUsdFresh(300_000);
    if (!solUsd) return this.wait(rt, 'no SOL price yet', CHECK_MS.near);
    const m = await this.d.market.read(row.mint);
    // Amounts are in the pool's own currency: SOL, or USDC (taken as $1).
    const quoteUsd = m.quoteKind === 'sol' ? solUsd : 1;
    const quoteScale = 10 ** m.quoteDecimals;
    const toQuote = (usd: number) => BigInt(Math.round((usd / quoteUsd) * quoteScale));
    const priceUsd = (Number(m.quote) / quoteScale / (Number(m.base) / 10 ** token.decimals)) * quoteUsd;
    const mcUsd = marketCapUsd(priceUsd, token) ?? 0;
    const dust = toQuote(DUST_SOL * solUsd);
    rt.market = { mcUsd, priceUsd, venue: m.venue, at: Date.now() };
    const inflow = rt.lastQuote != null && rt.lastVenue === m.venue ? m.quote - rt.lastQuote : 0n;
    rt.lastQuote = m.quote;
    rt.lastVenue = m.venue;

    // The trailing stop: armed from the first level on, its high counted from then.
    const stop = trackStop({ ...p, firstLevelMcUsd: p.levels[0].mcUsd }, mcUsd, Date.now());
    const changed = stop.armedAt !== p.armedAt || stop.highMcUsd !== p.highMcUsd || stop.fire;
    p.armedAt = stop.armedAt;
    p.highMcUsd = stop.highMcUsd;
    if (stop.fire) {
      p.exiting = true;
      rt.allowance = 0n;
      log.warn(`${label}: market cap ${usdShort(mcUsd)} is ${p.stopDropPct}% below its high ${usdShort(p.highMcUsd!)} – trailing stop: selling the rest of the levels`);
    }
    if (changed) this.save(row.id, 'active', p);
    const allSold = () => (p.exiting ? 'trailing stop – the rest of the levels is sold' : 'every level is sold');

    const delayFor = (selling: boolean) =>
      nextCheckMs({ selling, mcUsd, nextLevelMcUsd: nextLevel(p.levels, mcUsd)?.mcUsd ?? null, stopArmed: p.stopDropPct != null && p.armedAt != null });

    let sellable = sellableTokens(p.levels, bag, mcUsd, p.exiting);
    if (sellable === 0n) {
      rt.allowance = 0n;
      const next = nextLevel(p.levels, mcUsd);
      if (!next) return this.end(row, 'done', allSold());
      return this.wait(rt, `waiting for ${usdShort(next.mcUsd)} (now ${usdShort(mcUsd)})`, delayFor(false));
    }
    // Rounding (or your own sells) can leave a level a few tokens short: that's not worth a sell.
    if (isDust(m.base, m.quote, sellable, dust)) {
      const closed = finishOpenLevels(p.levels, mcUsd, p.exiting, Date.now());
      p.levels = closed.levels;
      this.save(row.id, 'active', p);
      for (const l of closed.finished) log.info(`${label}: the ${usdShort(l.mcUsd)} level (${l.pct}%) is sold`);
      if (p.levels.every((l) => l.doneAt != null)) return this.end(row, 'done', allSold());
      return this.wait(rt, 'level sold', delayFor(false));
    }
    if (!p.exiting) rt.allowance = nextAllowance(rt.allowance, inflow, p.participationPct);

    const minSell = toQuote(p.minSellUsd);
    const size = (cap: bigint) =>
      sliceTokens({ sellable: cap, base: m.base, quote: m.quote, allowance: rt.allowance, maxImpactPct: p.maxImpactPct, minSell, dust, exiting: p.exiting });
    const levelNames = openLevels(p.levels, mcUsd, p.exiting).map((l) => usdShort(l.mcUsd)).join(' + ');
    if (size(sellable) === 0n)
      return this.wait(rt, `selling the ${levelNames} level – waiting for buys ($${((Number(rt.allowance) / quoteScale) * quoteUsd).toFixed(2)} ready)`, delayFor(true));

    // Count the tokens right before selling; the moon bag is never sold.
    const recorded = lots.reduce((s, l) => s + BigInt(l.tokenAmount), 0n);
    const held = row.paper ? recorded : await accounts.tokenBalance(wallet.pubkey, row.mint);
    const keep = moonBagTokens(p.levels, bag);
    if (held <= keep || isDust(m.base, m.quote, held - keep, dust)) return this.end(row, 'done', held === 0n ? 'no tokens left in the wallet' : 'only the moon bag is left');
    if (held - keep < sellable) sellable = held - keep;
    const slice = size(sellable);
    if (slice === 0n) return this.wait(rt, `selling the ${levelNames} level – waiting for buys`, delayFor(true));

    // Sell: the engine sells a share of the booked position, never more than is on-chain.
    const share = slice >= recorded ? 1 : Math.min(Number(slice) / Number(recorded), 0.999999);
    const lastId = db.select({ id: copyTrades.id }).from(copyTrades).orderBy(desc(copyTrades.id)).get()?.id ?? 0;
    rt.note = `selling ${(Number(slice) / 10 ** token.decimals).toLocaleString('en-US', { maximumFractionDigits: 2 })} tokens (${levelNames} level)`;
    await planSellScope.run({ slippageBps: Math.round(p.slippagePct * 100), attempts: 0, firstError: null }, () => engine.manualSell(row.walletId, row.mint, share, row.paper));
    const trade = db
      .select()
      .from(copyTrades)
      .where(and(gt(copyTrades.id, lastId), eq(copyTrades.myWalletId, row.walletId), eq(copyTrades.mint, row.mint), eq(copyTrades.side, 'sell')))
      .orderBy(desc(copyTrades.id))
      .get();
    accounts.invalidate(wallet.pubkey);

    const fresh = this.row(row.id);
    const status = fresh?.status ?? 'active';
    if (trade?.status === 'confirmed') {
      const sold = BigInt(trade.tokenAmount ?? '0');
      const out = BigInt(trade.solLamports ?? 0);
      const booked = bookSold(p.levels, bag, sold, mcUsd, p.exiting, Date.now());
      p.levels = booked.levels;
      p.soldTokens = (BigInt(p.soldTokens) + sold).toString();
      p.proceedsLamports += Number(out);
      p.sells++;
      p.failures = 0;
      p.lastError = null;
      this.save(row.id, status, p);
      // Our own sell took that much out of the pool (in its currency; the wallet gets SOL either way):
      // only others' trades count as flow next time.
      const outQuote = m.quoteKind === 'sol' ? out : toQuote((Number(out) / LAMPORTS) * solUsd);
      if (!row.paper) rt.lastQuote = m.quote - outQuote;
      rt.allowance = rt.allowance > outQuote ? rt.allowance - outQuote : 0n;
      for (const l of booked.finished) log.info(`${label}: the ${usdShort(l.mcUsd)} level (${l.pct}%) is sold`);
      if (p.levels.every((l) => l.doneAt != null)) return this.end(row, 'done', allSold());
      return delayFor(true);
    }
    // Failed, or its outcome is still being recovered.
    if (trade?.status === 'failed') {
      p.failures++;
      p.lastError = trade.error ?? 'sell failed';
      this.save(row.id, status, p);
      if (p.failures >= MAX_FAILURES) return this.pauseWith(row, `${MAX_FAILURES} sells in a row failed (last: ${p.lastError})`);
      return this.wait(rt, `last sell failed (${p.lastError.slice(0, 120)}) – trying again`, delayFor(true));
    }
    return this.wait(rt, 'waiting for the last sell to be confirmed', CHECK_MS.near);
  }

  private wait(rt: Runtime, note: string, delay: number): number {
    rt.note = note;
    return delay;
  }

  /** Pauses a plan that can't go on by itself (unless you paused or cancelled it meanwhile). */
  private pauseWith(row: PlanRow, reason: string): null {
    if (this.row(row.id)?.status === 'active') this.save(row.id, 'paused', { ...row.data, lastError: reason });
    this.unschedule(row.id, 'paused');
    this.d.log.warn(`sell plan #${row.id} paused: ${reason}`);
    return null;
  }

  private end(row: PlanRow, status: 'done' | 'cancelled', reason: string): null {
    const now = this.row(row.id)?.status;
    if (now === 'active' || now === 'paused') this.save(row.id, status, { ...row.data, endReason: reason });
    this.unschedule(row.id, status);
    this.d.log.info(`sell plan #${row.id} ${status === 'done' ? 'finished' : 'ended'}: ${reason}`);
    return null;
  }
}

/** Sorted levels; refuses duplicates and more than 100% in total. */
function checkLevels<T extends { mcUsd: number; pct: number }>(levels: T[]): T[] {
  const sorted = [...levels].sort((a, b) => a.mcUsd - b.mcUsd);
  if (!sorted.length) throw new Error('Add at least one level');
  if (new Set(sorted.map((l) => l.mcUsd)).size !== sorted.length) throw new Error('Two levels have the same market cap');
  if (sorted.reduce((sum, l) => sum + l.pct, 0) > 100.0001) throw new Error('The levels add up to more than 100%');
  return sorted;
}

const pctOf = (part: bigint, whole: bigint) => (whole > 0n ? +((Number(part) / Number(whole)) * 100).toFixed(2) : 0);
