import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { copyTrades, lots, myWallets, signals, traderGroups, watchedWallets, type CopyTrade, type Lot, type Signal } from '../db/schema.js';
import { marketCapUsd } from '../engine/copyEngine.js';
import { LAMPORTS_PER_SOL } from '../util/misc.js';

// Read models for the web UI. Amounts: SOL values in lamports (numbers), token amounts as raw strings.

/**
 * Called by pages that show position values (Dashboard, Positions): refreshes prices of the tokens you
 * hold if they're older than the "price freshness" setting. Nothing fetches prices when no one is looking.
 */
export async function refreshPositionPrices(ctx: AppContext, paper?: boolean) {
  const mints = [...new Set(ctx.engine.openLots(undefined, paper).map((l) => l.mint))];
  await ctx.prices.refresh(mints, ctx.settings.get().priceRefreshSec * 1000);
  ctx.tokens.ensureMetadata(mints);
}

function tokenInfo(ctx: AppContext, mint: string) {
  const t = ctx.tokens.cached(mint);
  return { mint, symbol: t?.symbol ?? null, name: t?.name ?? null, icon: t?.icon ?? null, decimals: t?.decimals ?? null };
}

function lookups(ctx: AppContext) {
  const wallets = new Map(ctx.db.select().from(myWallets).all().map((w) => [w.id, w]));
  const groups = new Map(ctx.db.select().from(traderGroups).all().map((g) => [g.id, g]));
  const watched = new Map(ctx.db.select().from(watchedWallets).all().map((w) => [w.id, w]));
  return { wallets, groups, watched };
}

/** Current price in SOL, falling back to the last fill price for tokens Jupiter can't price yet. */
function currentPriceSol(ctx: AppContext, mint: string, fallback: number | null): { priceSol: number | null; stale: boolean } {
  const live = ctx.prices.priceSol(mint);
  if (live != null) return { priceSol: live, stale: false };
  return { priceSol: fallback, stale: true };
}

export function openPositions(ctx: AppContext, paper?: boolean, walletId?: number) {
  const { wallets, groups, watched } = lookups(ctx);
  const byKey = new Map<string, Lot[]>();
  for (const l of ctx.engine.openLots(walletId, paper)) {
    const key = `${l.myWalletId}:${l.mint}:${l.paper}`;
    byKey.set(key, [...(byKey.get(key) ?? []), l]);
  }
  const solUsd = ctx.prices.solUsd;
  return [...byKey.values()].map((group) => {
    const first = group[0];
    const decimals = first.tokenDecimals;
    const tokens = group.reduce((s, l) => s + BigInt(l.tokenAmount), 0n);
    const cost = group.reduce((s, l) => s + l.costLamports, 0);
    const invested = group.reduce((s, l) => s + l.totalCostLamports, 0);
    const entryMc =
      invested > 0 && group.every((l) => l.entryMcUsd != null)
        ? group.reduce((s, l) => s + (l.entryMcUsd ?? 0) * l.totalCostLamports, 0) / invested
        : (first.entryMcUsd ?? null);
    const lastFill = Math.max(...group.map((l) => l.lastPriceSol ?? 0)) || null;
    const { priceSol, stale } = currentPriceSol(ctx, first.mint, lastFill);
    const value = priceSol != null ? Math.round((Number(tokens) / 10 ** decimals) * priceSol * LAMPORTS_PER_SOL) : null;
    const pnl = value != null ? value - cost : null;
    const wallet = wallets.get(first.myWalletId);
    const g = first.groupId ? groups.get(first.groupId) : undefined;
    return {
      key: `${first.myWalletId}:${first.mint}:${first.paper}`,
      token: tokenInfo(ctx, first.mint),
      paper: first.paper,
      wallet: wallet ? { id: wallet.id, label: wallet.label, pubkey: wallet.pubkey } : null,
      group: g ? { id: g.id, name: g.name } : null,
      tokenAmount: tokens.toString(),
      costLamports: cost,
      valueLamports: value,
      pnlLamports: pnl,
      pnlPct: pnl != null && cost > 0 ? pnl / cost : null,
      entryMcUsd: entryMc,
      currentMcUsd: priceSol != null && solUsd ? marketCapUsd(priceSol * solUsd, ctx.tokens.cached(first.mint)) : null,
      priceStale: stale,
      openedAt: Math.min(...group.map((l) => l.openedAt)),
      sources: group.map((l) => {
        const w = l.sourceWalletId ? watched.get(l.sourceWalletId) : undefined;
        return {
          lotId: l.id,
          label: w ? w.label || w.address : 'manual',
          address: w?.address ?? null,
          role: w?.role ?? null,
          tokenAmount: l.tokenAmount,
          costLamports: l.costLamports,
          note: l.note,
        };
      }),
    };
  });
}

export function closedPositions(ctx: AppContext, limit = 200, paper?: boolean, walletId?: number) {
  const { wallets, groups, watched } = lookups(ctx);
  const conds = [eq(lots.status, 'closed')];
  if (walletId !== undefined) conds.push(eq(lots.myWalletId, walletId));
  if (paper !== undefined) conds.push(eq(lots.paper, paper));
  return ctx.db
    .select()
    .from(lots)
    .where(and(...conds))
    .orderBy(desc(lots.closedAt))
    .limit(limit)
    .all()
    .map((l) => {
      const w = l.sourceWalletId ? watched.get(l.sourceWalletId) : undefined;
      const g = l.groupId ? groups.get(l.groupId) : undefined;
      const wallet = wallets.get(l.myWalletId);
      return {
        id: l.id,
        token: tokenInfo(ctx, l.mint),
        paper: l.paper,
        wallet: wallet ? { id: wallet.id, label: wallet.label } : null,
        group: g ? { id: g.id, name: g.name } : null,
        source: w ? { label: w.label || w.address, address: w.address, role: w.role } : { label: 'manual', address: null, role: null },
        totalCostLamports: l.totalCostLamports,
        proceedsLamports: l.proceedsLamports,
        realizedLamports: l.realizedLamports,
        pnlPct: l.totalCostLamports > 0 ? l.realizedLamports / l.totalCostLamports : null,
        entryMcUsd: l.entryMcUsd,
        exitMcUsd: l.exitMcUsd,
        openedAt: l.openedAt,
        closedAt: l.closedAt,
        note: l.note,
      };
    });
}

export function enrichTrades(ctx: AppContext, rows: CopyTrade[]) {
  const { wallets, groups, watched } = lookups(ctx);
  const sigIds = rows.map((r) => r.signalId).filter((x): x is number => x != null);
  const sigs = new Map(
    sigIds.length ? ctx.db.select().from(signals).where(inArray(signals.id, sigIds)).all().map((s) => [s.id, s]) : [],
  );
  ctx.tokens.ensureMetadata(rows.map((r) => r.mint));
  return rows.map((t) => {
    const sig = t.signalId ? sigs.get(t.signalId) : undefined;
    const src = t.sourceWalletId ? watched.get(t.sourceWalletId) : undefined;
    const g = t.groupId ? groups.get(t.groupId) : undefined;
    const w = wallets.get(t.myWalletId);
    return {
      ...t,
      token: tokenInfo(ctx, t.mint),
      wallet: w ? { id: w.id, label: w.label } : null,
      group: g ? { id: g.id, name: g.name } : null,
      source: src ? { label: src.label || src.address, address: src.address, role: src.role } : null,
      trader: sig
        ? {
            signature: sig.signature,
            side: sig.side,
            pct: sig.pct,
            basisUsd: sig.basisUsd,
            spentUsd: sig.spentUsd,
            marketCapUsd: sig.marketCapUsd,
            quoteAmount: sig.quoteAmount,
            quoteMint: sig.quoteMint,
            detectedAt: sig.detectedAt,
            blockTime: sig.blockTime,
            venue: sig.venue,
          }
        : null,
      /** Detection → our transaction sent. */
      reactionMs: sig && t.sentAt ? t.sentAt - sig.detectedAt : null,
      /** Trader's block → we noticed. */
      detectLagMs: sig?.blockTime ? sig.detectedAt - sig.blockTime : null,
    };
  });
}

export function listTrades(ctx: AppContext, q: { limit?: number; before?: number; groupId?: number; walletId?: number; status?: string; paper?: boolean }) {
  const conds = [];
  if (q.before) conds.push(lt(copyTrades.id, q.before));
  if (q.groupId) conds.push(eq(copyTrades.groupId, q.groupId));
  if (q.walletId) conds.push(eq(copyTrades.myWalletId, q.walletId));
  if (q.status) conds.push(eq(copyTrades.status, q.status as CopyTrade['status']));
  if (q.paper !== undefined) conds.push(eq(copyTrades.paper, q.paper));
  const rows = ctx.db
    .select()
    .from(copyTrades)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(copyTrades.id))
    .limit(Math.min(q.limit ?? 100, 500))
    .all();
  return enrichTrades(ctx, rows);
}

export function enrichSignals(ctx: AppContext, rows: Signal[]) {
  const { groups, watched } = lookups(ctx);
  ctx.tokens.ensureMetadata(rows.map((r) => r.mint));
  return rows.map((s) => {
    const w = s.watchedWalletId ? watched.get(s.watchedWalletId) : undefined;
    const g = w ? groups.get(w.groupId) : undefined;
    return {
      ...s,
      token: tokenInfo(ctx, s.mint),
      wallet: w ? { id: w.id, label: w.label || w.address, role: w.role } : null,
      group: g ? { id: g.id, name: g.name } : null,
    };
  });
}

export function listSignals(ctx: AppContext, q: { limit?: number; before?: number; address?: string }) {
  const conds = [];
  if (q.before) conds.push(lt(signals.id, q.before));
  if (q.address) conds.push(eq(signals.address, q.address));
  const rows = ctx.db
    .select()
    .from(signals)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(signals.id))
    .limit(Math.min(q.limit ?? 100, 500))
    .all();
  return enrichSignals(ctx, rows);
}

/** What each watched wallet holds right now, from its most recent trade per token (no RPC needed). */
function heldByWatched(ctx: AppContext, address: string) {
  const latest = ctx.db
    .select()
    .from(signals)
    .where(sql`${signals.id} IN (SELECT max(id) FROM signals WHERE address = ${address} GROUP BY mint)`)
    .all();
  return latest
    .filter((s) => BigInt(s.postTokenBalance) > 0n)
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .map((s) => ({
      token: tokenInfo(ctx, s.mint),
      tokenAmount: s.postTokenBalance,
      decimals: s.tokenDecimals,
      lastSide: s.side,
      lastAt: s.detectedAt,
      lastMcUsd: s.marketCapUsd,
      currentMcUsd: ctx.prices.priceUsd(s.mint) != null ? marketCapUsd(ctx.prices.priceUsd(s.mint), ctx.tokens.cached(s.mint)) : null,
    }));
}

export function tradersView(ctx: AppContext) {
  const { wallets } = lookups(ctx);
  ctx.tokens.ensureMetadata(ctx.db.select({ mint: signals.mint }).from(signals).orderBy(desc(signals.id)).limit(200).all().map((r) => r.mint));
  const dayAgo = Date.now() - 86_400_000;
  const groupRows = ctx.db.select().from(traderGroups).orderBy(traderGroups.id).all();
  const watchedRows = ctx.db.select().from(watchedWallets).orderBy(watchedWallets.id).all();
  return groupRows.map((g) => {
    const stats = ctx.db
      .select({
        trades: sql<number>`count(*)`,
        realized: sql<number>`coalesce(sum(${copyTrades.realizedLamports}), 0)`,
      })
      .from(copyTrades)
      .where(and(eq(copyTrades.groupId, g.id), eq(copyTrades.status, 'confirmed')))
      .get()!;
    const open = new Set(ctx.db.select({ mint: lots.mint }).from(lots).where(and(eq(lots.groupId, g.id), eq(lots.status, 'open'))).all().map((r) => r.mint));
    const w = wallets.get(g.myWalletId);
    return {
      ...g,
      wallet: w ? { id: w.id, label: w.label, pubkey: w.pubkey } : null,
      stats: { trades: stats.trades, realizedLamports: stats.realized, openPositions: open.size },
      wallets: watchedRows
        .filter((x) => x.groupId === g.id)
        .map((x) => {
          const act = ctx.db
            .select({ n: sql<number>`count(*)`, last: sql<number | null>`max(${signals.detectedAt})` })
            .from(signals)
            .where(and(eq(signals.address, x.address), gte(signals.detectedAt, dayAgo)))
            .get()!;
          const lastEver = ctx.db.select({ last: sql<number | null>`max(${signals.detectedAt})` }).from(signals).where(eq(signals.address, x.address)).get()!;
          return { ...x, signals24h: act.n, lastSignalAt: lastEver.last, holding: heldByWatched(ctx, x.address) };
        }),
    };
  });
}

/**
 * Your wallets. Balances are the last known values; with `refresh` they are read from chain now
 * (1 request per wallet) – that only happens when you open My wallets or press Refresh.
 */
export async function walletsView(ctx: AppContext, refresh = false) {
  const groups = ctx.db.select().from(traderGroups).all();
  const rows = ctx.db.select().from(myWallets).where(eq(myWallets.archived, false)).orderBy(myWallets.id).all();
  if (refresh) await Promise.all(rows.map((w) => ctx.accounts.solBalance(w.pubkey, 0).catch(() => null)));
  return Promise.all(
    rows.map(async (w) => {
      const g = groups.find((x) => x.myWalletId === w.id);
      const cached = ctx.accounts.cachedSol(w.pubkey);
      return {
        id: w.id,
        label: w.label,
        pubkey: w.pubkey,
        source: w.source,
        createdAt: w.createdAt,
        group: g ? { id: g.id, name: g.name, paper: g.paper } : null,
        solLamports: cached?.lamports ?? null,
        balanceAt: cached?.at ?? null,
        paperCashLamports: g ? ctx.engine.paperCash(g, w.id) : null,
      };
    }),
  );
}

export async function dashboardView(ctx: AppContext) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const allOpen = openPositions(ctx);
  const summary = (paper: boolean) => {
    const open = allOpen.filter((p) => p.paper === paper);
    const realized = ctx.db
      .select({ v: sql<number>`coalesce(sum(${lots.realizedLamports}), 0)` })
      .from(lots)
      .where(eq(lots.paper, paper))
      .get()!.v;
    const closed = ctx.db
      .select({ n: sql<number>`count(*)`, wins: sql<number>`coalesce(sum(case when ${lots.realizedLamports} > 0 then 1 else 0 end), 0)` })
      .from(lots)
      .where(and(eq(lots.paper, paper), eq(lots.status, 'closed')))
      .get()!;
    const tradeCounts = ctx.db
      .select({
        all: sql<number>`coalesce(sum(case when ${copyTrades.status} = 'confirmed' then 1 else 0 end), 0)`,
        today: sql<number>`coalesce(sum(case when ${copyTrades.status} = 'confirmed' and ${copyTrades.createdAt} >= ${startOfDay.getTime()} then 1 else 0 end), 0)`,
        skippedToday: sql<number>`coalesce(sum(case when ${copyTrades.status} = 'skipped' and ${copyTrades.createdAt} >= ${startOfDay.getTime()} then 1 else 0 end), 0)`,
        failedToday: sql<number>`coalesce(sum(case when ${copyTrades.status} = 'failed' and ${copyTrades.createdAt} >= ${startOfDay.getTime()} then 1 else 0 end), 0)`,
      })
      .from(copyTrades)
      .where(eq(copyTrades.paper, paper))
      .get()!;
    const unrealized = open.reduce((s, p) => s + (p.pnlLamports ?? 0), 0);
    const openValue = open.reduce((s, p) => s + (p.valueLamports ?? 0), 0);
    return {
      realizedLamports: realized,
      unrealizedLamports: unrealized,
      totalPnlLamports: realized + unrealized,
      openValueLamports: openValue,
      openPositions: open.length,
      closedPositions: closed.n,
      winRate: closed.n ? closed.wins / closed.n : null,
      trades: tradeCounts,
    };
  };
  const recentTrades = enrichTrades(ctx, ctx.db.select().from(copyTrades).orderBy(desc(copyTrades.id)).limit(25).all());
  const recentSignals = enrichSignals(ctx, ctx.db.select().from(signals).orderBy(desc(signals.id)).limit(25).all());
  // Each wallet: cash + what its open positions are worth now = start + realized + unrealized.
  const groups = new Map(ctx.db.select().from(traderGroups).all().map((g) => [g.myWalletId, g]));
  const realizedByWallet = new Map(
    ctx.db
      .select({ walletId: lots.myWalletId, paper: lots.paper, v: sql<number>`coalesce(sum(${lots.realizedLamports}), 0)` })
      .from(lots)
      .groupBy(lots.myWalletId, lots.paper)
      .all()
      .map((r) => [`${r.walletId}:${r.paper}`, r.v]),
  );
  const wallets = (await walletsView(ctx, false)).map((w) => {
    const paper = w.group?.paper ?? false;
    const open = allOpen.filter((p) => p.wallet?.id === w.id && p.paper === paper);
    // A position no price is known for yet counts at what it cost.
    const openValue = open.reduce((s, p) => s + (p.valueLamports ?? p.costLamports), 0);
    const unrealized = open.reduce((s, p) => s + (p.pnlLamports ?? 0), 0);
    const cash = paper ? w.paperCashLamports : w.solLamports;
    const g = groups.get(w.id);
    return {
      ...w,
      openValueLamports: openValue,
      openPositions: open.length,
      unrealizedLamports: unrealized,
      realizedLamports: realizedByWallet.get(`${w.id}:${paper}`) ?? 0,
      worthLamports: cash != null ? cash + openValue : null,
      startLamports: paper && g ? Math.round(g.paperStartSol * LAMPORTS_PER_SOL) : null,
    };
  });
  return {
    live: summary(false),
    paper: summary(true),
    wallets,
    recentTrades,
    recentSignals,
  };
}
