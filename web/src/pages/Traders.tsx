import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type GroupRow, type WalletRow, type WatchedRow } from '../lib/api';
import { ago, mc, signedSol, sol, tokens, usd, usdInput, usdToSol } from '../lib/format';
import { Address, Badge, Button, cx, Empty, Field, ModeBadge, Modal, Panel, toast, Toggle } from '../components/ui';
import { useStatus } from '../components/Layout';
import { refreshHeader } from '../lib/onDemand';

function useAction<T>(fn: (v: T) => Promise<unknown>, ok?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (ok) toast(ok);
      void qc.invalidateQueries();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
}

function NewGroupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallets = useQuery({ queryKey: ['wallets'], queryFn: () => api<WalletRow[]>('/wallets'), enabled: open });
  const free = (wallets.data ?? []).filter((w) => !w.group);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [walletChoice, setWalletChoice] = useState<string>('new');
  const create = useAction(
    () =>
      api('/groups', {
        body: {
          name,
          mainAddress: address.trim() || undefined,
          mainLabel: label || 'main',
          myWalletId: walletChoice === 'new' ? undefined : Number(walletChoice),
        },
      }),
    'Trader added – copying in paper mode',
  );
  return (
    <Modal open={open} onClose={onClose} title="Copy a new trader">
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined, {
            onSuccess: () => {
              setName('');
              setAddress('');
              setLabel('');
              onClose();
            },
          });
        }}
      >
        <Field label="Name" hint="Anything that helps you recognise them, e.g. their fomo handle.">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. frank" required />
        </Field>
        <Field label="Main wallet address" hint="Optional now – you can add the main wallet, side wallets and bundlers afterwards.">
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Solana address" className="num" />
        </Field>
        <Field label="Your wallet for this trader" hint="Each trader gets their own wallet, so their % is applied to money meant only for them.">
          <select value={walletChoice} onChange={(e) => setWalletChoice(e.target.value)}>
            <option value="new">Generate a new wallet (recommended)</option>
            {free.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} · {w.pubkey.slice(0, 4)}…{w.pubkey.slice(-4)}
              </option>
            ))}
          </select>
        </Field>
        {address && (
          <Field label="Label for the main wallet">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="main" />
          </Field>
        )}
        {create.error && <div className="text-loss">{(create.error as Error).message}</div>}
        <p className="text-[12px] text-muted">New traders start in paper mode – trades are simulated at real prices until you switch them to live.</p>
        <Button variant="primary" type="submit" busy={create.isPending}>
          Add trader
        </Button>
      </form>
    </Modal>
  );
}

/** The group's settings, shown inside its card (one set for every wallet in the group). */
function SettingsPanel({ g, onClose }: { g: GroupRow; onClose: () => void }) {
  const { data: status } = useStatus();
  // Wallets this trader can copy into: its current one and any wallet no other trader uses.
  const walletList = useQuery({ queryKey: ['wallets'], queryFn: () => api<WalletRow[]>('/wallets') });
  const walletOptions = (walletList.data ?? []).filter((w) => !w.group || w.group.id === g.id);
  // Every amount is typed in dollars; SOL values are converted at the current SOL price.
  const [f, setF] = useState({
    ...g,
    slippage: g.slippageBps == null ? '' : String(g.slippageBps / 100),
    maxOpen: g.maxOpenPositions > 0 ? String(g.maxOpenPositions) : '',
    walletId: g.myWalletId,
    reserveUsd: usdInput(g.reserveSol),
    paperStartUsd: usdInput(g.paperStartSol),
    minCashUsd: usdInput(g.minSol),
    maxCashUsd: usdInput(g.maxSol),
    maxTokenCashUsd: usdInput(g.maxSolPerToken),
  });
  const [confirmLive, setConfirmLive] = useState(false);
  const save = useAction(
    () =>
      api(`/groups/${g.id}`, {
        method: 'PATCH',
        body: {
          name: f.name,
          paper: f.paper,
          myWalletId: f.walletId,
          paperStartSol: usdToSol(Number(f.paperStartUsd)),
          multiplier: Number(f.multiplier),
          minSol: usdToSol(Number(f.minCashUsd)),
          maxSol: usdToSol(Number(f.maxCashUsd)),
          maxPct: Number(f.maxPct),
          maxSolPerToken: usdToSol(Number(f.maxTokenCashUsd)),
          reserveSol: usdToSol(Number(f.reserveUsd)),
          slippageBps: f.slippage === '' ? null : Math.round(Number(f.slippage) * 100),
          skipIfHolding: f.skipIfHolding,
          maxOpenPositions: f.maxOpen.trim() === '' ? 0 : Math.max(0, Math.floor(Number(f.maxOpen))),
          sizingMode: f.sizingMode,
          copyPct: Number(f.copyPct),
          minUsd: Number(f.minUsd),
          maxUsdPerToken: Number(f.maxUsdPerToken),
        },
      }),
    'Settings saved',
  );
  const num = (k: keyof typeof f) => ({
    type: 'number' as const,
    step: 'any',
    min: 0,
    value: String(f[k] as number | string),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }),
    className: 'num',
  });
  return (
    <div className="border-t border-rule bg-bg/40 px-4 py-4">
      <div className="eyebrow mb-3">Settings · same for every wallet in this group</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!f.paper && g.paper && !confirmLive) return setConfirmLive(true);
          save.mutate(undefined, { onSuccess: onClose });
        }}
        className="flex flex-col gap-5"
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field
            label="Your wallet for this trader"
            hint={f.walletId !== g.myWalletId ? 'Trades will be copied from this wallet after you save. Past trades stay with the old wallet.' : 'Only wallets no other trader uses are listed.'}
          >
            <select value={f.walletId} onChange={(e) => setF({ ...f, walletId: Number(e.target.value) })}>
              {walletOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label} · {w.pubkey.slice(0, 4)}…{w.pubkey.slice(-4)}
                  {w.solLamports != null ? ` · ${sol(w.solLamports)}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Mode"
            hint={!f.paper && !status?.liveTrading ? 'LIVE_TRADING is off in .env – live trades will be skipped until you turn it on.' : 'Paper simulates trades at real quotes.'}
          >
            <select value={f.paper ? 'paper' : 'live'} onChange={(e) => setF({ ...f, paper: e.target.value === 'paper' })}>
              <option value="paper">Paper – simulated</option>
              <option value="live">Live – real SOL</option>
            </select>
          </Field>
        </div>

        <Field
          label="Sizing"
          hint={
            f.sizingMode === 'size'
              ? 'Every buy and add is the same % of the dollars they spend, so your position has their shape, just smaller.'
              : 'You spend the same % of your balance as they spent of their cash (SOL + USDC + USDT + USD1).'
          }
        >
          <select value={f.sizingMode} onChange={(e) => setF({ ...f, sizingMode: e.target.value as GroupRow['sizingMode'] })}>
            <option value="size">Copy a % of their trade size (recommended)</option>
            <option value="cash">Copy the % of their cash they spent</option>
          </select>
        </Field>

        {f.sizingMode === 'size' ? (
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="eyebrow mb-3">Trade size</legend>
            <Field label="Copy % of their size" hint={`They buy $100 → you buy ${'$'}${(Number(f.copyPct) || 0).toFixed(2).replace(/\.00$/, '')}.`}>
              <input {...num('copyPct')} />
            </Field>
            <Field label="Minimum per buy ($)" hint="Smaller copies are raised to this, so tiny buys aren't eaten by fees.">
              <input {...num('minUsd')} />
            </Field>
            <Field label="Max per token ($)" hint="Total across their buys and adds. Adds keep copying until this is full.">
              <input {...num('maxUsdPerToken')} />
            </Field>
            <Field label="Max % of your balance per buy" hint="When you can't afford the full copy, at most this share of your balance is used, so one bet can't empty the wallet.">
              <input {...num('maxPct')} max={100} />
            </Field>
            <Field label="Reserve ($)" hint="Never spent – keeps network fees covered.">
              <input {...num('reserveUsd')} />
            </Field>
          </fieldset>
        ) : (
        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="eyebrow mb-3">Trade size</legend>
          <Field label="Multiplier" hint="1 = same % as the trader. 0.5 = half.">
            <input {...num('multiplier')} />
          </Field>
          <Field label="Max % of wallet per trade" hint="Caps bundler wallets that go all-in.">
            <input {...num('maxPct')} max={100} />
          </Field>
          <Field label="Reserve ($)" hint="Never spent – keeps network fees covered.">
            <input {...num('reserveUsd')} />
          </Field>
          <Field label="Min per trade ($)" hint="Smaller copies are skipped – fees would eat them.">
            <input {...num('minCashUsd')} />
          </Field>
          <Field label="Max per trade ($)">
            <input {...num('maxCashUsd')} />
          </Field>
          <Field label="Max per token ($)" hint="Total across repeat buys.">
            <input {...num('maxTokenCashUsd')} />
          </Field>
        </fieldset>
        )}

        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="eyebrow mb-3">Execution & limits</legend>
          <Field label="Slippage %" hint="Empty = Jupiter picks automatically. Sells widen it on retry.">
            <input type="number" step="any" min={0.1} max={100} value={f.slippage} onChange={(e) => setF({ ...f, slippage: e.target.value })} placeholder="auto" className="num" />
          </Field>
          <Field label="Max open positions" hint="Empty = no limit.">
            <input type="number" step={1} min={0} value={f.maxOpen} onChange={(e) => setF({ ...f, maxOpen: e.target.value })} placeholder="no limit" className="num" />
          </Field>
          {f.paper && (
            <Field label="Paper money to start with ($)" hint="Virtual balance for paper mode. Changing it shifts the paper balance by the same amount.">
              <input {...num('paperStartUsd')} />
            </Field>
          )}
        </fieldset>

        <label className="flex items-start gap-3">
          <Toggle checked={f.skipIfHolding} onChange={(v) => setF({ ...f, skipIfHolding: v })} label="Skip buys if already holding" />
          <span>
            <span className="font-medium">Skip buys of a token you already hold</span>
            <span className="block text-[12px] text-muted">
              Off = every buy is copied (exact mirroring). On = when a side wallet already got you in, the main wallet’s later buy of the same token is not copied.
            </span>
          </span>
        </label>

        {confirmLive && (
          <div className="rounded-md border border-warn/50 p-3 text-warn">
            Switching to live: from now on {g.name}’s trades are copied with real SOL from{' '}
            <b>{walletOptions.find((w) => w.id === f.walletId)?.label ?? g.wallet?.label}</b>. Press “Save” again to confirm.
          </div>
        )}
        {save.error && <div className="text-loss">{(save.error as Error).message}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" busy={save.isPending}>
            {confirmLive ? 'Save – go live' : 'Save'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Holding({ w }: { w: WatchedRow }) {
  if (!w.holding.length) return <span className="text-[12px] text-faint">no open positions seen</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {w.holding.slice(0, 8).map((h) => (
        <span key={h.token.mint} className="num inline-flex items-center gap-1.5 rounded border border-them/30 bg-them-soft px-2 py-0.5 text-[11.5px]" title={h.token.mint}>
          <span className="font-medium text-text">{h.token.symbol ?? h.token.mint.slice(0, 4)}</span>
          <span className="text-muted">{tokens(h.tokenAmount, h.decimals)}</span>
          {h.lastMcUsd != null && (
            <span className="text-muted">
              {mc(h.lastMcUsd)}
              {h.currentMcUsd != null ? ` → ${mc(h.currentMcUsd)}` : ''}
            </span>
          )}
        </span>
      ))}
      {w.holding.length > 8 && <span className="text-[11.5px] text-muted">+{w.holding.length - 8} more</span>}
    </div>
  );
}

type Cash = { solUsd: number | null; stablesUsd: Record<string, number>; totalUsd: number | null; at: number } | { error: string };

/** "Cash $1.2k · SOL $200 · USDC $1.0k" – what the wallet has to trade with. */
function CashLine({ cash }: { cash: Cash | undefined }) {
  if (!cash) return <span className="text-faint">cash: loading…</span>;
  if ('error' in cash) return <span className="text-warn" title={cash.error}>cash: couldn’t read</span>;
  const parts = [cash.solUsd != null ? `SOL ${usd(cash.solUsd)}` : null, ...Object.entries(cash.stablesUsd).map(([k, v]) => `${k} ${usd(v)}`)].filter(Boolean);
  return (
    <span title={`Read ${ago(cash.at)} ago`}>
      cash <span className="num text-text">{usd(cash.totalUsd)}</span>
      {parts.length ? <span className="num text-faint"> · {parts.join(' · ')}</span> : null}
    </span>
  );
}

function WatchedItem({ w, cash }: { w: WatchedRow; cash: Cash | undefined }) {
  const patch = useAction((body: Partial<WatchedRow>) => api(`/watched/${w.id}`, { method: 'PATCH', body }));
  const remove = useAction(() => api(`/watched/${w.id}`, { method: 'DELETE' }), 'Wallet removed');
  return (
    <li className={cx('grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_auto] lg:items-center', !w.enabled && 'opacity-55')}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{w.label || 'unnamed'}</span>
          <select
            aria-label="Role"
            value={w.role}
            onChange={(e) => patch.mutate({ role: e.target.value as WatchedRow['role'] })}
            className="!py-0.5 !text-[11.5px]"
          >
            <option value="main">main</option>
            <option value="side">side</option>
            <option value="bundler">bundler</option>
          </select>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
          <Address value={w.address} />
          <CashLine cash={cash} />
          <span>{w.signals24h} trades/24h</span>
          <span>last {ago(w.lastSignalAt)}</span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="eyebrow mb-1 !text-[9.5px]">holding now</div>
        <Holding w={w} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-[12px]">
          <Toggle checked={w.enabled} onChange={(v) => patch.mutate({ enabled: v })} label="Watch" /> watch
        </label>
        <label className="flex items-center gap-1.5 text-[12px]">
          <Toggle checked={w.copyBuys} onChange={(v) => patch.mutate({ copyBuys: v })} label="Copy buys" disabled={!w.enabled} /> buys
        </label>
        <label className="flex items-center gap-1.5 text-[12px]">
          <Toggle checked={w.copySells} onChange={(v) => patch.mutate({ copySells: v })} label="Copy sells" disabled={!w.enabled} /> sells
        </label>
        <Button size="sm" variant="ghost" onClick={() => confirm(`Stop watching ${w.label || w.address}?`) && remove.mutate(undefined)}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function AddWallet({ groupId }: { groupId: number }) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<'side' | 'bundler' | 'main'>('side');
  const add = useAction(() => api(`/groups/${groupId}/wallets`, { body: { address: address.trim(), label, role } }), 'Now watching this wallet');
  return (
    <form
      className="flex flex-wrap gap-2 border-t border-rule px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined, {
          onSuccess: () => {
            setAddress('');
            setLabel('');
          },
        });
      }}
    >
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Wallet address to watch" className="num min-w-[240px] flex-[2]" required aria-label="Wallet address" />
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" className="min-w-[120px] flex-1" aria-label="Label" />
      <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="Role">
        <option value="side">side wallet</option>
        <option value="bundler">bundler</option>
        <option value="main">main</option>
      </select>
      <Button type="submit" variant="you" busy={add.isPending}>
        Add wallet
      </Button>
    </form>
  );
}

function GroupCard({ g, cash }: { g: GroupRow; cash: Record<number, Cash> | undefined }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const totals = g.wallets.map((w) => cash?.[w.id]).map((c) => (c && !('error' in c) ? c.totalUsd : null));
  const groupCash = totals.some((t) => t != null) ? totals.reduce<number>((a, t) => a + (t ?? 0), 0) : null;
  const patch = useAction((body: Partial<GroupRow>) => api(`/groups/${g.id}`, { method: 'PATCH', body }));
  const closeAll = useAction(() => api(`/groups/${g.id}/close-all`, { body: {} }), 'Closing all positions');
  const remove = useAction(() => api(`/groups/${g.id}`, { method: 'DELETE' }), 'Trader removed');
  return (
    <Panel flush>
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="font-display text-lg font-semibold">{g.name}</h2>
            <ModeBadge paper={g.paper} />
            {!g.enabled && <Badge tone="warn">buys paused</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            {g.wallet && (
              <span className="flex items-center gap-1.5">
                copies into{' '}
                <Link to={`/wallets/${g.wallet.id}`} className="text-you hover:underline" title="Open this wallet’s positions and trades">
                  {g.wallet.label}
                </Link>{' '}
                <Address value={g.wallet.pubkey} />
              </span>
            )}
            <span className="num">{g.stats.trades} trades</span>
            <span className="num">
              realized <span className={g.stats.realizedLamports > 0 ? 'text-gain' : g.stats.realizedLamports < 0 ? 'text-loss' : ''}>{signedSol(g.stats.realizedLamports)}</span>
            </span>
            <Link to={`/wallets/${g.wallet?.id}`} className="num hover:text-text hover:underline">
              {g.stats.openPositions} open
            </Link>
          </div>
          {/* The sizing rules at a glance; click to change them. */}
          <button className="num mt-1.5 text-left text-[11.5px] text-faint hover:text-text" onClick={() => setSettingsOpen((v) => !v)}>
            {g.sizingMode === 'size'
              ? `Size: ${g.copyPct}% of their buy · min $${g.minUsd} · max $${g.maxUsdPerToken} per token · ≤${g.maxPct}% of balance per buy`
              : `Size: their % of cash × ${g.multiplier} · ≤${g.maxPct}% of balance per buy · max ${g.maxSolPerToken} SOL per token`}
          </button>
          {groupCash != null && (
            <div className="mt-1 text-[11.5px] text-muted">
              Trader’s cash across {g.wallets.length} wallet{g.wallets.length === 1 ? '' : 's'}: <span className="num text-text">{usd(groupCash)}</span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[12.5px]" title="When off, new buys are not copied but sells are still followed so you can exit.">
            <Toggle checked={g.enabled} onChange={(v) => patch.mutate({ enabled: v })} label="Copy new buys" />
            copy new buys
          </label>
          <Button size="sm" variant={settingsOpen ? 'you' : 'default'} onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}>
            Settings {settingsOpen ? '▴' : '▾'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={!g.stats.openPositions}
            onClick={() => confirm(`Sell 100% of every open position copied from ${g.name}?`) && closeAll.mutate(undefined)}
          >
            Close all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${g.name}? Its wallet and history stay.`) && remove.mutate(undefined)}>
            Remove
          </Button>
        </div>
      </div>
      {settingsOpen && <SettingsPanel g={g} onClose={() => setSettingsOpen(false)} />}
      {g.wallets.length ? (
        <ul className="divide-y divide-rule border-t border-rule">
          {g.wallets.map((w) => (
            <WatchedItem key={w.id} w={w} cash={cash?.[w.id]} />
          ))}
        </ul>
      ) : (
        <div className="border-t border-rule px-4 py-4 text-muted">Add the trader’s main wallet and any side wallets or bundlers they buy with first.</div>
      )}
      <AddWallet groupId={g.id} />
    </Panel>
  );
}

export function TradersPage() {
  const qc = useQueryClient();
  // Loads when the page opens and on Refresh; trades and signals update it over the live connection.
  const { data } = useQuery({ queryKey: ['groups'], queryFn: () => api<GroupRow[]>('/groups'), refetchOnMount: 'always' });
  // Watched wallets' cash: read when this page opens (cached 5 min on the server) or on Refresh.
  const cash = useQuery({ queryKey: ['watched-cash'], queryFn: () => api<Record<number, Cash>>('/watched/cash'), staleTime: 5 * 60_000 });
  const refresh = useMutation({
    mutationFn: async () => {
      const [fresh] = await Promise.all([
        api<Record<number, Cash>>('/watched/cash?refresh=1'),
        qc.refetchQueries({ queryKey: ['groups'], exact: true }),
        refreshHeader(qc),
      ]);
      qc.setQueryData(['watched-cash'], fresh);
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Traders you copy</h1>
          <p className="mt-1 max-w-2xl text-muted">
            Group a trader’s main wallet with the side wallets and bundlers they use. Every wallet’s buys and sells are mirrored on its own, into the
            group’s wallet.
          </p>
        </div>
        <div className="flex gap-2">
        <Button onClick={() => refresh.mutate()} busy={refresh.isPending} title="Reloads the traders, their wallets’ cash and the header">
          Refresh
        </Button>
        <Button variant="you" onClick={() => setOpen(true)}>
          Copy a new trader
        </Button>
        </div>
      </div>
      {data && data.length === 0 && (
        <Panel>
          <Empty title="You’re not copying anyone yet">Add a trader to start. They begin in paper mode, so you can watch how copying them would have gone before using real SOL.</Empty>
        </Panel>
      )}
      {data?.map((g) => <GroupCard key={g.id} g={g} cash={cash.data} />)}
      <NewGroupModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
