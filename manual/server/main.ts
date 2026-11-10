/**
 * Manual trading – a small, separate server for buying and selling tokens by hand from your own
 * wallets. Start it when you want to trade (manual/run.sh), stop it when you're done.
 *
 * It reuses the bot's own modules (keystore, executors, the engine's manual buy/sell, the database),
 * but never watches or copies anyone. Positions are stored in the same database tables as the bot's,
 * so every start reads them back; unfinished transactions are recovered and positions are checked
 * against the chain.
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import { PublicKey } from '@solana/web3.js';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { Sessions } from '../../server/src/auth.js';
import { enrichTrades } from '../../server/src/api/views.js';
import { config, redactUrl } from '../../server/src/config.js';
import type { AppContext } from '../../server/src/context.js';
import { openDb } from '../../server/src/db/client.js';
import { copyTrades, lots, myWallets, traderGroups, type Lot } from '../../server/src/db/schema.js';
import { CopyEngine, marketCapUsd } from '../../server/src/engine/copyEngine.js';
import { DirectExecutor, LiveExecutor, PaperExecutor, RoutingExecutor, SwapError, type SwapFill, type SwapParams } from '../../server/src/executor/executors.js';
import { PumpDirect } from '../../server/src/executor/pump.js';
import { Keystore, MIN_PASSPHRASE, parseSecret } from '../../server/src/keystore/keystore.js';
import { acquireLock } from '../../server/src/lock.js';
import { enableFileLogging, logger, moduleLogger } from '../../server/src/logger.js';
import { PriceService } from '../../server/src/prices/priceService.js';
import { SettingsStore } from '../../server/src/settings.js';
import { AccountService } from '../../server/src/solana/accounts.js';
import { JupiterClient } from '../../server/src/solana/jupiter.js';
import { PRIORITY, RpcClient } from '../../server/src/solana/rpc.js';
import { WSOL_MINT } from '../../server/src/solana/constants.js';
import { SenderClient } from '../../server/src/solana/sender.js';
import { TokenService } from '../../server/src/solana/tokens.js';
import { UsageTracker } from '../../server/src/util/usage.js';
import { errorMessage, mulFraction, sleep } from '../../server/src/util/misc.js';
import { MarketReader } from './market.js';
import { SellPlans, planSellScope } from './sellPlans.js';

const PORT = Number(process.env.MANUAL_PORT ?? 8790);
const HOST = '127.0.0.1';
const WEB_DIST = path.join(import.meta.dirname, '../web/dist');
const LAMPORTS = 1e9;
/** Its own cookie: browsers share cookies across ports, and the bot's page uses `cw_session`. */
const SESSION_COOKIE = 'cw_manual_session';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const address = z
  .string()
  .trim()
  .refine((v) => {
    try {
      return new PublicKey(v).toBase58() === v;
    } catch {
      return false;
    }
  }, 'Not a valid Solana address');

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * The bot only tries the direct pump.fun / PumpSwap route when the copied trader's transaction shows
 * it, or when the mint ends in "pump". Manual trades have no trader transaction, and some PumpSwap
 * coins don't end in "pump" (e.g. Token-2022 coins Jupiter can't route). So here every trade tries
 * the bonding curve, then the PumpSwap pool, and only then Jupiter. The direct route gives up before
 * anything is sent when the token isn't on pump.fun.
 */
class ManualRouting extends RoutingExecutor {
  override async swap(p: SwapParams): Promise<SwapFill> {
    const direct = p.venue == null ? { ...p, venue: 'pumpfun' as const } : p;
    // A sell plan's sell: its own (tight) slippage, and no retries at the engine's wider ones.
    const plan = planSellScope.getStore();
    if (!plan) return super.swap(direct);
    if (plan.attempts++ > 0) throw new SwapError(plan.firstError ?? 'sell failed', undefined, true);
    try {
      return await super.swap({ ...direct, slippageBps: plan.slippageBps });
    } catch (err) {
      plan.firstError = errorMessage(err);
      throw err;
    }
  }
}

async function main() {
  const log = moduleLogger('manual');
  // Same lock as the bot: never runs at the same time as the bot (or another copy) on this data folder.
  let releaseLock: () => void;
  try {
    releaseLock = acquireLock(config.dataDir);
  } catch (err) {
    log.fatal(errorMessage(err));
    process.exit(1);
  }
  await enableFileLogging();

  const { db, close: closeDb } = openDb(config.dataDir, config.migrationsDir);
  const settings = new SettingsStore(db);
  const usage = new UsageTracker(settings);
  const keystore = new Keystore(db, settings);
  const sessions = new Sessions(db);
  if (config.keystorePassphrase && keystore.isSetup) {
    if (keystore.unlock(config.keystorePassphrase)) log.info('keystore unlocked automatically (KEYSTORE_PASSPHRASE)');
    else log.warn('KEYSTORE_PASSPHRASE does not match this data folder (if it contains # or spaces, put it in single quotes) – log in on the page instead');
  }

  // The same trading stack as the bot.
  const rpc = new RpcClient(config.rpcUrl, config.rpcRps, usage, config.heliusTier === 'free' ? 1 : 5);
  const jupiter = new JupiterClient(config.jupiterApiKey, config.jupiterRps, moduleLogger('jupiter'));
  const tokens = new TokenService(db, rpc, jupiter, moduleLogger('tokens'));
  const accounts = new AccountService(rpc, keystore, moduleLogger('wallets'));
  const prices = new PriceService(jupiter, moduleLogger('prices'));
  const pump = new PumpDirect(rpc.connection);
  const sender = new SenderClient(config.senderUrl, config.heliusApiKey);
  const direct = new DirectExecutor(pump, rpc, sender, keystore, settings);
  accounts.useLanding(config.heliusApiKey ? sender : null, settings);
  const execLog = moduleLogger('exec');
  // Paper trades and buy previews: real quotes (pump.fun curve/pool, else Jupiter), nothing is sent.
  const paperRouting = new ManualRouting(true, direct, new PaperExecutor(jupiter, settings), settings, execLog, rpc);
  const engine = new CopyEngine({
    cfg: config,
    db,
    settings,
    keystore,
    accounts,
    tokens,
    prices,
    live: new ManualRouting(false, direct, new LiveExecutor(jupiter, keystore, rpc, settings), settings, execLog, rpc),
    paper: paperRouting,
    log: moduleLogger('engine'),
  });

  // What the shared views need (trade history). No Telegram here: manual trading sends no messages.
  const ctx = { cfg: config, db, settings, keystore, sessions, accounts, tokens, prices, engine, usage, rpc, jupiter, log } as unknown as AppContext;
  const plans = new SellPlans({ db, cfg: config, engine, keystore, accounts, tokens, prices, market: new MarketReader(rpc), log: moduleLogger('plans') });

  log.info(
    { rpc: redactUrl(config.rpcUrl), dataDir: config.dataDir, liveTrading: config.liveTrading },
    `starting manual trading – LIVE_TRADING=${config.liveTrading ? 'ON' : 'off (paper only)'}`,
  );
  // Positions opened in earlier runs: finish recovering anything that was sent but not booked, then
  // check every live position against the real token balance.
  await engine.recoverPending();
  await engine.reconcile().catch((err) => log.warn({ err: errorMessage(err) }, 'reconcile failed'));
  const recoveryTimer = setInterval(() => void engine.recoverPending().catch((err) => log.error({ err: errorMessage(err) }, 'recovery failed')), 10_000);
  recoveryTimer.unref();
  if (settings.get().directPumpTrades) void pump.loadGlobals().catch((err) => execLog.warn({ err: errorMessage(err) }, 'could not load pump.fun config'));

  // ── web server ───────────────────────────────────────────────────────────
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(cookie);
  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof HttpError ? err.status : ((err as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) log.error({ err: errorMessage(err) }, 'api error');
    reply.status(status).send({ error: errorMessage(err) });
  });
  const userAction = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, errorMessage(err));
    }
  };

  const loggedIn = (req: FastifyRequest) => sessions.valid(req.cookies[SESSION_COOKIE]);
  const startSession = (reply: FastifyReply) => {
    const { token, maxAge } = sessions.create();
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge });
  };
  const PUBLIC = new Set(['/api/manual/session', '/api/manual/setup', '/api/manual/login']);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || PUBLIC.has(req.url.split('?')[0])) return;
    if (!loggedIn(req)) return reply.status(401).send({ error: 'Not logged in' });
  });
  const needKeys = () => {
    if (!keystore.isUnlocked) throw new HttpError(423, 'Wallet keys are locked – log in again');
  };

  // ── session ──────────────────────────────────────────────────────────────
  app.get('/api/manual/session', async (req) => ({
    setup: keystore.isSetup,
    loggedIn: loggedIn(req),
    unlocked: keystore.isUnlocked,
    liveTrading: config.liveTrading,
    minPassphrase: MIN_PASSPHRASE,
    dataDir: path.relative(process.cwd(), config.dataDir).startsWith('..') ? config.dataDir : path.relative(process.cwd(), config.dataDir),
    solUsd: await prices.solUsdFresh(300_000).catch(() => prices.solUsd),
  }));

  app.post('/api/manual/setup', async (req, reply) => {
    const { passphrase } = parse(z.object({ passphrase: z.string().min(MIN_PASSPHRASE) }), req.body);
    if (keystore.isSetup) throw new HttpError(400, 'A passphrase is already set – log in');
    keystore.setup(passphrase);
    startSession(reply);
    return { ok: true };
  });

  app.post('/api/manual/login', async (req, reply) => {
    const { passphrase } = parse(z.object({ passphrase: z.string() }), req.body);
    if (sessions.throttled()) throw new HttpError(429, 'Too many attempts – wait a minute');
    if (!keystore.unlock(passphrase)) {
      sessions.recordFailure();
      throw new HttpError(401, 'Wrong passphrase');
    }
    startSession(reply);
    return { ok: true };
  });

  app.post('/api/manual/logout', async (req, reply) => {
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ── wallets ──────────────────────────────────────────────────────────────
  // Balances are read from the chain only when the page asks (opening it, Refresh, after a trade).
  app.get('/api/manual/wallets', async (req) => {
    const refresh = (req.query as { refresh?: string }).refresh === '1';
    const groups = db.select().from(traderGroups).all();
    const rows = db.select().from(myWallets).where(eq(myWallets.archived, false)).orderBy(myWallets.id).all();
    if (refresh) await Promise.all(rows.map((w) => accounts.solBalance(w.pubkey, 0).catch(() => null)));
    return rows.map((w) => {
      const g = groups.find((x) => x.myWalletId === w.id);
      const cached = accounts.cachedSol(w.pubkey);
      return {
        id: w.id,
        label: w.label,
        pubkey: w.pubkey,
        copyGroup: g ? g.name : null,
        solLamports: cached?.lamports ?? null,
        balanceAt: cached?.at ?? null,
        paperCashLamports: engine.paperCash(g ?? { paperStartSol: 1 }, w.id),
      };
    });
  });

  app.post('/api/manual/wallets/generate', async (req) => {
    needKeys();
    const { label } = parse(z.object({ label: z.string().trim().min(1).max(40) }), req.body);
    const w = keystore.generate(label);
    log.info(`wallet generated: ${w.label} (${w.pubkey})`);
    return { id: w.id, label: w.label, pubkey: w.pubkey };
  });

  app.post('/api/manual/wallets/import', async (req) => {
    needKeys();
    const { label, secret } = parse(z.object({ label: z.string().trim().min(1).max(40), secret: z.string().trim().min(32) }), req.body);
    // A wallet removed earlier is still stored (hidden): bring it back instead of refusing it.
    const pubkey = await userAction(async () => parseSecret(secret).publicKey.toBase58());
    const hidden = db.select().from(myWallets).where(and(eq(myWallets.pubkey, pubkey), eq(myWallets.archived, true))).get();
    if (hidden) {
      db.update(myWallets).set({ archived: false, label }).where(eq(myWallets.id, hidden.id)).run();
      log.info(`wallet restored: ${label} (${pubkey})`);
      return { id: hidden.id, label, pubkey };
    }
    const w = await userAction(async () => keystore.import(label, secret));
    log.info(`wallet imported: ${w.label} (${w.pubkey})`);
    return { id: w.id, label: w.label, pubkey: w.pubkey };
  });

  /**
   * Removes a wallet from this tool. Hidden, not deleted: its encrypted key stays in the data folder,
   * so no funds can be lost, and importing it again brings it back. Nothing changes on-chain.
   */
  app.delete('/api/manual/wallets/:id', async (req) => {
    const id = parse(z.coerce.number().int().positive(), (req.params as { id: string }).id);
    const w = db.select().from(myWallets).where(eq(myWallets.id, id)).get();
    if (!w || w.archived) throw new HttpError(404, 'Wallet not found');
    if (db.select().from(lots).where(and(eq(lots.myWalletId, id), eq(lots.status, 'open'))).get())
      throw new HttpError(400, 'This wallet still has open positions here – sell them first');
    if (db.select().from(traderGroups).where(eq(traderGroups.myWalletId, id)).get())
      throw new HttpError(400, 'A copy-trading group in this data folder uses this wallet');
    db.update(myWallets).set({ archived: true }).where(eq(myWallets.id, id)).run();
    log.info(`wallet removed from manual trading: ${w.label} (${w.pubkey})`);
    return { ok: true };
  });

  app.post('/api/manual/wallets/:id/export', async (req) => {
    needKeys();
    const id = parse(z.coerce.number().int().positive(), (req.params as { id: string }).id);
    const { passphrase } = parse(z.object({ passphrase: z.string() }), req.body);
    if (!keystore.verify(passphrase)) throw new HttpError(401, 'Wrong passphrase');
    return { secret: keystore.exportSecret(id, passphrase) };
  });

  /** Wallets removed from this tool: hidden, their keys still stored (encrypted). */
  app.get('/api/manual/wallets/removed', async () =>
    db.select().from(myWallets).where(eq(myWallets.archived, true)).orderBy(myWallets.id).all().map((w) => ({ id: w.id, label: w.label, pubkey: w.pubkey })),
  );

  /** What a removed wallet still holds, read from the chain when you open "Delete key". */
  app.get('/api/manual/wallets/:id/funds', async (req) => {
    const w = removedWallet((req.params as { id: string }).id);
    return funds(w.pubkey);
  });

  const removedWallet = (param: string) => {
    const id = parse(z.coerce.number().int().positive(), param);
    const w = db.select().from(myWallets).where(eq(myWallets.id, id)).get();
    if (!w) throw new HttpError(404, 'Wallet not found');
    if (!w.archived) throw new HttpError(400, 'Remove the wallet first');
    return w;
  };
  const funds = async (pubkey: string) => {
    const [solLamports, holdings] = await Promise.all([accounts.solBalance(pubkey, 0), accounts.holdings(pubkey, 0)]);
    return { solLamports, tokens: holdings.filter((h) => h.raw > 0n).length, tokenAccounts: holdings.length };
  };

  /**
   * Deletes a removed wallet's key from this laptop for good. The wallet's row goes (its trade history
   * stays), and the database file is rewritten so no old copy of the encrypted key is left in it.
   * Whatever is still in the wallet can then only be moved with a copy of the key saved elsewhere.
   */
  app.post('/api/manual/wallets/:id/delete-key', async (req) => {
    needKeys();
    const { passphrase, acceptLoss } = parse(z.object({ passphrase: z.string(), acceptLoss: z.boolean().default(false) }), req.body);
    const w = removedWallet((req.params as { id: string }).id);
    if (!keystore.verify(passphrase)) throw new HttpError(401, 'Wrong passphrase');
    if (db.select().from(lots).where(and(eq(lots.myWalletId, w.id), eq(lots.status, 'open'))).get()) throw new HttpError(400, 'This wallet still has open positions here');
    if (db.select().from(traderGroups).where(eq(traderGroups.myWalletId, w.id)).get()) throw new HttpError(400, 'A copy-trading group in this data folder uses this wallet');
    if (db.select().from(copyTrades).where(and(eq(copyTrades.myWalletId, w.id), inArray(copyTrades.status, ['pending', 'sent']))).get())
      throw new HttpError(400, 'A trade of this wallet is still being confirmed – try again in a minute');
    const f = await funds(w.pubkey);
    if ((f.solLamports > 0 || f.tokenAccounts > 0) && !acceptLoss)
      throw new HttpError(409, 'This wallet still holds SOL or tokens – export its key first, or confirm you accept losing them');

    const sqlite = (db as typeof db & { $client: Database.Database }).$client; // the SQLite connection under drizzle
    sqlite.pragma('secure_delete = ON'); // deleted bytes are overwritten with zeros, not just marked free
    db.delete(myWallets).where(eq(myWallets.id, w.id)).run();
    keystore.unlock(passphrase); // reloads the keys held in memory – without this one
    // Fold the write-ahead log (which can still hold older copies) into the file, then rebuild the file.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.exec('VACUUM');
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    log.info(`wallet key deleted permanently: ${w.label} (${w.pubkey})`);
    return { ok: true };
  });

  // ── token preview ────────────────────────────────────────────────────────
  app.get('/api/manual/token/:mint', async (req) => {
    const mint = parse(address, (req.params as { mint: string }).mint);
    const t = await userAction(() => tokens.get(mint));
    await prices.refresh([mint], 15_000).catch(() => undefined);
    tokens.ensureMetadata([mint]);
    const priceUsd = prices.priceUsd(mint);
    const warnings: string[] = [];
    if (t.freezeAuthority) warnings.push('has a freeze authority – the creator could freeze your tokens');
    if (t.mintAuthority) warnings.push('more can still be minted');
    if (t.riskyExtensions) warnings.push(`Token-2022: ${t.riskyExtensions}`);
    if (t.transferFeeBps) warnings.push(`transfer fee ${t.transferFeeBps / 100}% on every buy and sell`);
    return {
      mint,
      symbol: tokens.cached(mint)?.symbol ?? t.symbol,
      name: tokens.cached(mint)?.name ?? t.name,
      decimals: t.decimals,
      priceUsd,
      marketCapUsd: marketCapUsd(priceUsd, t),
      direct: settings.get().directPumpTrades,
      warnings,
    };
  });

  // ── positions ────────────────────────────────────────────────────────────
  /** Manual positions: lots opened by hand (no source wallet), one row per wallet + token + mode. */
  const manualOpen = (walletId?: number, mint?: string) =>
    engine.openLots(walletId).filter((l) => l.sourceWalletId === null && (mint === undefined || l.mint === mint));

  app.get('/api/manual/positions', async (req) => {
    const q = req.query as { prices?: string };
    const open = manualOpen();
    const mints = [...new Set(open.map((l) => l.mint))];
    // Prices and on-chain balances are read when the page asks for them (open, Refresh).
    if (q.prices === '1') {
      await prices.refresh(mints, 15_000).catch(() => undefined);
      tokens.ensureMetadata(mints);
    }
    const wallets = new Map(db.select().from(myWallets).all().map((w) => [w.id, w]));
    const byKey = new Map<string, Lot[]>();
    for (const l of open) byKey.set(`${l.myWalletId}:${l.mint}:${l.paper}`, [...(byKey.get(`${l.myWalletId}:${l.mint}:${l.paper}`) ?? []), l]);
    const solUsd = prices.solUsd;
    const rows = await Promise.all(
      [...byKey.values()].map(async (group) => {
        const first = group[0];
        const w = wallets.get(first.myWalletId);
        const t = tokens.cached(first.mint);
        const decimals = first.tokenDecimals;
        const recorded = group.reduce((s, l) => s + BigInt(l.tokenAmount), 0n);
        const onChain = !first.paper && w && q.prices === '1' ? await accounts.tokenBalance(w.pubkey, first.mint, PRIORITY.normal).catch(() => null) : null;
        const held = onChain ?? recorded;
        const lastFill = Math.max(...group.map((l) => l.lastPriceSol ?? 0)) || null;
        const priceSol = prices.priceSol(first.mint) ?? lastFill;
        const value = priceSol != null ? Math.round((Number(held) / 10 ** decimals) * priceSol * LAMPORTS) : null;
        const cost = group.reduce((s, l) => s + l.costLamports, 0);
        const invested = group.reduce((s, l) => s + l.totalCostLamports, 0);
        const realized = group.reduce((s, l) => s + l.realizedLamports, 0);
        const entryMc = invested > 0 && group.every((l) => l.entryMcUsd != null) ? group.reduce((s, l) => s + (l.entryMcUsd ?? 0) * l.totalCostLamports, 0) / invested : first.entryMcUsd;
        const otherLots = engine.openLots(first.myWalletId, first.paper).some((l) => l.mint === first.mint && l.sourceWalletId !== null);
        const plan = plans.current(first.myWalletId, first.mint, first.paper);
        return {
          key: `${first.myWalletId}:${first.mint}:${first.paper}`,
          wallet: w ? { id: w.id, label: w.label, pubkey: w.pubkey } : null,
          paper: first.paper,
          token: { mint: first.mint, symbol: t?.symbol ?? null, name: t?.name ?? null, icon: null, decimals },
          recordedTokens: recorded.toString(),
          onChainTokens: onChain?.toString() ?? null,
          heldTokens: held.toString(),
          costLamports: cost,
          valueLamports: value,
          pnlLamports: value != null ? value - cost : null,
          realizedLamports: realized,
          priceUsd: priceSol != null && solUsd ? priceSol * solUsd : null,
          priceStale: prices.priceSol(first.mint) == null,
          entryMcUsd: entryMc,
          currentMcUsd: priceSol != null && solUsd ? marketCapUsd(priceSol * solUsd, t) : null,
          openedAt: Math.min(...group.map((l) => l.openedAt)),
          otherLots,
          plan: plan ? { id: plan.id, status: plan.status } : null,
        };
      }),
    );
    return rows.sort((a, b) => b.openedAt - a.openedAt);
  });

  app.get('/api/manual/closed', async () => {
    const rows = db
      .select()
      .from(lots)
      .where(and(eq(lots.status, 'closed'), isNull(lots.sourceWalletId)))
      .orderBy(desc(lots.closedAt))
      .limit(100)
      .all();
    const wallets = new Map(db.select().from(myWallets).all().map((w) => [w.id, w]));
    return rows.map((l) => {
      const t = tokens.cached(l.mint);
      const w = wallets.get(l.myWalletId);
      return {
        id: l.id,
        wallet: w ? { id: w.id, label: w.label } : null,
        paper: l.paper,
        token: { mint: l.mint, symbol: t?.symbol ?? null, name: t?.name ?? null, icon: null, decimals: l.tokenDecimals },
        investedLamports: l.totalCostLamports,
        proceedsLamports: l.proceedsLamports,
        realizedLamports: l.realizedLamports,
        entryMcUsd: l.entryMcUsd,
        exitMcUsd: l.exitMcUsd,
        openedAt: l.openedAt,
        closedAt: l.closedAt,
        note: l.note,
      };
    });
  });

  app.get('/api/manual/trades', async () => {
    const rows = db.select().from(copyTrades).where(eq(copyTrades.manual, true)).orderBy(desc(copyTrades.id)).limit(100).all();
    return enrichTrades(ctx, rows);
  });

  // ── trading ──────────────────────────────────────────────────────────────
  /**
   * What a buy of `usd` would get right now: a real quote on the route the buy would take, without
   * sending anything. Asked by the page while you type an amount (after a short pause).
   */
  app.get('/api/manual/quote', async (req) => {
    const q = parse(z.object({ walletId: z.coerce.number().int(), mint: address, usd: z.coerce.number().positive().max(100_000) }), req.query);
    const wallet = db.select().from(myWallets).where(eq(myWallets.id, q.walletId)).get();
    if (!wallet) throw new HttpError(404, 'Wallet not found');
    const solUsd = await prices.solUsdFresh(60_000);
    if (!solUsd) throw new HttpError(503, 'SOL price unavailable – try again in a moment');
    const t = await userAction(() => tokens.get(q.mint));
    const fill = await userAction(() =>
      paperRouting.swap({
        wallet: wallet.pubkey,
        inputMint: WSOL_MINT,
        outputMint: q.mint,
        amount: BigInt(Math.round((q.usd / solUsd) * LAMPORTS)),
        slippageBps: null,
        tokenProgram: t.tokenProgram,
      }),
    );
    const supply = BigInt(t.supply);
    return { tokens: fill.outAmount.toString(), supplyPct: supply > 0n ? (Number(fill.outAmount) / Number(supply)) * 100 : null, route: fill.route };
  });

  app.post('/api/manual/buy', async (req) => {
    const b = parse(z.object({ walletId: z.number().int(), mint: address, usd: z.number().positive().max(100_000), paper: z.boolean().default(false) }), req.body);
    if (!b.paper) needKeys();
    const solUsd = await prices.solUsdFresh(60_000);
    if (!solUsd) throw new HttpError(503, 'SOL price unavailable – try again in a moment');
    const sol = b.usd / solUsd;
    log.info(`manual ${b.paper ? 'paper ' : ''}buy $${b.usd} (${sol.toFixed(4)} SOL) of ${b.mint}`);
    await userAction(() => engine.manualBuy(b.walletId, b.mint, sol, b.paper));
    accounts.invalidate(db.select().from(myWallets).where(eq(myWallets.id, b.walletId)).get()?.pubkey ?? '');
    return latestTrade(b.walletId, b.mint);
  });

  /**
   * Sells `pct`% of the tokens actually in the wallet (read from the chain right before). If what
   * would be left is worth less than `minLeftUsd`, it sells everything instead.
   */
  app.post('/api/manual/sell', async (req) => {
    const b = parse(
      z.object({
        walletId: z.number().int(),
        mint: address,
        pct: z.number().gt(0).max(100),
        minLeftUsd: z.number().min(0).default(0),
        paper: z.boolean().default(false),
      }),
      req.body,
    );
    if (!b.paper) needKeys();
    const wallet = db.select().from(myWallets).where(eq(myWallets.id, b.walletId)).get();
    if (!wallet) throw new HttpError(404, 'Wallet not found');
    const all = engine.openLots(b.walletId, b.paper).filter((l) => l.mint === b.mint);
    const mine = all.filter((l) => l.sourceWalletId === null);
    if (!mine.length) throw new HttpError(400, 'No manual position in this token on this wallet');
    if (mine.length !== all.length)
      throw new HttpError(400, 'This wallet also holds this token from copy trading – sell it from the main app so the copied position is not mixed in');

    const recorded = all.reduce((s, l) => s + BigInt(l.tokenAmount), 0n);
    // How many tokens are really there, right now.
    const held = b.paper ? recorded : await accounts.tokenBalance(wallet.pubkey, b.mint);
    if (held === 0n) {
      // Let the engine mark it closed (sold or moved outside this tool).
      await userAction(() => engine.manualSell(b.walletId, b.mint, 1, b.paper));
      throw new HttpError(400, 'No tokens left in the wallet – the position was marked closed');
    }
    let sell = b.pct >= 100 ? held : mulFraction(held, b.pct / 100);
    // Dust rule: a leftover worth less than the minimum is sold too.
    await prices.refresh([b.mint], 15_000).catch(() => undefined);
    const t = tokens.cached(b.mint);
    const decimals = t?.decimals ?? all[0].tokenDecimals;
    const lastFill = Math.max(...all.map((l) => l.lastPriceSol ?? 0)) || null;
    const priceUsd = prices.priceUsd(b.mint) ?? (lastFill && prices.solUsd ? lastFill * prices.solUsd : null);
    const leftUsd = priceUsd != null ? (Number(held - sell) / 10 ** decimals) * priceUsd : null;
    let allOut = sell >= held;
    if (!allOut && b.minLeftUsd > 0 && leftUsd != null && leftUsd < b.minLeftUsd) {
      sell = held;
      allOut = true;
    }
    // The engine sells a share of the recorded position and never more than is on-chain.
    const share = allOut ? 1 : Math.min(Number(sell) / Number(recorded), 0.999999);
    log.info(
      `manual ${b.paper ? 'paper ' : ''}sell ${allOut ? '100%' : `${b.pct}%`} of ${t?.symbol ?? b.mint} on ${wallet.label}: ${held} held` +
        `${allOut && b.pct < 100 ? ` (leftover $${leftUsd?.toFixed(2)} < $${b.minLeftUsd} – selling all)` : ''}`,
    );
    await userAction(() => engine.manualSell(b.walletId, b.mint, share, b.paper));
    accounts.invalidate(wallet.pubkey);
    return { trade: latestTrade(b.walletId, b.mint), soldAll: allOut, heldBefore: held.toString(), leftUsd };
  });

  const latestTrade = (walletId: number, mint: string) => {
    const row = db
      .select()
      .from(copyTrades)
      .where(and(eq(copyTrades.myWalletId, walletId), eq(copyTrades.mint, mint), eq(copyTrades.manual, true)))
      .orderBy(desc(copyTrades.id))
      .get();
    return row ? enrichTrades(ctx, [row])[0] : null;
  };

  // ── sell plans ───────────────────────────────────────────────────────────
  const planSettings = z.object({
    levels: z
      .array(z.object({ id: z.number().int().min(0).optional(), mcUsd: z.number().positive().max(1e12), pct: z.number().gt(0).max(100) }))
      .min(1)
      .max(12),
    participationPct: z.number().min(1).max(100),
    maxImpactPct: z.number().min(0.1).max(10),
    minSellUsd: z.number().min(0).max(100_000),
    slippagePct: z.number().min(0.5).max(25),
    stopDropPct: z.number().min(5).max(95).nullable(),
  });

  app.get('/api/manual/plans', async () => plans.list());

  app.post('/api/manual/plans', async (req) => {
    const b = parse(planSettings.extend({ walletId: z.number().int(), mint: address, paper: z.boolean().default(false) }), req.body);
    if (!b.paper) needKeys();
    if (!b.paper && !config.liveTrading) throw new HttpError(400, 'Live trading is off (LIVE_TRADING=false) – make it a paper plan');
    const { walletId, mint, paper, ...s } = b;
    return { id: await userAction(() => plans.create(walletId, mint, paper, s)) };
  });

  app.post('/api/manual/plans/:id/edit', async (req) => {
    const id = parse(z.coerce.number().int().positive(), (req.params as { id: string }).id);
    await userAction(() => plans.edit(id, parse(planSettings, req.body)));
    return { ok: true };
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/manual/plans/:id/${action}`, async (req) => {
      const id = parse(z.coerce.number().int().positive(), (req.params as { id: string }).id);
      await userAction(async () => plans[action](id));
      return { ok: true };
    });
  }

  // ── page ─────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.addHook('onSend', async (req, reply, payload) => {
      if (!req.url.startsWith('/api/')) reply.header('cache-control', 'no-cache');
      return payload;
    });
  } else {
    log.warn(`no page built at ${WEB_DIST} – run manual/run.sh`);
  }

  await app.listen({ host: HOST, port: PORT });
  log.info(`manual trading ready at http://${HOST}:${PORT}`);
  plans.start();
  if (!keystore.isSetup) log.info('first run: open the page to create a passphrase for this data folder');
  else if (!keystore.isUnlocked) log.info('wallet keys are locked – log in on the page');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received – finishing trades in progress, then stopping`);
    clearInterval(recoveryTimer);
    plans.stop();
    if (engine.busy) await Promise.race([engine.idle(), sleep(20_000)]);
    usage.flush();
    await app.close().catch(() => undefined);
    closeDb();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err: errorMessage(err) }, 'unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err: errorMessage(err), stack: (err as Error).stack }, 'manual trading failed to start');
  process.exit(1);
});
