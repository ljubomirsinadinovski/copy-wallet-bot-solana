import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { PublicKey } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { SESSION_COOKIE } from '../auth.js';
import { Backtester } from '../backtest/backtest.js';
import type { AppContext } from '../context.js';
import { lots, myWallets, traderGroups, watchedWallets } from '../db/schema.js';
import { CASH_STABLES } from '../solana/constants.js';
import { bus, type BusEvent } from '../events.js';
import { MIN_PASSPHRASE } from '../keystore/keystore.js';
import { logEvents, recentLogs, type LogEntry } from '../logger.js';
import { globalSettingsSchema } from '../settings.js';
import { errorMessage } from '../util/misc.js';
import { closedPositions, dashboardView, listSignals, listTrades, openPositions, refreshPositionPrices, tradersView, walletsView } from './views.js';

const address = z.string().trim().refine((v) => {
  try {
    return new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
}, 'Not a valid Solana address');

const groupSettings = z.object({
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean(),
  paper: z.boolean(),
  paperStartSol: z.number().min(0),
  multiplier: z.number().min(0.01).max(100),
  minSol: z.number().min(0),
  maxSol: z.number().min(0),
  maxPct: z.number().min(0).max(100),
  maxSolPerToken: z.number().min(0),
  reserveSol: z.number().min(0),
  slippageBps: z.number().int().min(1).max(10_000).nullable(),
  skipIfHolding: z.boolean(),
  /** 0 = no limit */
  maxOpenPositions: z.number().int().min(0).max(1000),
  sizingMode: z.enum(['size', 'cash']),
  copyPct: z.number().gt(0).max(1000),
  minUsd: z.number().min(0),
  maxUsdPerToken: z.number().min(0),
});

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '));
  return r.data;
}

/** Errors from actions the user asked for are shown to them, not logged as server failures. */
async function userAction<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, errorMessage(err));
  }
}

const idParam = (req: FastifyRequest) => parse(z.coerce.number().int().positive(), (req.params as any).id);

export async function startApi(ctx: AppContext) {
  const { cfg, db, keystore, sessions, engine, log } = ctx;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(cookie);
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof HttpError ? err.status : ((err as any).statusCode ?? 500);
    if (status >= 500) log.error({ err: errorMessage(err) }, 'api error');
    reply.status(status).send({ error: errorMessage(err) });
  });

  const loggedIn = (req: FastifyRequest) => sessions.valid(req.cookies[SESSION_COOKIE]);
  const startSession = (reply: FastifyReply) => {
    const { token, maxAge } = sessions.create();
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge });
  };

  // Everything under /api except auth requires a session.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/') || req.url === '/api/health') return;
    if (!loggedIn(req)) return reply.status(401).send({ error: 'Not logged in' });
  });

  // ── auth ────────────────────────────────────────────────────────────────
  // Used by Docker and the deploy script: is the bot up, which version, is it watching wallets.
  const startedAt = Date.now();
  app.get('/api/health', async () => {
    const st = ctx.stream.status();
    return {
      ok: true,
      version: process.env.GIT_SHA || 'dev',
      startedAt,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      watching: { kind: st.kind, connected: st.connected, wallets: st.wallets },
      liveTrading: cfg.liveTrading,
      keysUnlocked: keystore.isUnlocked,
    };
  });

  app.get('/api/auth/status', async (req) => ({
    setup: keystore.isSetup,
    loggedIn: loggedIn(req),
    unlocked: keystore.isUnlocked,
    minPassphrase: MIN_PASSPHRASE,
  }));

  const passphraseBody = z.object({ passphrase: z.string().min(1) });

  app.post('/api/auth/setup', async (req, reply) => {
    if (keystore.isSetup) throw new HttpError(400, 'Already set up');
    const { passphrase } = parse(passphraseBody, req.body);
    keystore.setup(passphrase);
    startSession(reply);
    log.info('passphrase created, keystore unlocked');
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (sessions.throttled()) throw new HttpError(429, 'Too many attempts – wait a minute');
    const { passphrase } = parse(passphraseBody, req.body);
    if (!keystore.unlock(passphrase)) {
      sessions.recordFailure();
      log.warn('failed login attempt');
      throw new HttpError(401, 'Wrong passphrase');
    }
    startSession(reply);
    log.info('logged in, keystore unlocked');
    return { ok: true };
  });

  app.post('/api/auth/unlock', async (req) => {
    if (!loggedIn(req)) throw new HttpError(401, 'Not logged in');
    if (sessions.throttled()) throw new HttpError(429, 'Too many attempts – wait a minute');
    const { passphrase } = parse(passphraseBody, req.body);
    if (!keystore.unlock(passphrase)) {
      sessions.recordFailure();
      throw new HttpError(401, 'Wrong passphrase');
    }
    log.info('keystore unlocked');
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/change-passphrase', async (req) => {
    if (!loggedIn(req)) throw new HttpError(401, 'Not logged in');
    const { current, next } = parse(z.object({ current: z.string(), next: z.string() }), req.body);
    keystore.changePassphrase(current, next);
    log.info('passphrase changed');
    return { ok: true };
  });

  // ── status & engine ─────────────────────────────────────────────────────
  /**
   * Cash across all your wallets: paper wallets at their paper balance, live wallets at their last
   * known on-chain balance (read once if never read; otherwise updated by trades and Refresh).
   */
  const overallBalance = async () => {
    const groups = db.select().from(traderGroups).all();
    let paper = 0;
    let live = 0;
    let unknown = 0;
    for (const w of db.select().from(myWallets).where(eq(myWallets.archived, false)).all()) {
      const g = groups.find((x) => x.myWalletId === w.id);
      if (g?.paper) {
        paper += engine.paperCash(g, w.id);
        continue;
      }
      const lamports = await ctx.accounts.solBalance(w.pubkey, Number.POSITIVE_INFINITY).catch(() => null);
      if (lamports == null) unknown++;
      else live += lamports;
    }
    return { paperLamports: paper, liveLamports: live, totalLamports: paper + live, unknownWallets: unknown };
  };

  app.get('/api/status', async () => {
    const s = ctx.settings.get();
    await ctx.prices.solUsdFresh(300_000); // only while the page is open
    return {
      balance: await overallBalance(),
      stream: ctx.stream.status(),
      heliusTier: cfg.heliusTier,
      heliusKey: Boolean(cfg.heliusApiKey),
      heliusProjectId: cfg.heliusProjectId,
      jupiterKey: Boolean(cfg.jupiterApiKey),
      liveTrading: cfg.liveTrading,
      autoUnlock: Boolean(cfg.keystorePassphrase),
      paused: s.paused,
      pausedReason: s.pausedReason,
      unlocked: keystore.isUnlocked,
      solUsd: ctx.prices.solUsd,
      usage: ctx.usage.snapshot(),
      queues: { rpc: ctx.rpc.queued, jupiter: ctx.jupiter.queued },
    };
  });

  // Real Helius usage for this billing cycle (Admin API). Only called while a page shows it; cached 60 s.
  let heliusUsage: { at: number; data: unknown } | null = null;
  app.get('/api/helius-usage', async () => {
    if (!cfg.heliusProjectId || !cfg.heliusApiKey) throw new HttpError(400, 'Set HELIUS_API_KEY and HELIUS_PROJECT_ID in .env');
    if (heliusUsage && Date.now() - heliusUsage.at < 60_000) return heliusUsage.data;
    const res = await fetch(`https://admin-api.helius.xyz/v0/admin/projects/${encodeURIComponent(cfg.heliusProjectId)}/usage`, {
      headers: { 'X-Api-Key': cfg.heliusApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `Helius usage unavailable: ${body?.error ?? body?.message ?? `HTTP ${res.status}`}`);
    const used = Number(body.creditsUsed ?? 0);
    const remaining = Number(body.creditsRemaining ?? 0);
    const data = {
      used,
      limit: Number(body.subscriptionDetails?.creditsLimit ?? used + remaining),
      remaining,
      plan: body.subscriptionDetails?.plan ?? null,
      cycleStart: body.creditCycle?.start ?? null,
      cycleEnd: body.creditCycle?.end ?? null,
      breakdown: body.credits ?? {},
    };
    heliusUsage = { at: Date.now(), data };
    return data;
  });

  app.post('/api/telegram/test', async () => {
    await userAction(() =>
      ctx.telegram.sendNow(
        '✅ <b>Test message from your copy bot</b>\nNotifications are working. You’ll get a message for every copied buy/sell, failures, skipped copies and connection problems.',
      ),
    );
    return { ok: true };
  });

  app.post('/api/engine/pause', async () => {
    ctx.settings.update({ paused: true, pausedReason: 'paused from the dashboard' });
    log.warn('bot PAUSED from the dashboard');
    bus.emit('event', { type: 'status' } satisfies BusEvent);
    return { ok: true };
  });

  app.post('/api/engine/resume', async () => {
    ctx.settings.update({ paused: false, pausedReason: null });
    log.info('bot resumed');
    bus.emit('event', { type: 'status' } satisfies BusEvent);
    return { ok: true };
  });

  // ── dashboard & positions ───────────────────────────────────────────────
  // Prices are fetched only when the page asks (on opening it, or Refresh); live-update reloads after a
  // trade use the prices already known.
  app.get('/api/dashboard', async (req) => {
    if ((req.query as { prices?: string }).prices === '1') await refreshPositionPrices(ctx);
    return dashboardView(ctx);
  });

  app.get('/api/positions', async (req) => {
    const q = req.query as { status?: string; paper?: string; prices?: string };
    const paper = q.paper === undefined ? undefined : q.paper === 'true';
    const walletId = (q as { walletId?: string }).walletId ? Number((q as { walletId?: string }).walletId) : undefined;
    if (q.status === 'closed') {
      const rows = closedPositions(ctx, 300, paper, walletId);
      ctx.tokens.ensureMetadata(rows.map((r) => r.token.mint));
      return rows;
    }
    // Prices only when the page asks (opening it, or Refresh); live-update reloads use known prices.
    if (q.prices === '1') await refreshPositionPrices(ctx, paper);
    return openPositions(ctx, paper, walletId);
  });

  app.post('/api/positions/sell', async (req) => {
    const b = parse(z.object({ myWalletId: z.number().int(), mint: address, pct: z.number().gt(0).max(1), paper: z.boolean() }), req.body);
    log.info(`manual sell ${(b.pct * 100).toFixed(0)}% requested`);
    await userAction(() => engine.manualSell(b.myWalletId, b.mint, b.pct, b.paper));
    return { ok: true };
  });

  app.post('/api/positions/buy', async (req) => {
    const b = parse(z.object({ myWalletId: z.number().int(), mint: address, sol: z.number().gt(0).max(1000), paper: z.boolean() }), req.body);
    log.info(`manual buy ${b.sol} SOL requested`);
    await userAction(() => engine.manualBuy(b.myWalletId, b.mint, b.sol, b.paper));
    return { ok: true };
  });

  // ── trader groups & watched wallets ─────────────────────────────────────
  app.get('/api/groups', async () => tradersView(ctx));

  app.post('/api/groups', async (req) => {
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        myWalletId: z.number().int().optional(),
        mainAddress: address.optional(),
        mainLabel: z.string().max(60).optional(),
      }),
      req.body,
    );
    let walletId = b.myWalletId;
    if (walletId === undefined) {
      if (!keystore.isUnlocked) throw new HttpError(400, 'Unlock the keystore to create a wallet');
      walletId = keystore.generate(`${b.name} wallet`).id;
      log.info(`generated a new wallet for trader group "${b.name}"`);
    } else {
      const w = db.select().from(myWallets).where(eq(myWallets.id, walletId)).get();
      if (!w || w.archived) throw new HttpError(400, 'Wallet not found');
      if (db.select().from(traderGroups).where(eq(traderGroups.myWalletId, walletId)).get())
        throw new HttpError(400, 'That wallet already copies another trader group – each group gets its own wallet');
    }
    const group = db.insert(traderGroups).values({ name: b.name, myWalletId: walletId, createdAt: Date.now() }).returning().get();
    if (b.mainAddress) addWatched(group.id, b.mainAddress, b.mainLabel ?? '', 'main');
    ctx.refreshSubscriptions();
    log.info(`trader group "${b.name}" created (paper mode)`);
    return group;
  });

  app.patch('/api/groups/:id', async (req) => {
    const id = idParam(req);
    const b = parse(groupSettings.extend({ myWalletId: z.number().int().positive() }).partial(), req.body);
    const current = db.select().from(traderGroups).where(eq(traderGroups.id, id)).get();
    if (!current) throw new HttpError(404, 'Group not found');

    // Switching the wallet this trader copies into.
    let movedTo: string | null = null;
    if (b.myWalletId !== undefined && b.myWalletId !== current.myWalletId) {
      const target = db.select().from(myWallets).where(eq(myWallets.id, b.myWalletId)).get();
      if (!target || target.archived) throw new HttpError(400, 'Wallet not found');
      const usedBy = db.select().from(traderGroups).where(eq(traderGroups.myWalletId, b.myWalletId)).get();
      if (usedBy) throw new HttpError(400, `${target.label} already copies ${usedBy.name} – each trader needs its own wallet`);
      const open = db
        .select()
        .from(lots)
        .where(and(eq(lots.myWalletId, current.myWalletId), eq(lots.groupId, id), eq(lots.status, 'open')))
        .all();
      if (open.length)
        throw new HttpError(
          400,
          `${current.name} still has ${open.length} open position${open.length > 1 ? 's' : ''} in the current wallet – close ${open.length > 1 ? 'them' : 'it'} first, otherwise the trader's sells couldn't be copied`,
        );
      movedTo = target.label;
    }

    const updated = db.update(traderGroups).set(b).where(eq(traderGroups.id, id)).returning().get()!;
    if (movedTo) log.info(`trader group "${updated.name}" now copies into "${movedTo}"`);
    if (b.paper === false && current.paper) log.warn(`trader group "${updated.name}" switched to LIVE trading`);
    return updated;
  });

  app.delete('/api/groups/:id', async (req) => {
    const id = idParam(req);
    const open = db.select().from(lots).where(and(eq(lots.groupId, id), eq(lots.status, 'open'))).all();
    if (open.length) throw new HttpError(400, 'Close this group’s open positions first');
    db.delete(watchedWallets).where(eq(watchedWallets.groupId, id)).run();
    db.delete(traderGroups).where(eq(traderGroups.id, id)).run();
    ctx.refreshSubscriptions();
    return { ok: true };
  });

  app.post('/api/groups/:id/close-all', async (req) => {
    const n = await engine.closeAllForGroup(idParam(req));
    return { ok: true, positions: n };
  });

  const addWatched = (groupId: number, addr: string, label: string, role: 'main' | 'side' | 'bundler') => {
    const existing = db.select().from(watchedWallets).where(eq(watchedWallets.address, addr)).get();
    if (existing) throw new HttpError(400, 'This wallet is already being watched (each address can be in one group)');
    if (db.select().from(myWallets).where(eq(myWallets.pubkey, addr)).get()) throw new HttpError(400, 'That is one of your own wallets');
    return db.insert(watchedWallets).values({ groupId, address: addr, label: label.trim(), role, createdAt: Date.now() }).returning().get();
  };

  app.post('/api/groups/:id/wallets', async (req) => {
    const groupId = idParam(req);
    if (!db.select().from(traderGroups).where(eq(traderGroups.id, groupId)).get()) throw new HttpError(404, 'Group not found');
    const b = parse(z.object({ address, label: z.string().max(60).default(''), role: z.enum(['main', 'side', 'bundler']).default('side') }), req.body);
    const row = addWatched(groupId, b.address, b.label, b.role);
    ctx.refreshSubscriptions();
    log.info(`now watching ${b.label || b.address} (${b.role})`);
    return row;
  });

  app.patch('/api/watched/:id', async (req) => {
    const b = parse(
      z.object({ label: z.string().max(60), role: z.enum(['main', 'side', 'bundler']), enabled: z.boolean(), copyBuys: z.boolean(), copySells: z.boolean() }).partial(),
      req.body,
    );
    const row = db.update(watchedWallets).set(b).where(eq(watchedWallets.id, idParam(req))).returning().get();
    if (!row) throw new HttpError(404, 'Wallet not found');
    ctx.refreshSubscriptions();
    return row;
  });

  app.delete('/api/watched/:id', async (req) => {
    db.delete(watchedWallets).where(eq(watchedWallets.id, idParam(req))).run();
    ctx.refreshSubscriptions();
    return { ok: true };
  });

  /**
   * Backtest: what copying a wallet's last N tokens would have made, each copy priced at the token's
   * first trade `delaySec` after the trader's. Runs only when you press Run (~10 credits per lookup).
   */
  let backtestRunning = false;
  app.post('/api/backtest', async (req) => {
    const body = parse(
      z.object({
        wallet: address,
        tokens: z.number().int().min(1).max(50).default(15),
        delaySec: z.number().min(0).max(60).default(1),
        copyPct: z.number().min(0.1).max(1000).optional(),
        minUsd: z.number().min(0).max(100_000).optional(),
        maxUsdPerToken: z.number().min(0.01).max(1_000_000).optional(),
      }),
      req.body,
    );
    if (backtestRunning) throw new HttpError(409, 'A backtest is already running – wait for it to finish');
    backtestRunning = true;
    try {
      const s = ctx.settings.get();
      // Default sizing: the trader group that watches this wallet, else the new-group defaults.
      const watched = db.select().from(watchedWallets).where(eq(watchedWallets.address, body.wallet)).get();
      const group = watched ? db.select().from(traderGroups).where(eq(traderGroups.id, watched.groupId)).get() : undefined;
      const solUsd = await ctx.prices.solUsdFresh();
      if (!solUsd) throw new HttpError(503, 'SOL price unavailable – try again in a moment');
      const bt = new Backtester(
        ctx.rpc,
        (mint) => ctx.tokens.cached(mint)?.symbol ?? null,
        async (mint) => {
          const t = await ctx.tokens.get(mint);
          return { supply: BigInt(t.supply), freezeAuthority: t.freezeAuthority, mintAuthority: t.mintAuthority, riskyExtensions: t.riskyExtensions, transferFeeBps: t.transferFeeBps };
        },
      );
      const result = await userAction(() =>
        bt.run({
          wallet: body.wallet,
          tokens: body.tokens,
          delaySec: body.delaySec,
          copyPct: body.copyPct ?? group?.copyPct ?? 10,
          minUsd: body.minUsd ?? group?.minUsd ?? 3,
          maxUsdPerToken: body.maxUsdPerToken ?? group?.maxUsdPerToken ?? 50,
          feePerTradeSol: s.priorityFeeSol + s.tipSol + 0.000005,
          copyCreatorBuys: s.copyCreatorBuys,
          safety: {
            skipFreezeAuthority: s.skipFreezeAuthority,
            skipMintAuthority: s.skipMintAuthority,
            skipRiskyToken2022: s.skipRiskyToken2022,
            maxTransferFeePct: s.maxTransferFeePct,
            blacklist: s.blacklist,
          },
          quoteMints: engine.quoteMints(),
          solUsd,
        }),
      );
      ctx.tokens.ensureMetadata(result.tokens.filter((t) => !t.symbol).map((t) => t.mint));
      log.info(`backtest ${body.wallet.slice(0, 4)}… · ${result.tokens.length} tokens · ${result.scannedTxs} transactions · ~${result.creditsEstimate} credits`);
      return { ...result, group: group ? { id: group.id, name: group.name } : null, watchedLabel: watched?.label ?? null, solUsd };
    } finally {
      backtestRunning = false;
    }
  });

  /**
   * Cash of every watched wallet (SOL + USDC + USDT + USD1, in $) – to judge how big they trade
   * before choosing your copy %. One request per wallet, only when the Traders page asks for it.
   */
  app.get('/api/watched/cash', async (req) => {
    const refresh = (req.query as { refresh?: string }).refresh === '1';
    const rows = db.select().from(watchedWallets).all();
    const solUsd = await ctx.prices.solUsdFresh();
    const out: Record<number, { solUsd: number | null; stablesUsd: Record<string, number>; totalUsd: number | null; at: number } | { error: string }> = {};
    await Promise.all(
      rows.map(async (w) => {
        try {
          const c = await ctx.accounts.cashBalances(w.address, [...CASH_STABLES], true, refresh ? 0 : 5 * 60_000);
          const stablesUsd: Record<string, number> = {};
          for (const [mint, b] of c.stables) {
            const v = Number(b.raw) / 10 ** b.decimals;
            if (v > 0) stablesUsd[ctx.tokens.symbol(mint)] = v;
          }
          const sol = c.lamports != null && solUsd ? (c.lamports / 1e9) * solUsd : null;
          out[w.id] = { solUsd: sol, stablesUsd, totalUsd: sol == null ? null : sol + Object.values(stablesUsd).reduce((a, b) => a + b, 0), at: c.at };
        } catch (err) {
          out[w.id] = { error: errorMessage(err) };
        }
      }),
    );
    return out;
  });

  /** Verifies a watched wallet's holdings on-chain (2 RPC credits). */
  app.get('/api/watched/:id/holdings', async (req) => {
    const w = db.select().from(watchedWallets).where(eq(watchedWallets.id, idParam(req))).get();
    if (!w) throw new HttpError(404, 'Wallet not found');
    const list = await ctx.accounts.holdings(w.address, 60_000);
    return list.filter((h) => h.raw > 0n).map((h) => ({ mint: h.mint, raw: h.raw.toString(), decimals: h.decimals, symbol: ctx.tokens.cached(h.mint)?.symbol ?? null }));
  });

  // ── your wallets ─────────────────────────────────────────────────────────
  app.get('/api/wallets', async (req) => walletsView(ctx, (req.query as { refresh?: string }).refresh === '1'));

  app.post('/api/wallets/generate', async (req) => {
    const { label } = parse(z.object({ label: z.string().trim().max(60).default('Wallet') }), req.body ?? {});
    const w = keystore.generate(label);
    ctx.refreshSubscriptions();
    log.info(`generated wallet ${w.pubkey}`);
    return { id: w.id, pubkey: w.pubkey, label: w.label };
  });

  app.post('/api/wallets/import', async (req) => {
    const b = parse(z.object({ label: z.string().trim().max(60).default('Imported'), secret: z.string().min(32) }), req.body);
    const w = keystore.import(b.label, b.secret);
    ctx.refreshSubscriptions();
    log.info(`imported wallet ${w.pubkey}`);
    return { id: w.id, pubkey: w.pubkey, label: w.label };
  });

  app.patch('/api/wallets/:id', async (req) => {
    const { label } = parse(z.object({ label: z.string().trim().min(1).max(60) }), req.body);
    db.update(myWallets).set({ label }).where(eq(myWallets.id, idParam(req))).run();
    return { ok: true };
  });

  app.delete('/api/wallets/:id', async (req) => {
    const id = idParam(req);
    if (db.select().from(traderGroups).where(eq(traderGroups.myWalletId, id)).get()) throw new HttpError(400, 'Delete or reassign its trader group first');
    if (db.select().from(lots).where(and(eq(lots.myWalletId, id), eq(lots.status, 'open'))).get()) throw new HttpError(400, 'Wallet has open positions');
    // Archived, not deleted: the encrypted key stays in the database so funds are never lost.
    db.update(myWallets).set({ archived: true }).where(eq(myWallets.id, id)).run();
    ctx.refreshSubscriptions();
    return { ok: true };
  });

  app.post('/api/wallets/:id/export', async (req) => {
    const { passphrase } = parse(passphraseBody, req.body);
    if (sessions.throttled()) throw new HttpError(429, 'Too many attempts – wait a minute');
    try {
      const secret = keystore.exportSecret(idParam(req), passphrase);
      log.warn('a private key was exported from the web UI');
      return { secret };
    } catch (err) {
      sessions.recordFailure();
      throw new HttpError(400, errorMessage(err));
    }
  });

  app.get('/api/wallets/:id/holdings', async (req) => {
    const w = db.select().from(myWallets).where(eq(myWallets.id, idParam(req))).get();
    if (!w) throw new HttpError(404, 'Wallet not found');
    const list = await ctx.accounts.holdings(w.pubkey);
    await ctx.prices.refresh(list.filter((h) => h.raw > 0n).map((h) => h.mint), 60_000);
    ctx.tokens.ensureMetadata(list.map((h) => h.mint));
    return list.map((h) => ({
      mint: h.mint,
      raw: h.raw.toString(),
      decimals: h.decimals,
      symbol: ctx.tokens.cached(h.mint)?.symbol ?? null,
      priceUsd: ctx.prices.priceUsd(h.mint),
    }));
  });

  app.post('/api/wallets/:id/close-empty', async (req) => {
    if (!cfg.liveTrading) throw new HttpError(400, 'Live trading is off (LIVE_TRADING=false in .env)');
    const w = db.select().from(myWallets).where(eq(myWallets.id, idParam(req))).get();
    if (!w) throw new HttpError(404, 'Wallet not found');
    return userAction(() => ctx.accounts.closeEmptyAccounts(w.pubkey));
  });

  // ── trades, signals, logs ───────────────────────────────────────────────
  app.get('/api/trades', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return listTrades(ctx, {
      limit: q.limit ? Number(q.limit) : undefined,
      before: q.before ? Number(q.before) : undefined,
      groupId: q.groupId ? Number(q.groupId) : undefined,
      walletId: q.walletId ? Number(q.walletId) : undefined,
      status: q.status || undefined,
      paper: q.paper === undefined ? undefined : q.paper === 'true',
    });
  });

  app.get('/api/signals', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return listSignals(ctx, { limit: q.limit ? Number(q.limit) : undefined, before: q.before ? Number(q.before) : undefined, address: q.address });
  });

  app.get('/api/logs', async (req) => recentLogs(Number((req.query as any).limit ?? 500)));

  // ── settings ─────────────────────────────────────────────────────────────
  app.get('/api/settings', async () => ({
    global: ctx.settings.get(),
    env: {
      heliusTier: cfg.heliusTier,
      heliusKey: Boolean(cfg.heliusApiKey),
      heliusProjectId: cfg.heliusProjectId,
      jupiterKey: Boolean(cfg.jupiterApiKey),
      jupiterRps: cfg.jupiterRps,
      rpcRps: cfg.rpcRps,
      liveTrading: cfg.liveTrading,
      autoUnlock: Boolean(cfg.keystorePassphrase),
      dataDir: cfg.dataDir,
      logLevel: cfg.logLevel,
      senderUrl: cfg.senderUrl,
      telegram: ctx.telegram.configured,
    },
    usage: ctx.usage.snapshot(),
  }));

  app.patch('/api/settings', async (req) => {
    const patch = parse(globalSettingsSchema.partial(), req.body);
    for (const m of [...(patch.blacklist ?? []), ...(patch.extraQuoteMints ?? [])]) parse(address, m);
    const s = ctx.settings.update(patch);
    log.info('settings updated');
    bus.emit('event', { type: 'status' } satisfies BusEvent);
    return s;
  });

  // ── live updates ─────────────────────────────────────────────────────────
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    if (!loggedIn(req)) {
      socket.close(4401, 'Not logged in');
      return;
    }
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const onEvent = (e: BusEvent) => send(e);
    const onLog = (entry: LogEntry) => send({ type: 'log', entry });
    bus.on('event', onEvent);
    logEvents.on('log', onLog);
    socket.on('close', () => {
      bus.off('event', onEvent);
      logEvents.off('log', onLog);
    });
  });

  // ── built web UI (production / Docker) ──────────────────────────────────
  if (fs.existsSync(path.join(cfg.webDist, 'index.html'))) {
    // Files are looked up on each request (wildcard), so a rebuilt UI is picked up without a restart.
    await app.register(fastifyStatic, { root: cfg.webDist });
    // index.html must never be cached, or the browser keeps asking for old asset file names.
    app.addHook('onSend', async (req, reply, payload) => {
      if (!req.url.startsWith('/api/') && String(reply.getHeader('content-type') ?? '').startsWith('text/html')) reply.header('cache-control', 'no-cache');
      return payload;
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ host: cfg.host, port: cfg.port });
  return app;
}
