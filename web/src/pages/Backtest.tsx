import { Fragment, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type BacktestResult, type BacktestToken, type GroupRow } from '../lib/api';
import { dateTime, links, mc, pct, short, usd } from '../lib/format';
import { Badge, Button, cx, Empty, ExtLink, Field, Panel, TokenCell } from '../components/ui';

const th = 'eyebrow px-3 py-2 text-left font-normal whitespace-nowrap';
const td = 'px-3 py-2.5 align-middle';

const signedUsd = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd(Math.abs(v))}`);
const signedPctText = (v: number | null | undefined) => (v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`);
const toneOf = (v: number | null | undefined) => (v == null || Math.abs(v) < 0.005 ? 'text-muted' : v > 0 ? 'text-gain' : 'text-loss');

/** "What if I had copied this wallet?" – replays its last tokens with a delay, priced from the chain. */
export function BacktestPage() {
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<GroupRow[]>('/groups') });
  const [wallet, setWallet] = useState('');
  const [tokens, setTokens] = useState('15');
  const [delay, setDelay] = useState('1');
  const [copyPct, setCopyPct] = useState('');
  const [minUsd, setMinUsd] = useState('');
  const [maxUsd, setMaxUsd] = useState('');

  const watched = (groups.data ?? []).flatMap((g) => g.wallets.map((w) => ({ ...w, group: g })));
  const picked = watched.find((w) => w.address === wallet.trim());

  const run = useMutation({
    mutationFn: () =>
      api<BacktestResult>('/backtest', {
        body: {
          wallet: wallet.trim(),
          tokens: Number(tokens) || 15,
          delaySec: Number(delay),
          ...(copyPct ? { copyPct: Number(copyPct) } : {}),
          ...(minUsd ? { minUsd: Number(minUsd) } : {}),
          ...(maxUsd ? { maxUsdPerToken: Number(maxUsd) } : {}),
        },
      }),
  });
  const r = run.data;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Backtest</h1>
        <p className="mt-1 max-w-3xl text-muted">
          Would copying this wallet have made money? The bot replays its last tokens – buys and sells only, detected the same way as live
          copying – and prices each of your copies at the token’s first real trade at least the delay after theirs, read from the chain.
        </p>
      </div>

      <Panel title="Wallet and copy rules">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          <div className="grid gap-4 md:grid-cols-[1fr_280px]">
            <Field label="Wallet address" hint={picked ? `${picked.label || 'watched wallet'} in ${picked.group.name} – its group’s copy rules are used unless you fill them in below.` : 'Any Solana wallet.'}>
              <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Paste a wallet address" spellCheck={false} className="num" />
            </Field>
            <Field label="…or a wallet you watch">
              <select value={picked ? picked.address : ''} onChange={(e) => setWallet(e.target.value)}>
                <option value="">Choose…</option>
                {(groups.data ?? []).map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.wallets.map((w) => (
                      <option key={w.id} value={w.address}>
                        {w.label || short(w.address)} · {w.role}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Last tokens" hint="How many of its most recent tokens to replay.">
              <input type="number" min={1} max={50} step={1} value={tokens} onChange={(e) => setTokens(e.target.value)} />
            </Field>
            <Field label="Your delay (seconds)" hint="How long after their trade yours lands. Free plan ≈ 1–3 s.">
              <input type="number" min={0} max={60} step={0.5} value={delay} onChange={(e) => setDelay(e.target.value)} />
            </Field>
            <Field label="Copy % of their size" hint={`Blank = ${picked ? `group’s ${picked.group.copyPct}%` : '10%'}.`}>
              <input type="number" min={0.1} step="any" value={copyPct} onChange={(e) => setCopyPct(e.target.value)} placeholder={String(picked?.group.copyPct ?? 10)} />
            </Field>
            <Field label="Minimum per buy ($)" hint={`Blank = ${usd(picked?.group.minUsd ?? 3)}.`}>
              <input type="number" min={0} step="any" value={minUsd} onChange={(e) => setMinUsd(e.target.value)} placeholder={String(picked?.group.minUsd ?? 3)} />
            </Field>
            <Field label="Max per token ($)" hint={`Blank = ${usd(picked?.group.maxUsdPerToken ?? 50)}.`}>
              <input type="number" min={0.01} step="any" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} placeholder={String(picked?.group.maxUsdPerToken ?? 50)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" busy={run.isPending} disabled={!wallet.trim()}>
              {run.isPending ? 'Replaying…' : 'Run backtest'}
            </Button>
            <span className="text-[12px] text-muted">
              Takes about 10–30 s and roughly 500–1,500 Helius credits (0.05–0.15% of the free plan). Nothing is traded.
            </span>
          </div>
          {run.error && <div className="text-loss">{(run.error as Error).message}</div>}
        </form>
      </Panel>

      {r && <Results r={r} />}
    </div>
  );
}

function Results({ r }: { r: BacktestResult }) {
  const [open, setOpen] = useState<string | null>(null);
  const t = r.totals;
  const stat = (label: string, value: React.ReactNode, className?: string, hint?: string) => (
    <div title={hint}>
      <div className="eyebrow">{label}</div>
      <div className={cx('num mt-1 text-lg', className)}>{value}</div>
    </div>
  );
  const verdict = t.pnlPct == null ? null : t.pnlUsd > 0 ? 'profitable' : 'losing';

  return (
    <>
      <Panel
        title={
          <span className="flex items-center gap-2">
            Result · {r.watchedLabel || short(r.wallet, 5)} · {r.delaySec}s delay
            {verdict && <Badge tone={verdict === 'profitable' ? 'gain' : 'loss'}>{verdict}</Badge>}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
          {stat('Your profit', <>{signedUsd(t.pnlUsd)} <span className="text-[0.8em] opacity-80">{signedPctText(t.pnlPct)}</span></>, toneOf(t.pnlUsd), 'Sells + what you still hold at the latest price − buys − fees')}
          {stat('You invested', usd(t.costUsd))}
          {stat('Still held (now)', usd(t.openUsd), undefined, 'Tokens you’d still hold, valued at each token’s latest trade')}
          {stat('Fees', usd(t.feesUsd), undefined, 'Network + priority fee + tip per trade')}
          {stat('Tokens won / lost', `${t.wins} / ${t.losses}`)}
          {stat('Trader’s profit', signedUsd(t.theirPnlUsd), toneOf(t.theirPnlUsd), 'The trader’s own result on the same trades, at their size')}
        </div>
        <div className="mt-4 text-[12px] text-muted">
          {r.scannedTxs.toLocaleString()} transactions read · ~{r.creditsEstimate.toLocaleString()} Helius credits · dollars at today’s SOL price ({usd(r.solUsd)})
          {r.group ? ` · copy rules of ${r.group.name} unless changed above` : ''}
        </div>
        {r.warnings.map((w) => (
          <div key={w} className="mt-2 text-warn">
            {w}
          </div>
        ))}
      </Panel>

      <Panel title={`Tokens · ${r.tokens.length}`} flush>
        {!r.tokens.length ? (
          <Empty title="No token trades found">This wallet has no buys of tokens in its recent history.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead className="border-b border-rule">
                <tr>
                  <th className={th}>Token · CA</th>
                  <th className={cx(th, 'text-right')}>Trades</th>
                  <th className={cx(th, 'text-right')}>You put in</th>
                  <th className={cx(th, 'text-right')}>You got out</th>
                  <th className={cx(th, 'text-right')} title="Value now of what you'd still hold">Still held</th>
                  <th className={cx(th, 'text-right')}>Your profit</th>
                  <th className={cx(th, 'text-right')}>Trader’s profit</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {r.tokens.map((k) => (
                  <Fragment key={k.mint}>
                    <tr className="cursor-pointer hover:bg-panel-2" onClick={() => setOpen(open === k.mint ? null : k.mint)}>
                      {/* Its copy/scan/chart links shouldn't also open the row. */}
                      <td className={td} onClick={(e) => e.stopPropagation()}>
                        <TokenCell token={{ mint: k.mint, symbol: k.symbol, name: null, icon: null, decimals: null }} />
                      </td>
                      <td className={cx(td, 'num text-right')}>{k.trades.length}</td>
                      <td className={cx(td, 'num text-right')}>{usd(k.yourCostUsd)}</td>
                      <td className={cx(td, 'num text-right')}>{usd(k.yourProceedsUsd)}</td>
                      <td className={cx(td, 'num text-right')}>{k.stillOpen ? usd(k.yourOpenUsd) : '—'}</td>
                      <td className={cx(td, 'num text-right', toneOf(k.yourPnlUsd))}>
                        {k.yourCostUsd > 0 ? signedUsd(k.yourPnlUsd) : '—'} <span className="text-[0.85em] opacity-80">{signedPctText(k.yourPnlPct)}</span>
                      </td>
                      <td className={cx(td, 'num text-right', toneOf(k.theirPnlUsd))}>
                        {signedUsd(k.theirPnlUsd)} <span className="text-[0.85em] opacity-80">{signedPctText(k.theirPnlPct)}</span>
                      </td>
                      <td className={cx(td, 'text-right text-[12px] text-muted')}>{open === k.mint ? 'hide' : 'trades'}</td>
                    </tr>
                    {open === k.mint && (
                      <tr>
                        <td colSpan={8} className="bg-panel-2/50 px-3 py-3">
                          <TokenTrades k={k} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="max-w-3xl text-[12px] text-muted">
        How it’s priced: each copy uses the token’s first trade by another wallet at least the delay after the trader’s. If nothing traded within
        10 s after that, the last trade before your copy is used. Like the live bot, it skips dev launches and tokens your Safety settings reject
        (checked against the token as it is today), and a sold position frees its per-token budget. Not modelled: your own trade’s price impact
        (large sizes in thin tokens would do a bit worse), your wallet balance, max open positions, and tokens the trader moved to another
        wallet instead of selling (they stay held here, valued at the latest trade).
      </p>
    </>
  );
}

function TokenTrades({ k }: { k: BacktestToken }) {
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className={th}>Time</th>
          <th className={th}>Side</th>
          <th className={cx(th, 'text-right')}>They traded</th>
          <th className={cx(th, 'text-right')}>Their MC</th>
          <th className={cx(th, 'text-right')}>You</th>
          <th className={cx(th, 'text-right')}>Your MC</th>
          <th className={cx(th, 'text-right')} title="Time between their trade and the trade that priced yours">After</th>
          <th className={th}>Note</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-rule">
        {k.trades.map((x, i) => (
          <tr key={`${x.signature}:${i}`} className={x.yourUsd == null ? 'opacity-60' : ''}>
            <td className={cx(td, 'num text-[12px] whitespace-nowrap text-muted')}>
              <ExtLink href={links.tx(x.signature)}>{dateTime(x.time)}</ExtLink>
            </td>
            <td className={td}>
              <Badge tone={x.side === 'buy' ? 'gain' : 'loss'}>{x.side.toUpperCase()}</Badge>
            </td>
            <td className={cx(td, 'num text-right')}>
              {usd(x.theirUsd)}
              {x.side === 'sell' && <span className="ml-1 text-[0.85em] text-muted">({pct(x.pct, 0)})</span>}
            </td>
            <td className={cx(td, 'num text-right')}>{mc(x.theirMcUsd)}</td>
            <td className={cx(td, 'num text-right')}>{usd(x.yourUsd)}</td>
            <td className={cx(td, 'num text-right')}>{mc(x.yourMcUsd)}</td>
            <td className={cx(td, 'num text-right text-muted')}>
              {x.pricedBy && x.lagMs != null ? <ExtLink href={links.tx(x.pricedBy)}>{(x.lagMs / 1000).toFixed(1)}s</ExtLink> : '—'}
            </td>
            <td className={cx(td, 'text-[12px] text-muted')}>{x.note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
