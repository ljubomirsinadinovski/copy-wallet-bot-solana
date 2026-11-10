import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, type Dashboard, type DashboardWallet, type Summary, type WalletRow } from '../lib/api';
import { ago, clock, pct, signedSol, sol, tone, usd } from '../lib/format';
import { MirrorTape } from '../components/MirrorTape';
import { usePricedQuery } from '../lib/onDemand';
import { Address, Button, cx, Empty, ModeBadge, Panel, toast } from '../components/ui';
import { useStatus } from '../components/Layout';

function Ledger({ s, solUsd }: { s: Summary; solUsd: number | null }) {
  const row = (label: string, value: React.ReactNode, hint?: string) => (
    <div className="flex items-baseline justify-between gap-3 border-t border-rule py-2" title={hint}>
      <span className="text-muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
  return (
    <div>
      <div className="eyebrow">Total profit</div>
      <div className={cx('num mt-1 font-display text-[40px] leading-none font-semibold tracking-tight', tone(s.totalPnlLamports))}>
        {signedSol(s.totalPnlLamports, 3)}
      </div>

      <div className="mt-5">
        {row('Realized', <span className={tone(s.realizedLamports)}>{signedSol(s.realizedLamports)}</span>, 'Profit locked in by sells')}
        {row('Unrealized', <span className={tone(s.unrealizedLamports)}>{signedSol(s.unrealizedLamports)}</span>, 'Open positions at current prices')}
        {row('In open positions', sol(s.openValueLamports))}
        {row('Open positions', s.openPositions)}
        {row('Trades today', <>{s.trades.today} <span className="text-faint">/ {s.trades.all} total</span></>)}
        {row('Win rate', s.winRate == null ? '—' : <>{pct(s.winRate, 0)} <span className="text-faint">of {s.closedPositions} closed</span></>)}
        {(s.trades.skippedToday > 0 || s.trades.failedToday > 0) &&
          row('Skipped · failed today', <><span className="text-muted">{s.trades.skippedToday}</span> · <span className={s.trades.failedToday ? 'text-loss' : ''}>{s.trades.failedToday}</span></>)}
      </div>
    </div>
  );
}

export function DashboardPage() {
  // Token prices (the unrealized part) load when the page opens and on Refresh – never on a timer.
  // Reloads after a live trade only re-read the database, with the prices already loaded.
  const dash = usePricedQuery<Dashboard>(['dashboard'], '/dashboard');
  const { data, pricedAt } = dash;
  const { data: status } = useStatus();
  const refresh = useMutation({
    // On-chain balances of live wallets, then prices.
    mutationFn: async () => {
      await api<WalletRow[]>('/wallets?refresh=1');
      await dash.refresh();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const hasLive = Boolean(data && (data.live.trades.all > 0 || data.live.openPositions > 0));
  const [mode, setMode] = useState<'live' | 'paper' | null>(null);
  const active = mode ?? (hasLive ? 'live' : 'paper');

  if (!data) return null;
  const s = data[active];
  const noGroups = data.wallets.every((w) => !w.group);

  return (
    <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
      <div className="flex flex-col gap-5">
        <Panel
          title="Your result"
          action={
            <div className="flex rounded-md border border-rule p-0.5" role="tablist">
              {(['live', 'paper'] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={active === m}
                  onClick={() => setMode(m)}
                  className={cx('num rounded px-2 py-0.5 text-[11px] uppercase', active === m ? 'bg-panel-2 text-text' : 'text-muted')}
                >
                  {m}
                </button>
              ))}
            </div>
          }
        >
          <Ledger s={s} solUsd={status?.solUsd ?? null} />
          <div className="mt-3 flex items-center justify-between gap-3 text-[11.5px] text-faint">
            <span>{pricedAt ? `Prices from ${clock(pricedAt)} – Refresh to update` : 'Loading prices…'}</span>
            <Button size="sm" variant="ghost" onClick={() => refresh.mutate()} busy={refresh.isPending}>
              Refresh
            </Button>
          </div>
        </Panel>

        <Panel
          title="Your wallets"
          flush
          action={
            <div className="flex items-center gap-3">
              <Button size="sm" variant="ghost" onClick={() => refresh.mutate()} busy={refresh.isPending}>
                Refresh
              </Button>
              <Link to="/wallets" className="text-[12px] text-muted hover:text-text">
                manage
              </Link>
            </div>
          }
        >
          {data.wallets.length === 0 ? (
            <Empty title="No wallets yet">Create one on the Traders page – each copied trader gets its own wallet.</Empty>
          ) : (
            <ul className="divide-y divide-rule">
              {data.wallets.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link to={`/wallets/${w.id}`} className="truncate font-medium hover:underline">
                        {w.label}
                      </Link>
                      {w.group && <ModeBadge paper={w.group.paper} />}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                      {w.group ? <span className="truncate">copies {w.group.name}</span> : <span>not copying anyone</span>}
                      <Address value={w.pubkey} />
                    </div>
                  </div>
                  <WalletWorth w={w} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Copy tape · live" flush action={<Link to="/trades" className="text-[12px] text-muted hover:text-text">all trades</Link>}>
        {data.recentTrades.length === 0 && data.recentSignals.length === 0 ? (
          noGroups ? (
            <Empty title="Nothing to copy yet">
              Add a trader and their side wallets on the <Link to="/traders" className="text-you underline">Traders</Link> page. Their trades appear here
              in amber, your copies in cyan.
            </Empty>
          ) : (
            <Empty title="Waiting for the first trade">The bot is watching. Every trade a watched wallet makes shows up here the moment it’s detected.</Empty>
          )
        ) : (
          <MirrorTape trades={data.recentTrades} signals={data.recentSignals} />
        )}
      </Panel>
    </div>
  );
}

/**
 * What a wallet is worth now: cash + its open positions at the loaded prices. For paper wallets the
 * change since the start is realized + unrealized, the same result the Traders page counts.
 */
function WalletWorth({ w }: { w: DashboardWallet }) {
  const paper = Boolean(w.group?.paper);
  const cash = paper ? w.paperCashLamports : w.solLamports;
  const change = w.worthLamports != null && w.startLamports != null ? w.worthLamports - w.startLamports : null;
  const detail = `Cash ${sol(cash)} + ${w.openPositions} open position${w.openPositions === 1 ? '' : 's'} worth ${sol(w.openValueLamports)}. Realized ${signedSol(w.realizedLamports)}, unrealized ${signedSol(w.unrealizedLamports)}.`;
  return (
    <div className="shrink-0 text-right" title={detail}>
      <div className="num">
        {w.worthLamports != null ? sol(w.worthLamports) : '—'}
        {change != null && <span className={cx('ml-1.5 text-[11px]', tone(change))}>{signedSol(change)}</span>}
      </div>
      <div className="num text-[11px] text-faint">
        {w.openPositions > 0 ? (
          <>
            cash {sol(cash)} · open <span className={tone(w.unrealizedLamports)}>{signedSol(w.unrealizedLamports)}</span>
          </>
        ) : paper ? (
          'paper · all cash'
        ) : w.balanceAt ? (
          `on-chain · ${ago(w.balanceAt)} ago`
        ) : (
          'press Refresh'
        )}
      </div>
    </div>
  );
}
