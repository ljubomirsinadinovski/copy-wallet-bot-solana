import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Trade } from '../../../web/src/lib/api';
import { clock, dateTime, links, mc, setSolUsd, short, signedPct, signedSol, sol, tokens as fmtTokens, tone, usd } from '../../../web/src/lib/format';
import { usePricedQuery } from '../../../web/src/lib/onDemand';
import { Address, Badge, Button, CopyButton, cx, Empty, ExtLink, Field, Modal, Panel, TokenCell, toast } from '../../../web/src/components/ui';
import type { ClosedManual, ManualPosition, ManualWallet, PlanStatus, RemovedWallet, SellPlan, Session, TokenPreview } from './types';

const th = 'eyebrow px-3 py-2 text-left font-normal whitespace-nowrap';
const td = 'px-3 py-2.5 align-middle';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The address in what was pasted: the address itself, or a pump.fun / DexScreener / Solscan… link to it. */
const pastedMint = (text: string) => {
  const t = text.trim();
  if (!/^https?:\/\//.test(t)) return t;
  return t.split(/[/?#&=]/).reverse().find((part) => MINT_RE.test(part)) ?? t;
};

/** The "min leftover" you used last time, remembered in this browser. */
const MIN_LEFT_KEY = 'manual:minLeftUsd';
const savedMinLeft = () => {
  try {
    return localStorage.getItem(MIN_LEFT_KEY) ?? '1';
  } catch {
    return '1';
  }
};

/** `value`, once it has stopped changing for `ms` (so typing an amount asks for one quote, not one per key). */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Share of the supply, with enough digits for tiny shares: 2.40%, 0.054%, 0.0012%. */
const supplyPct = (v: number) => (v >= 1 ? `${v.toFixed(2)}%` : v >= 0.01 ? `${v.toFixed(3)}%` : `${v.toPrecision(2)}%`);

export function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<Session>('/manual/session') });
  useEffect(() => {
    const onLost = () => void qc.invalidateQueries({ queryKey: ['session'] });
    window.addEventListener('auth-lost', onLost);
    return () => window.removeEventListener('auth-lost', onLost);
  }, [qc]);

  if (session.isLoading) return null;
  if (session.error || !session.data)
    return <div className="p-8 text-loss">Can’t reach the manual trading server. Is <code>bash manual/run.sh</code> running?</div>;
  const s = session.data;
  setSolUsd(s.solUsd);
  if (!s.setup) return <Gate mode="setup" s={s} />;
  if (!s.loggedIn || !s.unlocked) return <Gate mode="login" s={s} />;
  return <Trading s={s} />;
}

/** First run (create a passphrase for this data folder) or log in (also unlocks the wallet keys). */
function Gate({ mode, s }: { mode: 'setup' | 'login'; s: Session }) {
  const qc = useQueryClient();
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const go = useMutation({
    mutationFn: () => api(mode === 'setup' ? '/manual/setup' : '/manual/login', { body: { passphrase: pass } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const ok = mode === 'login' ? pass.length > 0 : pass.length >= s.minPassphrase && pass === again;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-rule bg-panel p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) go.mutate();
        }}
      >
        <div>
          <div className="font-display text-xl font-semibold">Manual trading</div>
          <div className="mt-1 text-[12.5px] text-muted">
            {mode === 'setup'
              ? `New data folder (${s.dataDir}). Choose a passphrase – it encrypts the wallet keys you create or import here.`
              : 'Logging in also unlocks the wallet keys so trades can be signed.'}
          </div>
        </div>
        <Field label="Passphrase">
          <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        {mode === 'setup' && (
          <Field label="Repeat passphrase" hint={`At least ${s.minPassphrase} characters.`}>
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
        )}
        <Button type="submit" variant="primary" disabled={!ok} busy={go.isPending}>
          {mode === 'setup' ? 'Create passphrase' : 'Log in'}
        </Button>
      </form>
    </div>
  );
}

function Trading({ s }: { s: Session }) {
  const qc = useQueryClient();
  // Loaded when the page opens and on Refresh (positions with fresh prices and on-chain balances).
  const positions = usePricedQuery<ManualPosition[]>(['manual-positions'], '/manual/positions');
  const wallets = useQuery({ queryKey: ['manual-wallets'], queryFn: () => api<ManualWallet[]>('/manual/wallets?refresh=1') });
  const trades = useQuery({ queryKey: ['manual-trades'], queryFn: () => api<Trade[]>('/manual/trades') });
  const closed = useQuery({ queryKey: ['manual-closed'], queryFn: () => api<ClosedManual[]>('/manual/closed') });
  const plans = useQuery({ queryKey: ['manual-plans'], queryFn: () => api<SellPlan[]>('/manual/plans') });
  const [refreshing, setRefreshing] = useState(false);

  /** After a trade or on Refresh: balances, positions (with prices + on-chain amounts), history. */
  const reload = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        positions.refresh(),
        qc.refetchQueries({ queryKey: ['manual-wallets'] }),
        qc.refetchQueries({ queryKey: ['manual-trades'] }),
        qc.refetchQueries({ queryKey: ['manual-closed'] }),
        qc.refetchQueries({ queryKey: ['manual-plans'] }),
        qc.refetchQueries({ queryKey: ['manual-removed-wallets'] }),
        qc.invalidateQueries({ queryKey: ['session'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };
  const logout = useMutation({
    mutationFn: () => api('/manual/logout', { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule bg-panel">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div>
            <div className="font-display text-lg font-semibold tracking-tight">Manual trading</div>
            <div className="text-[11px] text-faint">copy-wallet · data: {s.dataDir}</div>
          </div>
          <div className="flex items-center gap-2">
            {s.liveTrading ? <Badge tone="you">LIVE enabled</Badge> : <Badge tone="warn">paper only – LIVE_TRADING is off</Badge>}
            {s.solUsd && <span className="num text-[12.5px] text-muted">SOL {usd(s.solUsd)}</span>}
          </div>
          <div className="ml-auto flex items-center gap-3">
            {positions.pricedAt && <span className="text-[11.5px] text-faint">prices from {new Date(positions.pricedAt).toLocaleTimeString('en-GB')}</span>}
            <Button size="sm" onClick={() => void reload()} busy={refreshing}>
              Refresh
            </Button>
            <Button size="sm" variant="ghost" onClick={() => logout.mutate()}>
              Log out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] gap-5 px-4 py-5 lg:grid-cols-[380px_1fr]">
        <div className="flex flex-col gap-5">
          <BuyPanel s={s} wallets={wallets.data ?? []} onDone={reload} />
          <WalletsPanel wallets={wallets.data ?? []} onChange={reload} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <PositionsPanel rows={positions.data} loading={positions.isLoading} onDone={reload} />
          <PlansPanel plans={plans.data ?? []} onChange={reload} />
          <HistoryPanel trades={trades.data ?? []} closed={closed.data ?? []} />
        </div>
      </main>
    </div>
  );
}

// ── buy ──────────────────────────────────────────────────────────────────────

function BuyPanel({ s, wallets, onDone }: { s: Session; wallets: ManualWallet[]; onDone: () => Promise<void> }) {
  const [walletId, setWalletId] = useState<number | null>(null);
  const [mint, setMint] = useState('');
  const [amount, setAmount] = useState('10');
  const [paper, setPaper] = useState(!s.liveTrading);
  const [confirm, setConfirm] = useState(false);
  const wallet = wallets.find((w) => w.id === walletId) ?? null;
  useEffect(() => {
    if (walletId == null && wallets.length) setWalletId(wallets[0].id);
  }, [wallets, walletId]);

  const ca = pastedMint(mint);
  const valid = MINT_RE.test(ca);
  const token = useQuery({ queryKey: ['manual-token', ca], queryFn: () => api<TokenPreview>(`/manual/token/${ca}`), enabled: valid, retry: false, staleTime: 15_000 });
  const usdAmount = Number(amount);
  const cash = wallet ? (paper ? wallet.paperCashLamports : wallet.solLamports) : null;
  const ready = Boolean(wallet && valid && token.data && usdAmount > 0);
  // What this amount would buy: a real quote on the buy's route, asked once you stop typing.
  const settledUsd = useSettled(usdAmount);
  const quote = useQuery({
    queryKey: ['manual-quote', ca, settledUsd, wallet?.id],
    queryFn: () => api<{ tokens: string; supplyPct: number | null; route: string }>(`/manual/quote?walletId=${wallet!.id}&mint=${ca}&usd=${settledUsd}`),
    enabled: Boolean(wallet && valid && token.data && settledUsd > 0),
    retry: false,
    staleTime: 15_000,
  });
  const share = quote.data && settledUsd === usdAmount && quote.data.supplyPct != null ? quote.data : null;
  const symbol = token.data?.symbol ?? short(ca);

  const buy = useMutation({
    mutationFn: () => api<Trade | null>('/manual/buy', { body: { walletId: wallet!.id, mint: ca, usd: usdAmount, paper } }),
    onSuccess: async (t) => {
      setConfirm(false);
      if (t?.status === 'confirmed') toast(`Bought ${usd(usdAmount)} of ${token.data?.symbol ?? short(ca)}`);
      else toast(`Buy ${t?.status ?? 'not done'}${t?.error ? `: ${t.error}` : ''}`, t?.status === 'failed' ? 'error' : 'ok');
      await onDone();
    },
    onError: (e) => {
      setConfirm(false);
      toast((e as Error).message, 'error');
    },
  });

  return (
    <Panel title="Buy a token">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) setConfirm(true);
        }}
      >
        <Field label="Wallet" hint={wallet?.copyGroup ? `⚠ Also used by the copy-trading group “${wallet.copyGroup}”. Keep manual trades in their own wallets.` : undefined}>
          <select value={walletId ?? ''} onChange={(e) => setWalletId(Number(e.target.value))}>
            {wallets.length === 0 && <option value="">No wallets – add one below</option>}
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} · {paper ? `paper ${sol(w.paperCashLamports)}` : sol(w.solLamports)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Token contract address (Solana)">
          <input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Paste the mint / CA or a pump.fun link" spellCheck={false} className="num" />
        </Field>
        {ca && !valid && <div className="-mt-2 text-[12px] text-loss">That doesn’t look like a Solana address.</div>}
        {valid && token.isLoading && <div className="-mt-2 text-[12px] text-muted">Looking up the token…</div>}
        {valid && token.error && <div className="-mt-2 text-[12px] text-loss">{(token.error as Error).message}</div>}
        {token.data && <TokenCard t={token.data} />}

        <Field label="Amount ($)" hint={cash != null ? `Available: ${sol(cash)}${paper ? ' (simulated)' : ''}. Network fees come on top.` : undefined}>
          <input type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="-mt-2 flex flex-wrap gap-1.5">
          {[5, 10, 25, 50, 100].map((v) => (
            <button key={v} type="button" onClick={() => setAmount(String(v))} className="num rounded border border-rule px-2 py-0.5 text-[12px] text-muted hover:text-text">
              ${v}
            </button>
          ))}
        </div>
        {ready && (
          <div className="-mt-2 text-[12.5px] text-muted">
            {share ? (
              <>
                ≈ <b className="num text-text">{supplyPct(share.supplyPct!)}</b> of the supply ({fmtTokens(share.tokens, token.data!.decimals)} {symbol})
              </>
            ) : quote.error && settledUsd === usdAmount ? (
              <span className="text-loss">No quote: {(quote.error as Error).message}</span>
            ) : (
              'Getting a quote…'
            )}
          </div>
        )}

        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={paper} disabled={!s.liveTrading} onChange={(e) => setPaper(e.target.checked)} />
          Paper (simulated, nothing is sent){!s.liveTrading && <span className="text-faint"> – LIVE_TRADING is off</span>}
        </label>

        <Button type="submit" variant={paper ? 'default' : 'you'} disabled={!ready} busy={buy.isPending}>
          {paper ? 'Paper buy' : 'Buy'}
          {ready ? ` ${usd(usdAmount)} of ${token.data!.symbol ?? short(ca)}` : ''}
        </Button>
      </form>

      <Modal open={confirm} onClose={() => setConfirm(false)} title={paper ? 'Paper buy' : 'Confirm buy'}>
        <div className="flex flex-col gap-4">
          <p>
            {paper ? 'Simulate buying' : 'Buy'} <b>{usd(usdAmount)}</b> of <b>{symbol}</b>
            {share && (
              <>
                {' '}
                (≈ <b>{supplyPct(share.supplyPct!)}</b> of the supply)
              </>
            )}{' '}
            from <b>{wallet?.label}</b>
            {token.data?.marketCapUsd ? <> at about {mc(token.data.marketCapUsd)} market cap</> : null}.
          </p>
          {token.data?.warnings.length ? <div className="text-[12.5px] text-warn">Note: {token.data.warnings.join('; ')}.</div> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant={paper ? 'default' : 'you'} onClick={() => buy.mutate()} busy={buy.isPending}>
              {paper ? 'Paper buy' : 'Buy now'}
            </Button>
          </div>
        </div>
      </Modal>
    </Panel>
  );
}

function TokenCard({ t }: { t: TokenPreview }) {
  return (
    <div className="-mt-1 rounded-md border border-rule bg-panel-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <TokenCell token={{ mint: t.mint, symbol: t.symbol, name: t.name, icon: null, decimals: t.decimals }} />
        <div className="text-right">
          <div className="num">{mc(t.marketCapUsd)}</div>
          <div className="text-[11px] text-faint">market cap</div>
        </div>
      </div>
      {t.name && <div className="mt-1 text-[12px] text-muted">{t.name}</div>}
      <div className="mt-1 text-[11.5px] text-faint">{t.direct ? 'Tries pump.fun / PumpSwap directly first, Jupiter if the token isn’t there' : 'Traded via Jupiter'}</div>
      {t.warnings.map((w) => (
        <div key={w} className="mt-1 text-[12px] text-warn">
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}

// ── positions ────────────────────────────────────────────────────────────────

function PositionsPanel({ rows, loading, onDone }: { rows: ManualPosition[] | undefined; loading: boolean; onDone: () => Promise<void> }) {
  const [selling, setSelling] = useState<ManualPosition | null>(null);
  const [planning, setPlanning] = useState<ManualPosition | null>(null);
  return (
    <Panel title={`Manual positions${rows ? ` · ${rows.length}` : ''}`} flush>
      {!rows ? (
        loading && <div className="px-4 py-6 text-muted">Loading positions and on-chain balances…</div>
      ) : rows.length === 0 ? (
        <Empty title="No manual positions">Buy a token on the left. Positions you open here are listed with their on-chain balance, value and profit.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px]">
            <thead className="border-b border-rule">
              <tr>
                <th className={th}>Token · CA</th>
                <th className={th}>Wallet</th>
                <th className={cx(th, 'text-right')} title="Tokens in the wallet (read on-chain when the list loaded)">Held</th>
                <th className={cx(th, 'text-right')}>Value</th>
                <th className={cx(th, 'text-right')}>Cost</th>
                <th className={cx(th, 'text-right')}>Profit</th>
                <th className={cx(th, 'text-right')}>Entry → now MC</th>
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
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <span className="font-medium">{p.wallet?.label ?? '—'}</span>
                      {p.paper && <Badge>paper</Badge>}
                    </div>
                    {p.otherLots && <div className="text-[11px] text-warn">also held from copy trading</div>}
                    {p.plan && <div className="text-[11px] text-you">sell plan {p.plan.status}</div>}
                  </td>
                  <td className={cx(td, 'num text-right')}>
                    {fmtTokens(p.heldTokens, p.token.decimals)}
                    {p.onChainTokens != null && p.onChainTokens !== p.recordedTokens && (
                      <div className="text-[11px] text-faint" title="What the trades booked; the wallet's real balance is shown above">
                        booked {fmtTokens(p.recordedTokens, p.token.decimals)}
                      </div>
                    )}
                  </td>
                  <td className={cx(td, 'num text-right')}>
                    {sol(p.valueLamports)}
                    {p.priceStale && <div className="text-[11px] text-faint">last fill price</div>}
                  </td>
                  <td className={cx(td, 'num text-right')}>{sol(p.costLamports)}</td>
                  <td className={cx(td, 'num text-right', tone(p.pnlLamports))}>
                    {signedSol(p.pnlLamports)}
                    {p.pnlLamports != null && p.costLamports > 0 && <span className="ml-1 text-[0.85em] opacity-80">{signedPct(p.pnlLamports / p.costLamports)}</span>}
                  </td>
                  <td className={cx(td, 'num text-right whitespace-nowrap')}>
                    {mc(p.entryMcUsd)} <span className="text-faint">→</span> {mc(p.currentMcUsd)}
                  </td>
                  <td className={cx(td, 'text-right')}>
                    <div className="flex justify-end gap-1.5">
                      {!p.plan && !p.otherLots && (
                        <Button size="sm" onClick={() => setPlanning(p)} title="Sell by market-cap levels, slowly, into buys">
                          Plan…
                        </Button>
                      )}
                      <Button size="sm" variant="danger" onClick={() => setSelling(p)}>
                        Sell…
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selling && <SellModal p={selling} onClose={() => setSelling(null)} onDone={onDone} />}
      {planning && <PlanModal p={planning} onClose={() => setPlanning(null)} onDone={onDone} />}
    </Panel>
  );
}

/**
 * Sell X% of what's in the wallet. The server counts the tokens on-chain right before selling; if what
 * would be left is worth less than "min leftover", it sells everything instead.
 */
function SellModal({ p, onClose, onDone }: { p: ManualPosition; onClose: () => void; onDone: () => Promise<void> }) {
  const [pct, setPct] = useState('100');
  const [minLeft, setMinLeft] = useState(savedMinLeft);
  const pctNum = Number(pct);
  const minNum = Number(minLeft) || 0;
  const validPct = pctNum > 0 && pctNum <= 100;

  // Preview from the amounts loaded with the list; the real sell re-counts on-chain first.
  const preview = useMemo(() => {
    const held = Number(BigInt(p.heldTokens)) / 10 ** (p.token.decimals ?? 0);
    const heldUsd = p.priceUsd != null ? held * p.priceUsd : null;
    const share = validPct ? pctNum / 100 : 0;
    const leftUsd = heldUsd != null ? heldUsd * (1 - share) : null;
    const all = share >= 1 || (minNum > 0 && leftUsd != null && leftUsd < minNum);
    return { heldUsd, sellUsd: heldUsd != null ? heldUsd * (all ? 1 : share) : null, leftUsd: all ? 0 : leftUsd, all, dust: all && share < 1 };
  }, [p, pctNum, minNum, validPct]);

  const sell = useMutation({
    mutationFn: () => {
      try {
        localStorage.setItem(MIN_LEFT_KEY, minLeft);
      } catch {
        // not remembered – fine
      }
      return api<{ trade: Trade | null; soldAll: boolean; heldBefore: string; leftUsd: number | null }>('/manual/sell', {
        body: { walletId: p.wallet!.id, mint: p.token.mint, pct: pctNum, minLeftUsd: minNum, paper: p.paper },
      });
    },
    onSuccess: async (r) => {
      const t = r.trade;
      if (t?.status === 'confirmed') toast(`Sold ${r.soldAll ? 'all' : `${pctNum}%`} of ${p.token.symbol ?? short(p.token.mint)} for ${sol(t.solLamports)}`);
      else toast(`Sell ${t?.status ?? 'not done'}${t?.error ? `: ${t.error}` : ''}`, 'error');
      onClose();
      await onDone();
    },
    onError: async (e) => {
      toast((e as Error).message, 'error');
      onClose();
      await onDone();
    },
  });

  const symbol = p.token.symbol ?? short(p.token.mint);
  return (
    <Modal open onClose={onClose} title={`Sell ${symbol}${p.paper ? ' (paper)' : ''}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (validPct && p.wallet) sell.mutate();
        }}
      >
        <div className="text-[13px] text-muted">
          {p.wallet?.label} holds {fmtTokens(p.heldTokens, p.token.decimals)} {symbol}
          {preview.heldUsd != null && <> ≈ {usd(preview.heldUsd)}</>}. The tokens are counted on-chain again right before the sell.
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sell (%)" hint="Of what’s in the wallet.">
            <input type="number" min={0} max={100} step="any" autoFocus value={pct} onChange={(e) => setPct(e.target.value)} />
          </Field>
          <Field label="Min leftover ($)" hint="Smaller leftovers are sold too. 0 = off.">
            <input type="number" min={0} step="any" value={minLeft} onChange={(e) => setMinLeft(e.target.value)} />
          </Field>
        </div>
        <div className="-mt-2 flex flex-wrap gap-1.5">
          {[25, 50, 75, 100].map((v) => (
            <button key={v} type="button" onClick={() => setPct(String(v))} className="num rounded border border-rule px-2 py-0.5 text-[12px] text-muted hover:text-text">
              {v}%
            </button>
          ))}
        </div>
        {validPct && (
          <div className="rounded-md border border-rule bg-panel-2 px-3 py-2 text-[12.5px]">
            {preview.all ? (
              <>
                Sells <b>everything</b>
                {preview.sellUsd != null && <> ≈ {usd(preview.sellUsd)}</>}
                {preview.dust && preview.leftUsd !== null && <span className="text-muted"> – {pctNum}% would leave less than {usd(minNum)}</span>}.
              </>
            ) : (
              <>
                Sells <b>{pctNum}%</b>
                {preview.sellUsd != null && <> ≈ {usd(preview.sellUsd)}</>}, keeps {preview.leftUsd != null ? <>≈ {usd(preview.leftUsd)}</> : 'the rest'}.
              </>
            )}
            {p.priceUsd == null && <div className="text-faint">No current price – the min leftover rule needs one, so it may not apply.</div>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!validPct} busy={sell.isPending}>
            {preview.all ? 'Sell all' : `Sell ${validPct ? pctNum : ''}%`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── sell plans ───────────────────────────────────────────────────────────────

const DEFAULT_LEVELS = [
  { mc: '100k', pct: '10' },
  { mc: '200k', pct: '15' },
  { mc: '500k', pct: '15' },
  { mc: '1m', pct: '20' },
  { mc: '2m', pct: '20' },
  { mc: '3m', pct: '10' },
];

/** "250k", "1.5m", "$2M" or a plain number → USD. */
function parseMc(v: string): number | null {
  const m = /^\s*\$?\s*([\d.,]+)\s*([kmb])?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * (m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'b'] : 1);
}

/** 250000 → "250k", 1500000 → "1.5m" (how levels are typed). */
const mcText = (v: number) => (v >= 1e6 ? `${+(v / 1e6).toFixed(4)}m` : v >= 1e3 ? `${+(v / 1e3).toFixed(4)}k` : String(v));

type LevelRow = { id?: number; mc: string; pct: string; soldPct: number; done: boolean };

/**
 * Start a sell plan on a position, or change a running one (`plan`): each level sells its % of the
 * bag once the market cap reaches it, a little at a time and only into other people's buys.
 */
function PlanModal({ p, plan, onClose, onDone }: { p?: ManualPosition; plan?: SellPlan; onClose: () => void; onDone: () => Promise<void> }) {
  const s0 = plan?.settings;
  const [levels, setLevels] = useState<LevelRow[]>(() =>
    plan
      ? plan.levels.map((l) => ({
          id: l.id,
          mc: mcText(l.mcUsd),
          pct: String(l.pct),
          soldPct: (Number(BigInt(l.soldTokens)) / Number(BigInt(plan.bagTokens))) * 100,
          done: l.doneAt != null,
        }))
      : DEFAULT_LEVELS.map((l) => ({ ...l, soldPct: 0, done: false })),
  );
  const [share, setShare] = useState(String(s0?.participationPct ?? 30));
  const [impact, setImpact] = useState(String(s0?.maxImpactPct ?? 1.5));
  const [minSell, setMinSell] = useState(String(s0?.minSellUsd ?? 20));
  const [slippage, setSlippage] = useState(String(s0?.slippagePct ?? 2));
  const [stopOn, setStopOn] = useState(s0 ? s0.stopDropPct != null : true);
  const [stop, setStop] = useState(String(s0?.stopDropPct ?? 40));

  const token = plan?.token ?? p!.token;
  const paper = plan?.paper ?? p!.paper;
  const walletLabel = plan?.wallet?.label ?? p?.wallet?.label;
  const symbol = token.symbol ?? short(token.mint);
  const decimals = token.decimals ?? 0;
  // The % are of the bag: what the wallet holds now, or for a running plan what it held at the start.
  const bagRaw = plan?.bagTokens ?? p!.heldTokens;
  const held = Number(BigInt(bagRaw)) / 10 ** decimals;
  const currentMc = plan ? plan.mcUsd : p!.currentMcUsd;
  // Whole-token supply, from the price and market cap loaded with the list.
  const supply = plan ? plan.supply : p!.currentMcUsd != null && p!.priceUsd ? p!.currentMcUsd / p!.priceUsd : null;
  const priceUsd = currentMc != null && supply ? currentMc / supply : null;
  const parsed = levels.map((l) => ({ id: l.id, mcUsd: parseMc(l.mc), pct: Number(l.pct) }));
  const total = parsed.reduce((s, l) => s + (l.pct > 0 ? l.pct : 0), 0);
  const mcs = parsed.map((l) => l.mcUsd);
  const settings = {
    participationPct: Number(share),
    maxImpactPct: Number(impact),
    minSellUsd: Number(minSell),
    slippagePct: Number(slippage),
    stopDropPct: stopOn ? Number(stop) : null,
  };
  const belowSold = levels.find((l, i) => l.soldPct > 0 && parsed[i].pct < l.soldPct - 0.001);
  const problem = !levels.length
    ? 'Add at least one level.'
    : parsed.some((l) => l.mcUsd == null)
      ? 'Every level needs a market cap, e.g. 250k or 1.5m.'
      : parsed.some((l) => !(l.pct > 0 && l.pct <= 100))
        ? 'Every level needs a % above 0.'
        : belowSold
          ? `A level that already sold ${+belowSold.soldPct.toFixed(2)}% can’t be set lower than that.`
          : new Set(mcs).size !== mcs.length
            ? 'Two levels have the same market cap.'
            : total > 100.0001
              ? `The levels add up to ${+total.toFixed(2)}% – at most 100%.`
              : !(settings.participationPct >= 1 && settings.participationPct <= 100)
                ? 'Share of buys: 1–100%.'
                : !(settings.maxImpactPct >= 0.1 && settings.maxImpactPct <= 10)
                  ? 'Max price move per sell: 0.1–10%.'
                  : !(settings.minSellUsd >= 0)
                    ? 'Smallest sell: $0 or more.'
                    : !(settings.slippagePct >= 0.5 && settings.slippagePct <= 25)
                      ? 'Slippage: 0.5–25%.'
                      : settings.stopDropPct != null && !(settings.stopDropPct >= 5 && settings.stopDropPct <= 95)
                        ? 'Trailing stop: 5–95%.'
                        : null;

  const save = useMutation({
    mutationFn: () => {
      const body = { levels: parsed.map((l) => ({ id: l.id, mcUsd: l.mcUsd!, pct: l.pct })), ...settings };
      return plan
        ? api(`/manual/plans/${plan.id}/edit`, { body })
        : api<{ id: number }>('/manual/plans', { body: { walletId: p!.wallet!.id, mint: token.mint, paper, ...body } });
    },
    onSuccess: async () => {
      toast(plan ? `Sell plan for ${symbol} changed` : `Sell plan started for ${symbol}`);
      onClose();
      await onDone();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const setLevel = (i: number, k: 'mc' | 'pct', v: string) => setLevels(levels.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const cell = 'px-1.5 py-1';
  return (
    <Modal open onClose={onClose} title={`${plan ? 'Edit sell plan' : 'Sell plan'} · ${symbol}${paper ? ' (paper)' : ''}`} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && (plan || p?.wallet)) save.mutate();
        }}
      >
        <div className="text-[13px] text-muted">
          {plan ? (
            <>
              The % are of what {walletLabel} held when the plan started ({fmtTokens(bagRaw, decimals)} {symbol}). What a level already sold stays with it: it can be
              moved or raised, not removed or set lower. {currentMc != null && <>Last check: {mc(currentMc)}.</>}
            </>
          ) : (
            <>
              Each level sells its % of what {walletLabel} holds now ({fmtTokens(bagRaw, decimals)} {symbol}
              {priceUsd != null && <> ≈ {usd(held * priceUsd)}</>}) once the market cap reaches it – a little at a time, only into other people’s buys. What no
              level covers is never sold. Now: {mc(currentMc)}.
            </>
          )}
        </div>

        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left">
              <th className={cx(th, 'px-1.5')}>Market cap</th>
              <th className={cx(th, 'px-1.5')}>Sell %</th>
              <th className={cx(th, 'px-1.5 text-right')}>Tokens</th>
              <th className={cx(th, 'px-1.5 text-right')} title="What this level's tokens are worth at that market cap, before price impact and fees">
                ≈ Worth then
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {levels.map((l, i) => {
              const { mcUsd, pct } = parsed[i];
              const tokensHere = pct > 0 ? held * (pct / 100) : null;
              const reached = l.soldPct === 0 && mcUsd != null && currentMc != null && mcUsd <= currentMc;
              return (
                <tr key={l.id ?? `new-${i}`}>
                  <td className={cell}>
                    <input value={l.mc} onChange={(e) => setLevel(i, 'mc', e.target.value)} placeholder="250k" className="num w-28" />
                    {reached && <div className="text-[11px] text-warn">reached – starts selling right away</div>}
                    {l.soldPct > 0 && (
                      <div className="text-[11px] text-gain">
                        sold {+l.soldPct.toFixed(2)}%{l.done ? ' ✓' : ''}
                      </div>
                    )}
                  </td>
                  <td className={cell}>
                    <input type="number" min={0} max={100} step="any" value={l.pct} onChange={(e) => setLevel(i, 'pct', e.target.value)} className="num w-20" />
                  </td>
                  <td className={cx(cell, 'num text-right text-muted')}>{tokensHere != null ? fmtTokens(String(Math.floor(tokensHere * 10 ** decimals)), decimals) : '—'}</td>
                  <td className={cx(cell, 'num text-right')}>{tokensHere != null && mcUsd != null && supply ? usd((tokensHere * mcUsd) / supply) : '—'}</td>
                  <td className={cx(cell, 'text-right')}>
                    <button
                      type="button"
                      onClick={() => setLevels(levels.filter((_, j) => j !== i))}
                      disabled={l.soldPct > 0}
                      title={l.soldPct > 0 ? 'This level already sold part – it can’t be removed' : undefined}
                      className="text-muted hover:text-loss disabled:opacity-30 disabled:hover:text-muted"
                      aria-label="Remove level"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="-mt-2 flex items-center justify-between text-[12.5px]">
          <button type="button" onClick={() => setLevels([...levels, { mc: '', pct: '', soldPct: 0, done: false }])} className="rounded border border-rule px-2 py-0.5 text-muted hover:text-text">
            + Add level
          </button>
          <span className="text-muted">
            Plan sells <b className="num text-text">{+total.toFixed(2)}%</b> · moon bag (never sold) <b className="num text-text">{+Math.max(0, 100 - total).toFixed(2)}%</b>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Sell share of buys (%)" hint="Of the SOL others put into the pool. Lower = gentler.">
            <input type="number" min={1} max={100} step="any" value={share} onChange={(e) => setShare(e.target.value)} />
          </Field>
          <Field label="Max price move per sell (%)" hint="Bigger sells are split.">
            <input type="number" min={0.1} max={10} step="any" value={impact} onChange={(e) => setImpact(e.target.value)} />
          </Field>
          <Field label="Smallest sell ($)" hint="Smaller amounts wait for more buys, so fees stay small.">
            <input type="number" min={0} step="any" value={minSell} onChange={(e) => setMinSell(e.target.value)} />
          </Field>
          <Field label="Slippage (%)" hint="Kept tight so bots can’t sandwich the sells. A failed sell is tried again at the next check.">
            <input type="number" min={0.5} max={25} step="any" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
          </Field>
        </div>
        <div className="rounded-md border border-rule bg-panel-2 px-3 py-2.5">
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input type="checkbox" checked={stopOn} onChange={(e) => setStopOn(e.target.checked)} />
            Trailing stop
          </label>
          <div className={cx('mt-2 flex flex-wrap items-center gap-2 text-[12.5px]', stopOn ? 'text-muted' : 'text-faint')}>
            <span>Sell the rest if the market cap falls</span>
            <input type="number" min={5} max={95} step="any" value={stop} disabled={!stopOn} onChange={(e) => setStop(e.target.value)} className="num w-20 shrink-0" />
            <span>% from its high</span>
          </div>
          <div className="mt-1 text-[11.5px] text-faint">
            Armed once the first level is reached. Still capped per sell, but without waiting for buys. The moon bag is kept.
          </div>
        </div>

        <div className="text-[11.5px] text-faint">
          Runs only while this tool runs{paper ? '' : ' and you’re logged in'}. It reads the pool every 60 s, every 15 s near a level, every 4 s while a level sells – 1 Helius credit
          per read. Selling 2% of a coin’s supply still moves its price; this only keeps each sell small.
        </div>
        {problem && <div className="text-[12.5px] text-loss">{problem}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={paper ? 'default' : 'you'} disabled={Boolean(problem)} busy={save.isPending}>
            {plan ? 'Save changes' : paper ? 'Start paper plan' : 'Start plan'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const PLAN_TONE: Record<PlanStatus, 'you' | 'warn' | 'gain' | 'muted'> = { active: 'you', paused: 'warn', done: 'gain', cancelled: 'muted' };

/** Running plans, and on request the finished ones. Loaded with the page and on Refresh. */
function PlansPanel({ plans, onChange }: { plans: SellPlan[]; onChange: () => Promise<void> }) {
  const [showEnded, setShowEnded] = useState(false);
  const running = plans.filter((p) => p.status === 'active' || p.status === 'paused');
  const ended = plans.filter((p) => p.status === 'done' || p.status === 'cancelled');
  if (!plans.length) return null;
  return (
    <Panel
      title={`Sell plans · ${running.length} running`}
      action={
        ended.length ? (
          <button type="button" onClick={() => setShowEnded(!showEnded)} className="text-[12px] text-muted hover:text-text">
            {showEnded ? 'Hide' : 'Show'} finished ({ended.length})
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {!running.length && <div className="text-[13px] text-muted">No plan running. Start one with “Plan…” on a position.</div>}
        {running.map((p) => (
          <PlanCard key={p.id} p={p} onChange={onChange} />
        ))}
        {showEnded &&
          ended.map((p) => (
            <PlanCard key={p.id} p={p} onChange={onChange} />
          ))}
      </div>
    </Panel>
  );
}

function PlanCard({ p, onChange }: { p: SellPlan; onChange: () => Promise<void> }) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [editing, setEditing] = useState(false);
  const act = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'cancel') => api(`/manual/plans/${p.id}/${a}`, { body: {} }),
    onSuccess: async (_r, a) => {
      setConfirmEnd(false);
      toast(a === 'pause' ? 'Plan paused' : a === 'resume' ? 'Plan resumed' : 'Plan ended – the tokens stay in the wallet');
      await onChange();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const d = p.token.decimals ?? 0;
  const symbol = p.token.symbol ?? short(p.token.mint);
  const running = p.status === 'active' || p.status === 'paused';
  const s = p.settings;
  const status =
    p.status === 'active'
      ? `${p.note ?? 'starting'}${p.checkedAt ? ` · MC ${mc(p.mcUsd)} at ${clock(p.checkedAt)}` : ''}`
      : p.status === 'paused'
        ? p.lastError
          ? `Paused: ${p.lastError}`
          : 'Paused – nothing is read or sold.'
        : `${p.endReason ?? p.status} · ${dateTime(p.updatedAt)}`;

  return (
    <div className="rounded-md border border-rule bg-panel-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <TokenCell token={p.token} />
        <span className="text-[12.5px] text-muted">{p.wallet?.label ?? '—'}</span>
        {p.paper && <Badge>paper</Badge>}
        <Badge tone={p.exiting && running ? 'warn' : PLAN_TONE[p.status]}>{p.exiting && running ? 'stop hit – selling the rest' : p.status}</Badge>
        {running && (
          <div className="ml-auto flex gap-1.5">
            {p.status === 'active' ? (
              <Button size="sm" onClick={() => act.mutate('pause')} busy={act.isPending && act.variables === 'pause'}>
                Pause
              </Button>
            ) : (
              <Button size="sm" onClick={() => act.mutate('resume')} busy={act.isPending && act.variables === 'resume'}>
                Resume
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmEnd(true)}>
              End plan
            </Button>
          </div>
        )}
      </div>
      <div className={cx('mt-1.5 text-[12.5px]', p.status === 'paused' && p.lastError ? 'text-warn' : 'text-muted')}>{status}</div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {p.levels.map((l) => {
          const target = Number(BigInt(l.targetTokens));
          const done = target > 0 ? Math.min(1, Number(BigInt(l.soldTokens)) / target) : 1;
          return (
            <div
              key={l.mcUsd}
              title={`${fmtTokens(l.soldTokens, d)} of ${fmtTokens(l.targetTokens, d)} ${symbol} sold`}
              className={cx(
                'num rounded border px-2 py-1 text-[12px]',
                l.doneAt ? 'border-gain text-gain' : l.selling ? 'border-you bg-you-soft text-you' : 'border-rule text-muted',
              )}
            >
              {mc(l.mcUsd)} · {l.pct}%{l.doneAt ? ' ✓' : done > 0 ? ` · ${Math.floor(done * 100)}% sold` : l.selling ? ' · selling' : ''}
            </div>
          );
        })}
        {BigInt(p.moonBagTokens) > 0n && (
          <div className="num rounded border border-dashed border-rule px-2 py-1 text-[12px] text-faint">moon bag {fmtTokens(p.moonBagTokens, d)} kept</div>
        )}
      </div>

      <div className="mt-2 text-[12px] text-faint">
        Sold <span className="num text-muted">{fmtTokens(p.soldTokens, d)}</span> of {fmtTokens(p.bagTokens, d)} {symbol} for{' '}
        <span className="num text-muted">{sol(p.proceedsLamports)}</span> in {p.sells} sell{p.sells === 1 ? '' : 's'}
        {p.highMcUsd != null && s.stopDropPct != null && <> · high since the first level {mc(p.highMcUsd)}</>} · {s.participationPct}% of buys, ≤
        {s.maxImpactPct}% per sell, min {usd(s.minSellUsd)}, slippage {s.slippagePct}%{s.stopDropPct != null ? `, stop −${s.stopDropPct}%` : ', no stop'}
      </div>

      {editing && <PlanModal plan={p} onClose={() => setEditing(false)} onDone={onChange} />}
      <Modal open={confirmEnd} onClose={() => setConfirmEnd(false)} title="End this plan?">
        <div className="flex flex-col gap-4">
          <p>
            The plan stops selling {symbol}. The tokens stay in {p.wallet?.label}; nothing is sold now. A new plan would start from what’s held then.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => act.mutate('cancel')} busy={act.isPending && act.variables === 'cancel'}>
              End plan
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── history ──────────────────────────────────────────────────────────────────

function HistoryPanel({ trades, closed }: { trades: Trade[]; closed: ClosedManual[] }) {
  const [tab, setTab] = useState<'trades' | 'closed'>('trades');
  return (
    <Panel
      title={tab === 'trades' ? `Manual trades · ${trades.length}` : `Closed positions · ${closed.length}`}
      flush
      action={
        <div className="flex rounded-md border border-rule p-0.5">
          {(
            [
              ['trades', 'Trades'],
              ['closed', 'Closed'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={cx('rounded px-2 py-0.5 text-[12px]', tab === k ? 'bg-panel-2 text-text' : 'text-muted')}>
              {label}
            </button>
          ))}
        </div>
      }
    >
      {tab === 'trades' ? <TradesTable rows={trades} /> : <ClosedTable rows={closed} />}
    </Panel>
  );
}

function TradesTable({ rows }: { rows: Trade[] }) {
  if (!rows.length) return <Empty title="No manual trades yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px]">
        <thead className="border-b border-rule">
          <tr>
            <th className={th}>Time</th>
            <th className={th}>Wallet</th>
            <th className={th}>Side</th>
            <th className={th}>Token</th>
            <th className={cx(th, 'text-right')}>Amount</th>
            <th className={cx(th, 'text-right')}>MC</th>
            <th className={cx(th, 'text-right')}>Profit</th>
            <th className={th}>Result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((t) => (
            <tr key={t.id} className={t.status !== 'confirmed' ? 'opacity-75' : ''}>
              <td className={cx(td, 'num text-[12px] whitespace-nowrap text-muted')}>{dateTime(t.createdAt)}</td>
              <td className={td}>
                <span className="font-medium">{t.wallet?.label ?? '—'}</span> {t.paper && <Badge>paper</Badge>}
              </td>
              <td className={td}>
                <Badge tone={t.side === 'buy' ? 'gain' : 'loss'}>{t.side.toUpperCase()}</Badge>
              </td>
              <td className={td}>
                <TokenCell token={t.token} compact />
              </td>
              <td className={cx(td, 'num text-right')}>{sol(t.solLamports)}</td>
              <td className={cx(td, 'num text-right')}>{mc(t.marketCapUsd)}</td>
              <td className={cx(td, 'num text-right', tone(t.realizedLamports))}>{t.side === 'sell' ? signedSol(t.realizedLamports) : ''}</td>
              <td className={cx(td, 'text-[12px]')}>
                {t.status === 'confirmed' ? (
                  t.signature && !t.paper ? (
                    <ExtLink href={links.tx(t.signature)} className="text-gain">
                      done ↗
                    </ExtLink>
                  ) : (
                    <span className="text-gain">done</span>
                  )
                ) : t.status === 'failed' ? (
                  <span className="text-loss">failed · {t.error}</span>
                ) : t.status === 'skipped' ? (
                  <span className="text-muted">skipped · {t.skipReason}</span>
                ) : (
                  <span className="text-warn">{t.status}…</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClosedTable({ rows }: { rows: ClosedManual[] }) {
  if (!rows.length) return <Empty title="No closed manual positions yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px]">
        <thead className="border-b border-rule">
          <tr>
            <th className={th}>Closed</th>
            <th className={th}>Wallet</th>
            <th className={th}>Token</th>
            <th className={cx(th, 'text-right')}>Put in</th>
            <th className={cx(th, 'text-right')}>Got out</th>
            <th className={cx(th, 'text-right')}>Profit</th>
            <th className={cx(th, 'text-right')}>Entry → exit MC</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((l) => (
            <tr key={l.id}>
              <td className={cx(td, 'num text-[12px] whitespace-nowrap text-muted')}>{dateTime(l.closedAt)}</td>
              <td className={td}>
                <span className="font-medium">{l.wallet?.label ?? '—'}</span> {l.paper && <Badge>paper</Badge>}
              </td>
              <td className={td}>
                <TokenCell token={l.token} compact />
                {l.note && <div className="text-[11px] text-faint">{l.note}</div>}
              </td>
              <td className={cx(td, 'num text-right')}>{sol(l.investedLamports)}</td>
              <td className={cx(td, 'num text-right')}>{sol(l.proceedsLamports)}</td>
              <td className={cx(td, 'num text-right', tone(l.realizedLamports))}>
                {signedSol(l.realizedLamports)}
                {l.investedLamports > 0 && <span className="ml-1 text-[0.85em] opacity-80">{signedPct(l.realizedLamports / l.investedLamports)}</span>}
              </td>
              <td className={cx(td, 'num text-right whitespace-nowrap')}>
                {mc(l.entryMcUsd)} <span className="text-faint">→</span> {mc(l.exitMcUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── wallets ──────────────────────────────────────────────────────────────────

function WalletsPanel({ wallets, onChange }: { wallets: ManualWallet[]; onChange: () => Promise<void> }) {
  const [adding, setAdding] = useState<'generate' | 'import' | null>(null);
  const [exporting, setExporting] = useState<ManualWallet | null>(null);
  const [removing, setRemoving] = useState<ManualWallet | null>(null);
  const removed = useQuery({ queryKey: ['manual-removed-wallets'], queryFn: () => api<RemovedWallet[]>('/manual/wallets/removed') });
  const [showRemoved, setShowRemoved] = useState(false);
  const [exportingRemoved, setExportingRemoved] = useState<RemovedWallet | null>(null);
  const [deleting, setDeleting] = useState<RemovedWallet | null>(null);
  return (
    <Panel
      title="Wallets"
      flush
      action={
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setAdding('import')}>
            Import
          </Button>
          <Button size="sm" onClick={() => setAdding('generate')}>
            Generate
          </Button>
        </div>
      }
    >
      {wallets.length === 0 ? (
        <Empty title="No wallets yet">Generate a fresh wallet (recommended) or import one, then send it some SOL.</Empty>
      ) : (
        <ul className="divide-y divide-rule">
          {wallets.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate font-medium">{w.label}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                  <Address value={w.pubkey} />
                  {w.copyGroup && <span className="text-warn">copy wallet · {w.copyGroup}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="text-right">
                  <div className="num">{sol(w.solLamports)}</div>
                  <div className="text-[11px] text-faint">on-chain</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setExporting(w)} title="Show the private key (to import into Phantom or withdraw)">
                  Key
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(w)} title="Remove this wallet from manual trading">
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {Boolean(removed.data?.length) && (
        <div className="border-t border-rule px-4 py-2.5">
          <button type="button" onClick={() => setShowRemoved(!showRemoved)} className="text-[12px] text-muted hover:text-text">
            {showRemoved ? '▾' : '▸'} Removed wallets ({removed.data!.length}) – keys still stored
          </button>
          {showRemoved && (
            <ul className="mt-2 flex flex-col gap-2">
              {removed.data!.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-muted">{w.label}</div>
                    <div className="text-[12px] text-faint">
                      <Address value={w.pubkey} />
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setExportingRemoved(w)} title="Show the private key">
                      Key
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleting(w)} title="Delete the key from this laptop for good">
                      Delete…
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {adding && <AddWalletModal mode={adding} onClose={() => setAdding(null)} onDone={onChange} />}
      {exporting && <ExportModal w={exporting} onClose={() => setExporting(null)} />}
      {exportingRemoved && <ExportModal w={exportingRemoved} onClose={() => setExportingRemoved(null)} />}
      {deleting && <DeleteKeyModal w={deleting} onClose={() => setDeleting(null)} onDone={onChange} />}
      {removing && <RemoveModal w={removing} onClose={() => setRemoving(null)} onDone={onChange} />}
    </Panel>
  );
}

function AddWalletModal({ mode, onClose, onDone }: { mode: 'generate' | 'import'; onClose: () => void; onDone: () => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const add = useMutation({
    mutationFn: () => api<{ label: string }>(`/manual/wallets/${mode}`, { body: mode === 'generate' ? { label } : { label, secret } }),
    onSuccess: async (w) => {
      toast(`Wallet “${w.label}” ${mode === 'generate' ? 'generated' : 'imported'}`);
      onClose();
      await onDone();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  return (
    <Modal open onClose={onClose} title={mode === 'generate' ? 'Generate a wallet' : 'Import a wallet'}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Name">
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. manual 1" />
        </Field>
        {mode === 'generate' ? (
          <div className="text-[12.5px] text-muted">A new, independent key is created here (no seed phrase, unrelated to your other wallets) and stored encrypted.</div>
        ) : (
          <Field label="Private key" hint="Base58 (Phantom export) or a JSON byte array. Stored encrypted; never shown again unless you export it.">
            <textarea rows={3} value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} className="num" />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!label.trim() || (mode === 'import' && secret.trim().length < 32)} busy={add.isPending}>
            {mode === 'generate' ? 'Generate' : 'Import'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ExportModal({ w, onClose }: { w: { id: number; label: string }; onClose: () => void }) {
  const [pass, setPass] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () => api<{ secret: string }>(`/manual/wallets/${w.id}/export`, { body: { passphrase: pass } }),
    onSuccess: (r) => setSecret(r.secret),
    onError: (e) => toast((e as Error).message, 'error'),
  });
  return (
    <Modal open onClose={onClose} title={`Private key · ${w.label}`}>
      {secret ? (
        <div className="flex flex-col gap-3">
          <div className="text-[12.5px] text-warn">Anyone with this key controls the wallet. Paste it only into Phantom (or another wallet you trust).</div>
          <div className="num flex items-start gap-2 rounded-md border border-rule bg-panel-2 p-3 text-[12px] break-all">
            <span className="flex-1">{secret}</span>
            <CopyButton value={secret} label="private key" />
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            reveal.mutate();
          }}
        >
          <Field label="Passphrase" hint="Asked again before showing a key.">
            <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!pass} busy={reveal.isPending}>
              Show key
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Hides the wallet from this tool; its key stays stored (encrypted), and importing it again restores it. */
function RemoveModal({ w, onClose, onDone }: { w: ManualWallet; onClose: () => void; onDone: () => Promise<void> }) {
  const remove = useMutation({
    mutationFn: () => api(`/manual/wallets/${w.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast(`“${w.label}” removed from manual trading`);
      onClose();
      await onDone();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  return (
    <Modal open onClose={onClose} title={`Remove ${w.label}?`}>
      <div className="flex flex-col gap-4">
        <p className="text-[13px]">
          {w.label} (<span className="num">{short(w.pubkey, 5)}</span>) disappears from this tool. Nothing changes on-chain: its {sol(w.solLamports)} and any
          tokens stay in the wallet.
        </p>
        <p className="text-[12.5px] text-muted">
          The key isn’t deleted – it stays encrypted in this data folder, so importing the wallet again brings it back. To delete it for good, use
          “Delete key…” under Removed wallets afterwards. Only possible when it has no open positions here.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => remove.mutate()} busy={remove.isPending}>
            Remove
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Deletes a removed wallet's key from this laptop for good. Shows what the wallet still holds first:
 * without a copy of the key saved elsewhere, that can never be moved again.
 */
function DeleteKeyModal({ w, onClose, onDone }: { w: RemovedWallet; onClose: () => void; onDone: () => Promise<void> }) {
  const [pass, setPass] = useState('');
  const [accept, setAccept] = useState(false);
  const funds = useQuery({
    queryKey: ['manual-funds', w.id],
    queryFn: () => api<{ solLamports: number; tokens: number; tokenAccounts: number }>(`/manual/wallets/${w.id}/funds`),
    staleTime: 0,
    retry: false,
  });
  const f = funds.data;
  const holdsSomething = f ? f.solLamports > 0 || f.tokenAccounts > 0 : false;
  const del = useMutation({
    mutationFn: () => api(`/manual/wallets/${w.id}/delete-key`, { body: { passphrase: pass, acceptLoss: accept } }),
    onSuccess: async () => {
      toast(`The key of “${w.label}” is deleted`);
      onClose();
      await onDone();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const ready = Boolean(f) && pass.length > 0 && (!holdsSomething || accept);
  return (
    <Modal open onClose={onClose} title={`Delete the key of ${w.label}?`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) del.mutate();
        }}
      >
        <p className="text-[13px]">
          The private key of {w.label} (<span className="num">{short(w.pubkey, 5)}</span>) is deleted from this laptop for good. Without a copy you saved yourself
          (Key), nothing in this wallet can ever be moved again. Its trade history here stays.
        </p>
        <div className={cx('rounded-md border px-3 py-2 text-[12.5px]', holdsSomething ? 'border-warn text-warn' : 'border-rule text-muted')}>
          {funds.isLoading
            ? 'Checking what the wallet holds…'
            : funds.error
              ? `Couldn’t check the wallet: ${(funds.error as Error).message}`
              : holdsSomething
                ? `It still holds ${sol(f!.solLamports)}${f!.tokens ? ` and ${f!.tokens} token${f!.tokens === 1 ? '' : 's'}` : ''}${
                    f!.tokenAccounts ? ` (${f!.tokenAccounts} token account${f!.tokenAccounts === 1 ? '' : 's'}, each holding ~0.002 SOL rent)` : ''
                  }. Move it out or save the key first.`
                : 'It’s empty: no SOL and no token accounts.'}
        </div>
        {holdsSomething && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />I saved the key, or I accept losing what’s in it
          </label>
        )}
        <Field label="Passphrase">
          <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!ready} busy={del.isPending}>
            Delete key
          </Button>
        </div>
      </form>
    </Modal>
  );
}
