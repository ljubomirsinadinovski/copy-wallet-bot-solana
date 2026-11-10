import { startApi } from './api/server.js';
import { Sessions } from './auth.js';
import { config, redactUrl } from './config.js';
import type { AppContext } from './context.js';
import { openDb } from './db/client.js';
import { CopyEngine } from './engine/copyEngine.js';
import { publish } from './events.js';
import { DirectExecutor, LiveExecutor, PaperExecutor, RoutingExecutor } from './executor/executors.js';
import { PumpDirect } from './executor/pump.js';
import { Keystore } from './keystore/keystore.js';
import { acquireLock } from './lock.js';
import { enableFileLogging, logger, moduleLogger } from './logger.js';
import { PriceService } from './prices/priceService.js';
import { SettingsStore } from './settings.js';
import { AccountService } from './solana/accounts.js';
import { JupiterClient } from './solana/jupiter.js';
import { RpcClient } from './solana/rpc.js';
import { SenderClient } from './solana/sender.js';
import { TokenService } from './solana/tokens.js';
import { createStream } from './stream/index.js';
import { catchUp } from './stream/catchup.js';
import type { StreamTx } from './stream/types.js';
import { signals } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { startNotifications } from './notify/index.js';
import { TelegramNotifier } from './notify/telegram.js';
import { errorMessage, sleep } from './util/misc.js';
import { UsageTracker } from './util/usage.js';

async function main() {
  const log = moduleLogger('app');
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
    else log.error('KEYSTORE_PASSPHRASE in .env is wrong – unlock from the web page instead');
  }

  const rpc = new RpcClient(config.rpcUrl, config.rpcRps, usage, config.heliusTier === 'free' ? 1 : 5);
  const jupiter = new JupiterClient(config.jupiterApiKey, config.jupiterRps, moduleLogger('jupiter'));
  const tokens = new TokenService(db, rpc, jupiter, moduleLogger('tokens'));
  const accounts = new AccountService(rpc, keystore, moduleLogger('wallets'));
  let engine: CopyEngine;
  const prices = new PriceService(jupiter, moduleLogger('prices'));
  // pump.fun / PumpSwap tokens are traded directly via Helius Sender; everything else via Jupiter.
  const pump = new PumpDirect(rpc.connection);
  const sender = new SenderClient(config.senderUrl, config.heliusApiKey);
  const direct = new DirectExecutor(pump, rpc, sender, keystore, settings);
  accounts.useLanding(config.heliusApiKey ? sender : null, settings);
  const execLog = moduleLogger('exec');
  engine = new CopyEngine({
    cfg: config,
    db,
    settings,
    keystore,
    accounts,
    tokens,
    prices,
    live: new RoutingExecutor(false, direct, new LiveExecutor(jupiter, keystore, rpc, settings), settings, execLog, rpc),
    paper: new RoutingExecutor(true, direct, new PaperExecutor(jupiter, settings), settings, execLog, rpc),
    log: moduleLogger('engine'),
  });
  const stream = createStream(config, rpc, settings, usage, moduleLogger('stream'));

  const refreshSubscriptions = () => {
    stream.setWallets(engine.reloadWatched());
  };

  // Transactions being processed right now – a restart waits for them (see shutdown).
  const inflight = new Set<Promise<void>>();
  let accepting = true;
  const handleTx = (st: StreamTx) => {
    if (!accepting) return;
    const p: Promise<void> = engine
      .onTx(st)
      .catch((err) => logger.error({ err: errorMessage(err) }, 'failed to process transaction'))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };
  stream.on('tx', handleTx);
  stream.on('status', () => publish({ type: 'status' }));

  const telegram = new TelegramNotifier(config.telegramBotToken, config.telegramChatId, moduleLogger('telegram'));
  const ctx: AppContext = { cfg: config, db, settings, keystore, sessions, accounts, tokens, prices, engine, stream, usage, rpc, jupiter, log, telegram, refreshSubscriptions };
  const notifications = startNotifications(ctx, telegram);

  log.info(
    {
      rpc: redactUrl(config.rpcUrl),
      tier: config.heliusTier,
      liveTrading: config.liveTrading,
      dataDir: config.dataDir,
    },
    `starting copy-wallet – LIVE_TRADING=${config.liveTrading ? 'ON' : 'off (paper only)'}`,
  );

  // Recover submitted swaps before reconciliation or new signals can alter their positions.
  await engine.recoverPending();
  await engine.reconcile().catch((err) => log.warn({ err: errorMessage(err) }, 'reconcile failed'));
  const recoveryTimer = setInterval(() => { void engine.recoverPending().catch((err) => log.error({ err: errorMessage(err) }, 'recovery failed')); }, 10_000);
  recoveryTimer.unref();
  stream.start();
  refreshSubscriptions();
  // Copy anything the watched wallets did while the bot was restarting (e.g. during a deploy).
  if (config.wsUrl) {
    void catchUp({
      rpc,
      addresses: engine.reloadWatched(),
      maxAgeSec: settings.get().maxSignalAgeSec,
      alreadySeen: (sig) => Boolean(db.select({ id: signals.id }).from(signals).where(eq(signals.signature, sig)).get()),
      emit: handleTx,
      log: moduleLogger('stream'),
    });
  }
  notifications.startup(engine.reloadWatched().length);
  // Load pump.fun's config now so the first direct trade doesn't wait for it.
  if (settings.get().directPumpTrades) void pump.loadGlobals().catch((err) => execLog.warn({ err: errorMessage(err) }, 'could not load pump.fun config'));

  const api = await startApi(ctx);
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  log.info(`web UI ready at ${url}${process.env.npm_lifecycle_event === 'dev' ? ' (dev UI: http://127.0.0.1:5173)' : ''}`);
  if (!keystore.isSetup) log.info('first run: open the web UI to create your passphrase');
  else if (!keystore.isUnlocked) log.info('keystore is locked – log in on the web UI to enable live trading');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    // Safe restart: take no new trades, let copies already underway finish (max 20 s).
    accepting = false;
    clearInterval(recoveryTimer);
    stream.stop();
    if (inflight.size || engine.busy) {
      log.info(`waiting for ${inflight.size + engine.busy} copy(ies) in progress to finish before stopping`);
      const done = Promise.allSettled([...inflight]).then(() => engine.idle());
      const finished = await Promise.race([done.then(() => true), sleep(20_000).then(() => false)]);
      log.info(finished ? 'all copies finished' : 'gave up waiting after 20 s – stopping anyway');
    }
    usage.flush();
    await notifications.shutdown(signal === 'SIGINT' ? 'stopped from the terminal' : signal === 'SIGTERM' ? 'restart or shutdown' : signal, signal);
    await api.close().catch(() => undefined);
    closeDb();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err: errorMessage(err) }, 'unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err: errorMessage(err), stack: (err as Error).stack }, 'startup failed');
  process.exit(1);
});
