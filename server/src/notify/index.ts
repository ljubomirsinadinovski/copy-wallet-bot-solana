import { and, eq } from 'drizzle-orm';
import { enrichTrades } from '../api/views.js';
import type { AppContext } from '../context.js';
import { lots, myWallets, traderGroups, type CopyTrade } from '../db/schema.js';
import { bus, type BusEvent } from '../events.js';
import { logEvents, type LogEntry } from '../logger.js';
import { PRIORITY } from '../solana/rpc.js';
import { errorMessage } from '../util/misc.js';
import { esc, type TelegramNotifier } from './telegram.js';

const ROUTE: Record<string, string> = { pumpfun: 'pump.fun direct', pumpswap: 'PumpSwap direct', jupiter: 'Jupiter' };

const money = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${a.toFixed(2)}`;
};
const secs = (ms: number | null | undefined) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * Telegram messages for everything that happens on your wallets, plus alerts that tell you when
 * copying isn't working (connection lost, keys locked, daily loss limit, tokens moved away).
 */
export function startNotifications(ctx: AppContext, tg: TelegramNotifier) {
  const sent = new Set<string>();

  bus.on('event', (e: BusEvent) => {
    if (!tg.configured) return;
    if (e.type === 'alert' && ctx.settings.get().telegramHealth) tg.send(e.text);
    if (e.type !== 'trade') return;
    const t = e.trade;
    const s = ctx.settings.get();
    if (t.status === 'skipped' ? !s.telegramSkips : t.status === 'confirmed' || t.status === 'failed' ? !s.telegramTrades : true) return;
    const key = `${t.id}:${t.status}`;
    if (sent.has(key)) return;
    sent.add(key);
    void tradeMessage(ctx, t)
      .then((html) => tg.send(html))
      .catch((err) => ctx.log.warn({ err: errorMessage(err) }, 'could not build telegram message'));
  });

  // Any other problem: every error the bot logs, plus warnings that mean copying may be affected.
  // The same problem is reported at most once per 10 minutes.
  const IMPORTANT_WARNING =
    /transaction outcome unknown|manual reconciliation required|not found after retries|lookup failed|could not read .*balances|couldn't reclaim the rent|gone on-chain|reduced to match|backfill failed|reconcile failed|could not load pump\.fun config|price refresh failed|subscribe failed/i;
  const lastSent = new Map<string, number>();
  logEvents.on('log', (e: LogEntry) => {
    if (!tg.configured || !ctx.settings.get().telegramHealth || e.module === 'telegram') return;
    const isError = e.level === 'error' || e.level === 'fatal';
    if (!isError && !(e.level === 'warn' && IMPORTANT_WARNING.test(e.msg))) return;
    // Failed trades already get their own message.
    if (/(BUY|SELL) FAILED/.test(e.msg)) return;
    const key = `${e.module}:${e.msg.replace(/\d+/g, '#').slice(0, 120)}`;
    if (Date.now() - (lastSent.get(key) ?? 0) < 10 * 60_000) return;
    lastSent.set(key, Date.now());
    const detail = e.extra?.err ? `\n<code>${esc(String(e.extra.err).slice(0, 400))}</code>` : '';
    tg.send(`${isError ? '🚨 <b>Problem</b>' : '⚠️ <b>Warning</b>'} (${esc(e.module ?? 'bot')}): ${esc(e.msg.slice(0, 400))}${detail}`);
  });

  // Connection watchdog: alert when wallets haven't been watched for a minute.
  let downSince: number | null = null;
  let alerted = false;
  ctx.stream.on('status', () => {
    const st = ctx.stream.status();
    if (st.kind === 'disabled' || !tg.configured || !ctx.settings.get().telegramHealth) return;
    if (!st.connected) {
      if (downSince != null) return;
      downSince = Date.now();
      setTimeout(() => {
        if (downSince != null && !ctx.stream.status().connected && !alerted) {
          alerted = true;
          tg.send(
            `⚠️ <b>Not watching wallets</b> – the connection to Helius has been down for 1 min. Reconnecting automatically; ` +
              `trades made meanwhile are recorded but not copied if older than ${ctx.settings.get().maxSignalAgeSec}s.` +
              (st.error ? `\nLast error: <code>${esc(st.error)}</code>` : ''),
          );
        }
      }, 60_000).unref();
    } else {
      if (alerted && downSince != null) tg.send(`✅ <b>Watching wallets again</b> (connection was down ${secs(Date.now() - downSince)}).`);
      downSince = null;
      alerted = false;
    }
  });

  // `pnpm dev` restarts the bot on every file save (SIGTERM from tsx watch). Those restarts are
  // silent; real stops (Ctrl+C, Docker) and starts are reported.
  const devMode = process.env.npm_lifecycle_event?.startsWith('dev') === true;
  const lastStop = ctx.settings.getJson<{ at: number; devRestart: boolean }>('telegram:lastStop');
  const quietStart = Boolean(lastStop?.devRestart && Date.now() - lastStop.at < 60_000);

  return {
    startup(watchedCount: number) {
      if (!tg.configured || !ctx.settings.get().telegramHealth || quietStart) return;
      const groups = ctx.db.select().from(traderGroups).all();
      const live = groups.filter((g) => !g.paper).length;
      const lines = [
        '🤖 <b>Copy bot started</b>',
        `Trading: ${ctx.cfg.liveTrading ? '<b>LIVE enabled</b>' : 'paper only (LIVE_TRADING is off)'}`,
        `Watching ${watchedCount} wallet${watchedCount === 1 ? '' : 's'} in ${groups.length} trader group${groups.length === 1 ? '' : 's'} (${live} live, ${groups.length - live} paper)`,
        `Monitoring: Helius ${ctx.cfg.heliusTier}${ctx.cfg.heliusApiKey ? '' : ' – ⚠️ no HELIUS_API_KEY, nothing is watched'}`,
      ];
      if (ctx.cfg.liveTrading && live > 0 && !ctx.keystore.isUnlocked)
        lines.push('⚠️ <b>Wallet keys are locked</b> – live groups can’t trade until you log in on the web page (or set KEYSTORE_PASSPHRASE).');
      if (ctx.settings.get().paused) lines.push(`⏸ Trading is paused${ctx.settings.get().pausedReason ? ` (${esc(ctx.settings.get().pausedReason!)})` : ''}.`);
      tg.send(lines.join('\n'));
    },
    async shutdown(reason: string, signal: string) {
      const devRestart = devMode && signal === 'SIGTERM';
      ctx.settings.setJson('telegram:lastStop', { at: Date.now(), devRestart });
      if (!tg.configured || !ctx.settings.get().telegramHealth || devRestart) return;
      await tg.sendNow(`🛑 <b>Copy bot stopped</b> (${esc(reason)}). Nothing is copied until it starts again.`, 3000).catch(() => undefined);
    },
  };
}

/** One message per trade: who was copied, your trade vs theirs, speed, and the result. */
export async function tradeMessage(ctx: AppContext, row: CopyTrade): Promise<string> {
  const [t] = enrichTrades(ctx, [row]);
  const solUsd = t.solUsd ?? ctx.prices.solUsd;
  const usd = (lamports: number | null | undefined) => (lamports == null || !solUsd ? null : (lamports / 1e9) * solUsd);
  const side = t.side.toUpperCase();
  const mode = t.paper ? '📝 paper' : '💰 LIVE';
  const symbol = esc(t.token.symbol ?? short(t.mint));
  const who = t.manual
    ? 'manual trade'
    : `copied <b>${esc(t.group?.name ?? '?')}</b>${t.source ? ` · ${esc(t.source.label.length > 20 ? short(t.source.label) : t.source.label)}${t.source.role !== 'main' ? ` (${t.source.role})` : ''}` : ''}`;
  const tokenLine = `<b>${symbol}</b> · <code>${t.mint}</code>`;
  const them = t.trader
    ? t.side === 'buy'
      ? `Them: ${money(t.trader.spentUsd)} at MC ${money(t.trader.marketCapUsd)}`
      : `Them: ${t.trader.side === 'transfer_out' ? 'transferred' : 'sold'} ${t.trader.pct >= 0.995 ? 'all' : `${(t.trader.pct * 100).toFixed(0)}%`}${t.trader.spentUsd != null ? ` for ${money(t.trader.spentUsd)}` : ''} at MC ${money(t.trader.marketCapUsd)}`
    : null;
  const links = [
    t.signature && !t.paper ? `<a href="https://solscan.io/tx/${t.signature}">your tx</a>` : null,
    t.trader?.signature ? `<a href="https://solscan.io/tx/${t.trader.signature}">their tx</a>` : null,
    `<a href="https://dexscreener.com/solana/${t.mint}">chart</a>`,
  ]
    .filter(Boolean)
    .join(' · ');

  if (t.status === 'skipped') {
    return [`⏭ Skipped ${side} · ${mode} · ${who}`, tokenLine, them, `Reason: ${esc(t.skipReason ?? 'unknown')}`, links].filter(Boolean).join('\n');
  }
  if (t.status === 'failed') {
    return [
      `⚠️ <b>${side} FAILED</b> · ${mode} · ${who}`,
      tokenLine,
      t.side === 'buy' ? `Tried: ${money(usd(t.solLamports))}` : `Tried to sell ${t.pct != null ? `${(t.pct * 100).toFixed(0)}%` : 'the position'}`,
      them,
      `Error: <code>${esc((t.error ?? 'unknown').slice(0, 300))}</code>${t.attempts > 1 ? ` (after ${t.attempts} attempts)` : ''}`,
      t.side === 'sell' ? 'Your position is still open – sell it manually if needed.' : null,
      links,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // Confirmed
  const gap =
    t.marketCapUsd && t.trader?.marketCapUsd
      ? t.side === 'buy'
        ? (t.marketCapUsd - t.trader.marketCapUsd) / t.trader.marketCapUsd
        : (t.trader.marketCapUsd - t.marketCapUsd) / t.trader.marketCapUsd
      : null;
  const gapText =
    gap == null
      ? ''
      : t.side === 'buy'
        ? ` → you entered ${Math.abs(gap * 100).toFixed(0)}% ${gap >= 0 ? 'higher' : 'lower'}`
        : ` → you exited ${Math.abs(gap * 100).toFixed(0)}% ${gap >= 0 ? 'lower' : 'higher'}`;
  const you =
    t.side === 'buy'
      ? `You: <b>${money(usd(t.solLamports))}</b> at MC ${money(t.marketCapUsd)}`
      : `You: received <b>${money(usd(t.solLamports))}</b> at MC ${money(t.marketCapUsd)}${pnlText(t.realizedLamports, t.solLamports, t.feeLamports, usd)}`;
  const speed = [
    t.detectLagMs != null ? `seen ${secs(t.detectLagMs)} after their trade` : null,
    t.reactionMs != null ? `sent ${secs(t.reactionMs)} later` : null,
    t.confirmedAt && t.sentAt ? `landed in ${secs(t.confirmedAt - t.sentAt)}` : null,
    t.route ? `via ${ROUTE[t.route.replace(/^paper:/, '')] ?? t.route}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const after = await afterTrade(ctx, t.wallet?.id, t.mint, t.paper, symbol, usd);
  return [
    `${t.side === 'buy' ? '🟢' : '🔴'} <b>${side}${t.side === 'sell' && t.pct != null ? ` ${t.pct >= 0.995 ? 'ALL' : `${(t.pct * 100).toFixed(0)}%`}` : ''}</b> · ${mode} · ${who}`,
    tokenLine,
    you,
    them ? `${them}${gapText}` : null,
    `Speed: ${speed || '—'}`,
    `Fees: ${money(usd(t.feeLamports))}${t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}${t.skipReason ? ` · ${esc(t.skipReason)}` : ''}`,
    after,
    links,
  ]
    .filter(Boolean)
    .join('\n');
}

function pnlText(realized: number | null, received: number | null, fee: number | null, usd: (l: number | null) => number | null) {
  if (realized == null || received == null) return '';
  const cost = received - (fee ?? 0) - realized;
  const pct = cost > 0 ? (realized / cost) * 100 : null;
  return ` · profit <b>${realized >= 0 ? '+' : ''}${money(usd(realized))}${pct != null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''}</b>`;
}

/** "Position: $X in TOKEN · Wallet: $Y" after the trade. */
async function afterTrade(
  ctx: AppContext,
  walletId: number | undefined,
  mint: string,
  paper: boolean,
  symbol: string,
  usd: (l: number | null) => number | null,
): Promise<string | null> {
  if (!walletId) return null;
  const open = ctx.db
    .select()
    .from(lots)
    .where(and(eq(lots.myWalletId, walletId), eq(lots.mint, mint), eq(lots.paper, paper), eq(lots.status, 'open')))
    .all();
  const cost = open.reduce((s, l) => s + l.costLamports, 0);
  const position = open.length ? `Position: ${money(usd(cost))} in ${symbol}` : `Position in ${symbol} closed`;
  const wallet = ctx.db.select().from(myWallets).where(eq(myWallets.id, walletId)).get();
  const group = ctx.db.select().from(traderGroups).where(eq(traderGroups.myWalletId, walletId)).get();
  let balance: number | null = null;
  if (paper && group) balance = ctx.engine.paperCash(group, walletId);
  else if (wallet) balance = await ctx.accounts.solBalance(wallet.pubkey, 0, PRIORITY.background).catch(() => null);
  return `${position} · Wallet: ${money(usd(balance))}${paper ? ' (paper)' : ''}`;
}
