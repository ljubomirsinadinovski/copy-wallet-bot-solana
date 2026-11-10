import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ClosedPosition, type Position } from '../lib/api';
import { ago, clock, dateTime, duration, mc, sol, tokens } from '../lib/format';
import { refreshHeader, usePricedQuery } from '../lib/onDemand';
import { Badge, Button, cx, Empty, ModeBadge, Modal, Panel, Pnl, TokenCell, toast } from '../components/ui';

type Filter = 'all' | 'live' | 'paper';

function FilterTabs<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md border border-rule p-0.5" role="tablist">
      {options.map(([v, label]) => (
        <button
          key={v}
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={cx('rounded px-2.5 py-1 text-[12.5px]', value === v ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export { FilterTabs };

const th = 'eyebrow px-3 py-2 text-left font-normal whitespace-nowrap';
const td = 'px-3 py-2.5 align-middle';

function SellButtons({ p }: { p: Position }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<number | null>(null);
  const sell = useMutation({
    mutationFn: (pctValue: number) => api('/positions/sell', { body: { myWalletId: p.wallet!.id, mint: p.token.mint, pct: pctValue, paper: p.paper } }),
    onSuccess: (_d, v) => {
      toast(`${v >= 1 ? 'Closed' : `Sold ${v * 100}% of`} ${p.token.symbol ?? 'position'}`);
      void qc.invalidateQueries();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const run = (v: number) => (p.paper ? sell.mutate(v) : setConfirm(v));
  return (
    <>
      <div className="flex justify-end gap-1.5">
        <Button size="sm" onClick={() => run(0.25)} disabled={sell.isPending}>
          25%
        </Button>
        <Button size="sm" onClick={() => run(0.5)} disabled={sell.isPending}>
          50%
        </Button>
        <Button size="sm" variant="danger" onClick={() => run(1)} busy={sell.isPending}>
          Close
        </Button>
      </div>
      <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={confirm === 1 ? 'Close position?' : `Sell ${(confirm ?? 0) * 100}%?`}>
        <p className="mb-4 text-muted">
          This sells {confirm === 1 ? 'all' : `${(confirm ?? 0) * 100}%`} of your <b className="text-text">{p.token.symbol}</b> from{' '}
          <b className="text-text">{p.wallet?.label}</b> for SOL – a real transaction.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              sell.mutate(confirm!);
              setConfirm(null);
            }}
          >
            {confirm === 1 ? 'Close position' : `Sell ${(confirm ?? 0) * 100}%`}
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function OpenTable({ rows }: { rows: Position[] }) {
  if (!rows.length) return <Empty title="No open positions">When a trader you copy buys, your position appears here with live profit and market cap.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px]">
        <thead className="border-b border-rule">
          <tr>
            <th className={th}>Token · CA</th>
            <th className={th}>Copied from</th>
            <th className={cx(th, 'text-right')}>Amount</th>
            <th className={cx(th, 'text-right')}>Cost</th>
            <th className={cx(th, 'text-right')}>Value</th>
            <th className={cx(th, 'text-right')}>Profit</th>
            <th className={cx(th, 'text-right')}>Entry MC → now</th>
            <th className={cx(th, 'text-right')}>Held</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((p) => (
            <tr key={p.key}>
              <td className={td}>
                <TokenCell token={p.token} />
              </td>
              <td className={td}>
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{p.group?.name ?? p.wallet?.label}</span>
                  <ModeBadge paper={p.paper} />
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted">
                  {p.sources.map((s) => `${s.label.length > 16 ? s.label.slice(0, 4) + '…' + s.label.slice(-4) : s.label}${s.role && s.role !== 'main' ? ` (${s.role})` : ''}`).join(', ')}
                </div>
                {p.sources
                  .filter((s) => s.note && !s.note.startsWith('moved from'))
                  .map((s) => (
                    <div key={s.lotId} className="mt-1 max-w-[260px] text-[11px] leading-snug text-warn" title={s.note!}>
                      ⚠ {s.note}
                    </div>
                  ))}
              </td>
              <td className={cx(td, 'num text-right')}>{tokens(p.tokenAmount, p.token.decimals)}</td>
              <td className={cx(td, 'num text-right')}>{sol(p.costLamports)}</td>
              <td className={cx(td, 'num text-right')}>
                {sol(p.valueLamports)}
                {p.priceStale && (
                  <div className="text-[10.5px] text-faint" title="No live price yet – using the last fill price">
                    last fill
                  </div>
                )}
              </td>
              <td className={cx(td, 'text-right')}>
                <Pnl lamports={p.pnlLamports} pctValue={p.pnlPct} />
              </td>
              <td className={cx(td, 'num text-right whitespace-nowrap')}>
                <span className="text-muted">{mc(p.entryMcUsd)}</span> → {mc(p.currentMcUsd)}
              </td>
              <td className={cx(td, 'num text-right text-muted')}>{ago(p.openedAt)}</td>
              <td className={td}>{p.wallet && <SellButtons p={p} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClosedTable({ rows }: { rows: ClosedPosition[] }) {
  if (!rows.length) return <Empty title="No closed positions yet">Positions move here once fully sold, with entry and exit market cap.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px]">
        <thead className="border-b border-rule">
          <tr>
            <th className={th}>Token · CA</th>
            <th className={th}>Copied from</th>
            <th className={cx(th, 'text-right')}>Invested</th>
            <th className={cx(th, 'text-right')}>Returned</th>
            <th className={cx(th, 'text-right')}>Profit</th>
            <th className={cx(th, 'text-right')}>Entry MC</th>
            <th className={cx(th, 'text-right')}>Exit MC</th>
            <th className={cx(th, 'text-right')}>Held</th>
            <th className={cx(th, 'text-right')}>Closed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((p) => (
            <tr key={p.id}>
              <td className={td}>
                <TokenCell token={p.token} />
              </td>
              <td className={td}>
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{p.group?.name ?? p.wallet?.label}</span>
                  <ModeBadge paper={p.paper} />
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted">
                  {p.source.label.length > 16 ? `${p.source.label.slice(0, 4)}…${p.source.label.slice(-4)}` : p.source.label}
                  {p.source.role && p.source.role !== 'main' ? ` (${p.source.role})` : ''}
                </div>
              </td>
              <td className={cx(td, 'num text-right')}>{sol(p.totalCostLamports)}</td>
              <td className={cx(td, 'num text-right')}>{sol(p.proceedsLamports)}</td>
              <td className={cx(td, 'text-right')}>
                {p.note ? (
                  <Badge title={p.note}>outside bot</Badge>
                ) : (
                  <Pnl lamports={p.realizedLamports} pctValue={p.pnlPct} />
                )}
              </td>
              <td className={cx(td, 'num text-right')}>{mc(p.entryMcUsd)}</td>
              <td className={cx(td, 'num text-right')}>{mc(p.exitMcUsd)}</td>
              <td className={cx(td, 'num text-right text-muted')}>{p.closedAt ? duration(p.closedAt - p.openedAt) : '—'}</td>
              <td className={cx(td, 'num text-right text-muted')}>{dateTime(p.closedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PositionsPage() {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [mode, setMode] = useState<Filter>('all');
  const paperParam = mode === 'all' ? '' : `&paper=${mode === 'paper'}`;
  // Prices load when the page opens and on Refresh – never on a timer.
  const open = usePricedQuery<Position[]>(['positions', 'open', mode], `/positions?status=open${paperParam}`, tab === 'open');
  const closed = useQuery({ queryKey: ['positions', 'closed', mode], queryFn: () => api<ClosedPosition[]>(`/positions?status=closed${paperParam}`), enabled: tab === 'closed' });
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await (tab === 'open' ? open.refresh() : Promise.all([closed.refetch(), refreshHeader(qc)]));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Panel
      title={tab === 'open' ? `Open positions${open.data ? ` · ${open.data.length}` : ''}` : 'Closed positions'}
      flush
      action={
        <div className="flex flex-wrap items-center gap-2">
          {tab === 'open' && open.pricedAt && <span className="text-[11.5px] text-faint">prices from {clock(open.pricedAt)}</span>}
          <FilterTabs value={tab} onChange={setTab} options={[['open', 'Open'], ['closed', 'Closed']]} />
          <FilterTabs value={mode} onChange={setMode} options={[['all', 'All'], ['live', 'Live'], ['paper', 'Paper']]} />
          <Button size="sm" variant="ghost" onClick={() => void refresh()} busy={refreshing}>
            Refresh
          </Button>
        </div>
      }
    >
      {tab === 'open' ? open.data && <OpenTable rows={open.data} /> : closed.data && <ClosedTable rows={closed.data} />}
    </Panel>
  );
}
