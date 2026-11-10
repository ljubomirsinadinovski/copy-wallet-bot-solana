import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ClosedPosition, type Position, type Trade, type WalletRow } from '../lib/api';
import { ago, clock, signedSol, sol, tone } from '../lib/format';
import { usePricedQuery } from '../lib/onDemand';
import { Address, Button, cx, Empty, ModeBadge, Panel, toast } from '../components/ui';
import { ClosedTable, FilterTabs, OpenTable } from './Positions';
import { TradesTable } from './Trades';

/** One of your wallets: its balance, open and closed positions, and every trade it made. */
export function WalletDetailPage() {
  const id = Number(useParams().id);
  const [tab, setTab] = useState<'open' | 'closed' | 'trades'>('open');
  const wallets = useQuery({ queryKey: ['wallets'], queryFn: () => api<WalletRow[]>('/wallets') });
  // Prices load when the page opens and on Refresh – never on a timer.
  const open = usePricedQuery<Position[]>(['positions', 'open', 'wallet', id], `/positions?status=open&walletId=${id}`);
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      // The on-chain balance first, then positions at fresh prices, closed positions and trades.
      qc.setQueryData(['wallets'], await api<WalletRow[]>('/wallets?refresh=1'));
      await Promise.all([open.refresh(), closed.refetch(), tab === 'trades' ? trades.refetch() : null]);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  };
  const closed = useQuery({ queryKey: ['positions', 'closed', 'wallet', id], queryFn: () => api<ClosedPosition[]>(`/positions?status=closed&walletId=${id}`) });
  const trades = useQuery({ queryKey: ['trades', 'wallet', id], queryFn: () => api<Trade[]>(`/trades?walletId=${id}&limit=300`), enabled: tab === 'trades' });

  const w = wallets.data?.find((x) => x.id === id);
  if (wallets.data && !w) return <Empty title="Wallet not found">It may have been hidden. Go back to <Link to="/wallets" className="text-you underline">My wallets</Link>.</Empty>;
  if (!w) return null;

  const openValue = (open.data ?? []).reduce((s, p) => s + (p.valueLamports ?? 0), 0);
  const unrealized = (open.data ?? []).reduce((s, p) => s + (p.pnlLamports ?? 0), 0);
  const realized = (closed.data ?? []).reduce((s, p) => s + p.realizedLamports, 0);
  const stat = (label: string, value: React.ReactNode, className?: string) => (
    <div>
      <div className="eyebrow">{label}</div>
      <div className={cx('num mt-1 text-lg', className)}>{value}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/wallets" className="text-[12px] text-muted hover:text-text">
          ← My wallets
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{w.label}</h1>
          {w.group && <ModeBadge paper={w.group.paper} />}
          <Address value={w.pubkey} />
          <span className="text-muted">{w.group ? `copies ${w.group.name}` : 'not copying anyone'}</span>
          <span className="ml-auto flex items-center gap-3">
            {open.pricedAt && <span className="text-[11.5px] text-faint">prices from {clock(open.pricedAt)}</span>}
            <Button size="sm" variant="ghost" onClick={() => void refresh()} busy={refreshing}>
              Refresh
            </Button>
          </span>
        </div>
      </div>

      <Panel>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-5">
          {stat(w.group?.paper ? 'Paper balance' : 'Balance', w.group?.paper ? sol(w.paperCashLamports) : sol(w.solLamports))}
          {stat('In open positions', sol(openValue))}
          {stat('Unrealized', signedSol(unrealized), tone(unrealized))}
          {stat('Realized', signedSol(realized), tone(realized))}
          {stat('Balance read', w.group?.paper ? 'simulated' : w.balanceAt ? `${ago(w.balanceAt)} ago` : '—')}
        </div>
      </Panel>

      <Panel
        title={tab === 'open' ? `Open positions · ${open.data?.length ?? 0}` : tab === 'closed' ? `Closed positions · ${closed.data?.length ?? 0}` : 'All trades'}
        flush
        action={<FilterTabs value={tab} onChange={setTab} options={[['open', 'Open'], ['closed', 'Closed'], ['trades', 'All trades']]} />}
      >
        {tab === 'open' && open.data && <OpenTable rows={open.data} />}
        {tab === 'closed' && closed.data && <ClosedTable rows={closed.data} />}
        {tab === 'trades' && trades.data && <TradesTable rows={trades.data} />}
      </Panel>
    </div>
  );
}
