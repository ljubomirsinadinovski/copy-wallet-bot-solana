import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type SignalRow, type Trade } from '../lib/api';
import { dateTime, duration, links, mc, pct, short, sol, tokens, usd } from '../lib/format';
import { Badge, cx, Empty, ExtLink, ModeBadge, Panel, Pnl, RouteBadge, TokenCell, VenueTag } from '../components/ui';
import { FilterTabs } from './Positions';

const th = 'eyebrow px-3 py-2 text-left font-normal whitespace-nowrap';
const td = 'px-3 py-2.5 align-middle';

function StatusCell({ t }: { t: Trade }) {
  if (t.status === 'confirmed')
    return (
      <span className="inline-flex items-center gap-2">
        {t.signature && !t.paper ? (
          <ExtLink href={links.tx(t.signature)} className="text-gain">
            done ↗
          </ExtLink>
        ) : (
          <span className="text-gain">done</span>
        )}
        <RouteBadge route={t.route} />
      </span>
    );
  if (t.status === 'skipped') return <span className="text-muted" title={t.skipReason ?? ''}>skipped · <span className="text-faint">{t.skipReason}</span></span>;
  if (t.status === 'failed') return <span className="text-loss" title={t.error ?? ''}>failed{t.attempts > 1 ? ` ×${t.attempts}` : ''} · <span className="opacity-80">{t.error}</span></span>;
  return <span className="text-warn">{t.status}…</span>;
}

export function TradesTable({ rows }: { rows: Trade[] }) {
  if (!rows.length) return <Empty title="No trades yet">Every copy – done, skipped or failed – is listed here with its reason.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1180px]">
        <thead className="border-b border-rule">
          <tr>
            <th className={th}>Time</th>
            <th className={th}>Trader</th>
            <th className={th}>Side</th>
            <th className={th}>Token · CA</th>
            <th className={cx(th, 'text-right')}>Amount ($)</th>
            <th className={cx(th, 'text-right')}>Tokens</th>
            <th className={cx(th, 'text-right')} title="Market cap at your fill: entry for buys, exit for sells">Your MC</th>
            <th className={cx(th, 'text-right')} title="Market cap the trader got">Their MC</th>
            <th className={cx(th, 'text-right')} title="What they spent (buy) or the share they sold (sell)">They traded</th>
            <th className={cx(th, 'text-right')} title="From detecting their trade to sending yours">Delay</th>
            <th className={cx(th, 'text-right')}>Profit</th>
            <th className={th}>Result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((t) => (
            <tr key={t.id} className={t.status === 'skipped' ? 'opacity-70' : ''}>
              <td className={cx(td, 'num text-[12px] whitespace-nowrap text-muted')}>{dateTime(t.createdAt)}</td>
              <td className={td}>
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="font-medium">{t.manual ? 'manual' : (t.group?.name ?? '—')}</span>
                  <ModeBadge paper={t.paper} />
                </div>
                {t.source && (
                  <div className="text-[11.5px] text-muted">
                    {t.source.label.length > 16 ? short(t.source.label) : t.source.label}
                    {t.source.role !== 'main' ? ` (${t.source.role})` : ''}
                  </div>
                )}
              </td>
              <td className={td}>
                <Badge tone={t.side === 'buy' ? 'you' : 'them'}>{t.side}</Badge>
              </td>
              <td className={td}>
                <TokenCell token={t.token} />
              </td>
              <td className={cx(td, 'num text-right')}>{t.status === 'confirmed' ? sol(t.solLamports) : t.solLamports ? <span className="text-faint">{sol(t.solLamports)}</span> : '—'}</td>
              <td className={cx(td, 'num text-right')}>{tokens(t.tokenAmount, t.tokenDecimals ?? t.token.decimals)}</td>
              <td className={cx(td, 'num text-right')}>{mc(t.marketCapUsd)}</td>
              <td className={cx(td, 'num text-right text-them')}>
                {t.trader?.signature ? <ExtLink href={links.tx(t.trader.signature)}>{mc(t.trader.marketCapUsd)}</ExtLink> : '—'}
              </td>
              <td className={cx(td, 'num text-right')}>
                {t.side === 'buy' && t.trader?.spentUsd != null ? usd(t.trader.spentUsd) : t.pct != null ? pct(t.pct) : '—'}
                {t.side === 'sell' && t.trader?.spentUsd != null ? <div className="text-[10.5px] text-muted">{usd(t.trader.spentUsd)}</div> : null}
              </td>
              <td className={cx(td, 'num text-right text-muted')}>{duration(t.reactionMs)}</td>
              <td className={cx(td, 'text-right')}>{t.side === 'sell' && t.status === 'confirmed' ? <Pnl lamports={t.realizedLamports} /> : <span className="text-faint">—</span>}</td>
              <td className={cx(td, 'max-w-[280px] truncate text-[12.5px]')}>
                <StatusCell t={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SIDE: Record<string, string> = { buy: 'buy', sell: 'sell', transfer_in: 'received', transfer_out: 'sent' };

function SignalsTable({ rows }: { rows: SignalRow[] }) {
  if (!rows.length) return <Empty title="Nothing detected yet">Trades by the wallets you watch show up here, whether or not they were copied.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px]">
        <thead className="border-b border-rule">
          <tr>
            <th className={th}>Time</th>
            <th className={th}>Wallet</th>
            <th className={th}>Action</th>
            <th className={th}>Token · CA</th>
            <th className={cx(th, 'text-right')} title="What they spent (buy) or the share they sold (sell)">Amount</th>
            <th className={cx(th, 'text-right')}>Tokens</th>
            <th className={cx(th, 'text-right')}>MC</th>
            <th className={cx(th, 'text-right')} title="From their block to our detection">Seen after</th>
            <th className={th}>Tx</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((s) => (
            <tr key={s.id}>
              <td className={cx(td, 'num text-[12px] whitespace-nowrap text-muted')}>{dateTime(s.detectedAt)}</td>
              <td className={td}>
                <div className="font-medium">{s.group?.name ?? '—'}</div>
                <div className="text-[11.5px] text-muted">
                  {s.wallet ? (s.wallet.label.length > 16 ? short(s.wallet.label) : s.wallet.label) : short(s.address)}
                  {s.wallet && s.wallet.role !== 'main' ? ` (${s.wallet.role})` : ''}
                </div>
              </td>
              <td className={td}>
                <span className="inline-flex items-center gap-1.5">
                  <Badge tone="them">{SIDE[s.side] ?? s.side}</Badge>
                  <VenueTag venue={s.venue} />
                </span>
                {s.note && <div className="mt-1 max-w-[200px] truncate text-[11px] text-faint" title={s.note}>{s.note}</div>}
              </td>
              <td className={td}>
                <TokenCell token={s.token} />
              </td>
              <td className={cx(td, 'num text-right text-them')}>
                {s.side === 'buy' && s.spentUsd != null ? usd(s.spentUsd) : s.side === 'buy' || s.side === 'sell' ? (s.fullExit ? 'all' : pct(s.pct)) : '—'}
                {s.side === 'sell' && s.spentUsd != null ? <div className="text-[10.5px] text-muted">{usd(s.spentUsd)}</div> : null}
              </td>
              <td className={cx(td, 'num text-right')}>{tokens(s.tokenAmount, s.tokenDecimals)}</td>
              <td className={cx(td, 'num text-right')}>{mc(s.marketCapUsd)}</td>
              <td className={cx(td, 'num text-right text-muted')}>{s.blockTime ? duration(s.detectedAt - s.blockTime) : '—'}</td>
              <td className={td}>
                <ExtLink href={links.tx(s.signature)} className="num text-[12px] text-muted">
                  {short(s.signature, 4)}
                </ExtLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TradesPage() {
  const [tab, setTab] = useState<'copies' | 'detected'>('copies');
  const [status, setStatus] = useState<'all' | 'confirmed' | 'skipped' | 'failed'>('all');
  const trades = useQuery({
    queryKey: ['trades', status],
    queryFn: () => api<Trade[]>(`/trades?limit=300${status === 'all' ? '' : `&status=${status}`}`),
    enabled: tab === 'copies',
  });
  const signals = useQuery({ queryKey: ['signals'], queryFn: () => api<SignalRow[]>('/signals?limit=300'), enabled: tab === 'detected' });
  return (
    <Panel
      title={tab === 'copies' ? 'Your trades' : 'Detected on watched wallets'}
      flush
      action={
        <div className="flex flex-wrap gap-2">
          <FilterTabs value={tab} onChange={setTab} options={[['copies', 'Your trades'], ['detected', 'Their trades']]} />
          {tab === 'copies' && (
            <FilterTabs value={status} onChange={setStatus} options={[['all', 'All'], ['confirmed', 'Done'], ['skipped', 'Skipped'], ['failed', 'Failed']]} />
          )}
        </div>
      }
    >
      {tab === 'copies' ? trades.data && <TradesTable rows={trades.data} /> : signals.data && <SignalsTable rows={signals.data} />}
    </Panel>
  );
}
