import { useEffect, useRef } from 'react';
import type { SignalRow, Trade, TokenRef } from '../lib/api';
import { clock, duration, links, mc, pct, short, sol, usd } from '../lib/format';
import { cx, ExtLink, VenueTag } from './ui';

interface TapeRow {
  key: string;
  time: number;
  them: {
    side: string;
    pct: number | null;
    basisUsd?: number | null;
    spentUsd?: number | null;
    mc: number | null;
    label: string;
    role: string | null;
    group: string | null;
    signature: string | null;
    fullExit?: boolean;
    venue?: string | null;
  } | null;
  token: TokenRef;
  you: Trade | null;
  /** Why there is no copy (signal without trade). */
  notCopied?: string;
}

function buildRows(trades: Trade[], signals: SignalRow[]): TapeRow[] {
  const copied = new Set(trades.map((t) => t.signalId).filter(Boolean));
  const rows: TapeRow[] = trades.map((t) => ({
    key: `t${t.id}`,
    time: t.trader?.detectedAt ?? t.createdAt,
    token: t.token,
    you: t,
    them: t.trader
      ? {
          side: t.trader.side,
          pct: t.trader.pct,
          basisUsd: t.side === 'buy' ? t.trader.basisUsd : null,
          spentUsd: t.trader.spentUsd,
          mc: t.trader.marketCapUsd,
          label: t.source?.label ? (t.source.label.length > 20 ? short(t.source.label) : t.source.label) : 'trader',
          role: t.source?.role ?? null,
          group: t.group?.name ?? null,
          signature: t.trader.signature,
          venue: t.trader.venue,
        }
      : null,
  }));
  for (const s of signals) {
    if (copied.has(s.id)) continue;
    rows.push({
      key: `s${s.id}`,
      time: s.detectedAt,
      token: s.token,
      you: null,
      them: {
        side: s.side,
        pct: s.side === 'buy' || s.side === 'sell' ? s.pct : null,
        basisUsd: s.side === 'buy' ? s.basisUsd : null,
        spentUsd: s.spentUsd,
        mc: s.marketCapUsd,
        label: s.wallet?.label ? (s.wallet.label.length > 20 ? short(s.wallet.label) : s.wallet.label) : short(s.address),
        role: s.wallet?.role ?? null,
        group: s.group?.name ?? null,
        signature: s.signature,
        fullExit: s.fullExit,
        venue: s.venue,
      },
      notCopied: s.side === 'transfer_in' ? 'received – no buy' : s.side === 'transfer_out' ? 'no copied exit' : s.side === 'sell' ? 'no copied position' : s.note ?? 'not copied',
    });
  }
  return rows.sort((a, b) => b.time - a.time);
}

const SIDE_LABEL: Record<string, string> = { buy: 'buy', sell: 'sell', transfer_in: 'recv', transfer_out: 'send' };

/** How much worse your fill's market cap is than the trader's (buys: higher is worse; sells: lower is worse). */
function slip(t: Trade): number | null {
  const a = t.trader?.marketCapUsd;
  const b = t.marketCapUsd;
  if (!a || !b || t.status !== 'confirmed') return null;
  return t.side === 'buy' ? (b - a) / a : (a - b) / a;
}

function DelayLink({ trade, notCopied }: { trade: Trade | null; notCopied?: string }) {
  const status = trade?.status;
  const ms = trade?.reactionMs ?? null;
  const done = status === 'confirmed' || status === 'pending' || status === 'sent';
  // Bar length grows with the reaction delay (log scale, 0.2 s → 10 s): a short bar is a fast copy.
  const w = done && ms != null ? Math.min(100, Math.max(22, 22 + (Math.log10(Math.max(ms, 200) / 200) / Math.log10(50)) * 78)) : 100;
  return (
    <div className="tape-link flex w-full items-center gap-2" aria-hidden>
      <div className="flex h-3 flex-1 items-center">
        {done ? (
          <div className="h-[3px] rounded-full bg-gradient-to-r from-them to-you" style={{ width: `${w}%` }} />
        ) : (
          <div className={cx('w-full border-t-2 border-dotted', status === 'failed' ? 'border-loss/70' : 'border-faint')} />
        )}
      </div>
      <span className={cx('num w-12 shrink-0 text-right text-[10.5px]', status === 'failed' ? 'text-loss' : 'text-muted')}>
        {status === 'pending' ? 'sending…' : status === 'sent' ? 'checking…' : status === 'confirmed' && ms != null ? duration(ms) : status === 'failed' ? 'failed' : status === 'skipped' || notCopied ? 'skip' : ''}
      </span>
    </div>
  );
}

export function MirrorTape({ trades, signals, limit = 40 }: { trades: Trade[]; signals: SignalRow[]; limit?: number }) {
  const rows = buildRows(trades, signals).slice(0, limit);
  const seen = useRef<Set<string> | null>(null);
  const firstRender = seen.current === null;
  const isNew = (k: string) => !firstRender && !seen.current!.has(k);
  useEffect(() => {
    seen.current = new Set(rows.map((r) => r.key));
  });

  return (
    <div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-rule px-4 py-2 max-md:hidden">
        <span className="eyebrow !text-them">They traded</span>
        <span className="eyebrow w-40 text-center">delay</span>
        <span className="eyebrow !text-you">You copied</span>
      </div>
      <ol className="divide-y divide-rule">
        {rows.map((r) => {
          const t = r.you;
          const s = t ? slip(t) : null;
          return (
            <li key={r.key} className={cx('grid grid-cols-1 gap-x-3 gap-y-1.5 px-4 py-2.5 md:grid-cols-[1fr_auto_1fr] md:items-center', isNew(r.key) && 'tape-enter')}>
              {/* their side */}
              <div className="tape-them flex min-w-0 items-center gap-2.5">
                <span className="num w-[58px] shrink-0 text-[11px] text-faint">{clock(r.time)}</span>
                {r.them ? (
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="num text-[12px] font-semibold text-them uppercase">{SIDE_LABEL[r.them.side] ?? r.them.side}</span>
                    {r.them.side === 'buy' && r.them.spentUsd != null ? (
                      <span className="num text-them" title={r.them.pct != null ? `${pct(r.them.pct)} of their ${r.them.basisUsd ? 'cash' : 'balance'}` : undefined}>
                        {usd(r.them.spentUsd)}
                      </span>
                    ) : (
                      r.them.pct != null && (
                        <span className="num text-them">
                          {r.them.fullExit || (r.them.side === 'sell' && r.them.pct >= 0.995) ? 'all' : pct(r.them.pct)}
                          {r.them.side === 'sell' && r.them.spentUsd != null ? <span className="text-[11px] text-muted"> · {usd(r.them.spentUsd)}</span> : null}
                        </span>
                      )
                    )}
                    <span className="font-medium">{r.token.symbol ?? short(r.token.mint)}</span>
                    <VenueTag venue={r.them.venue} />
                    {r.them.mc != null && <span className="num text-[11.5px] text-muted">MC {mc(r.them.mc)}</span>}
                    <span className="truncate text-[11.5px] text-muted">
                      {r.them.group ? `${r.them.group} · ` : ''}
                      {r.them.signature ? (
                        <ExtLink href={links.tx(r.them.signature)}>{r.them.label}</ExtLink>
                      ) : (
                        r.them.label
                      )}
                      {r.them.role && r.them.role !== 'main' ? ` (${r.them.role})` : ''}
                    </span>
                  </div>
                ) : (
                  <span className="text-muted">manual</span>
                )}
              </div>

              {/* delay link */}
              <div className="w-full pl-[68px] md:w-40 md:pl-0">
                <DelayLink trade={t} notCopied={r.notCopied} />
              </div>

              {/* your side */}
              <div className="tape-you flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 pl-[68px] md:pl-0">
                {t ? (
                  t.status === 'skipped' ? (
                    <span className="text-[12.5px] text-muted">
                      skipped · <span className="text-faint">{t.skipReason}</span>
                    </span>
                  ) : t.status === 'failed' ? (
                    <span className="text-[12.5px] text-loss">
                      {t.side} failed · <span className="opacity-80">{t.error}</span>
                    </span>
                  ) : (
                    <>
                      <span className="num text-[12px] font-semibold text-you uppercase">{t.side}</span>
                      <span className="num text-you">{t.solLamports != null ? sol(t.solLamports) : '…'}</span>
                      {t.marketCapUsd != null && <span className="num text-[11.5px] text-muted">MC {mc(t.marketCapUsd)}</span>}
                      {s != null && Math.abs(s) >= 0.005 && (
                        <span className={cx('num text-[11px]', s > 0 ? 'text-loss' : 'text-gain')} title="Your market cap vs the trader's">
                          {s > 0 ? '+' : '−'}
                          {Math.abs(s * 100).toFixed(0)}% {t.side === 'buy' ? 'higher' : 'lower'}
                        </span>
                      )}
                      {t.route && !t.route.endsWith('jupiter') && (
                        <span className="eyebrow !text-[9.5px] !text-you" title="Built locally and sent via Helius Sender">
                          direct
                        </span>
                      )}
                      {t.paper && <span className="eyebrow !text-[9.5px]">paper</span>}
                      {t.signature && !t.paper && (
                        <ExtLink href={links.tx(t.signature)} className="text-[11px] text-muted">
                          tx
                        </ExtLink>
                      )}
                    </>
                  )
                ) : (
                  <span className="text-[12.5px] text-faint">{r.notCopied}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
