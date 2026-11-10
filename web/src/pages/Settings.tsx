import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type GlobalSettings, type SettingsResponse } from '../lib/api';
import { solPrice, usd, usdInput, usdToSol } from '../lib/format';
import { Badge, Button, Field, Panel, toast, Toggle } from '../components/ui';
import { UsageBar, useHeliusUsage } from '../components/Layout';

function EnvRow({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-rule py-2 first:border-t-0">
      <span className="text-muted" title={hint}>
        {label}
      </span>
      <span className="num text-right">{value}</span>
    </div>
  );
}

function PassphraseForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const m = useMutation({
    mutationFn: () => api('/auth/change-passphrase', { body: { current, next } }),
    onSuccess: () => {
      toast('Passphrase changed');
      setCurrent('');
      setNext('');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Current passphrase">
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Field>
      <Field label="New passphrase" hint="If KEYSTORE_PASSPHRASE is set in .env, update it too.">
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Field>
      <Button type="submit" busy={m.isPending} disabled={!current || !next}>
        Change passphrase
      </Button>
    </form>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/settings') });
  const { data: hu, error: usageErr } = useHeliusUsage();
  const [f, setF] = useState<GlobalSettings | null>(null);
  const [lists, setLists] = useState({ blacklist: '', extraQuoteMints: '' });
  // Amounts are typed in dollars and stored in SOL (converted at the current SOL price).
  const [money, setMoney] = useState<{ dailyLoss: string; paperFee: string; priority: string; tip: string } | null>(null);
  if (data && !money && solPrice()) {
    const g = data.global;
    setMoney({ dailyLoss: usdInput(g.dailyLossLimitSol), paperFee: usdInput(g.paperFeeSol, 4), priority: usdInput(g.priorityFeeSol, 4), tip: usdInput(g.tipSol, 4) });
  }
  useEffect(() => {
    if (data && !f) {
      setF(data.global);
      setLists({ blacklist: data.global.blacklist.join('\n'), extraQuoteMints: data.global.extraQuoteMints.join('\n') });
    }
  }, [data, f]);

  const testTg = useMutation({
    mutationFn: () => api('/telegram/test', { body: {} }),
    onSuccess: () => toast('Test message sent – check Telegram'),
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const save = useMutation({
    mutationFn: () => {
      const split = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      const { paused: _p, pausedReason: _r, ...rest } = f!;
      if (!money) throw new Error('SOL price not known yet – try again in a moment');
      return api('/settings', {
        method: 'PATCH',
        body: {
          ...rest,
          dailyLossLimitSol: usdToSol(Number(money.dailyLoss)),
          paperFeeSol: usdToSol(Number(money.paperFee)),
          priorityFeeSol: usdToSol(Number(money.priority)),
          tipSol: usdToSol(Number(money.tip)),
          blacklist: split(lists.blacklist),
          extraQuoteMints: split(lists.extraQuoteMints),
        },
      });
    },
    onSuccess: () => {
      toast('Settings saved – applied immediately');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  if (!data || !f) return null;
  const moneyInput = (k: 'dailyLoss' | 'paperFee' | 'priority' | 'tip') => (
    <input
      type="number"
      step="any"
      min={0}
      className="num"
      value={money?.[k] ?? ''}
      disabled={!money}
      placeholder={money ? '' : 'waiting for SOL price…'}
      onChange={(e) => money && setMoney({ ...money, [k]: e.target.value })}
    />
  );
  const price = solPrice() ?? 0;
  const minTipUsd = (f.senderRoute === 'max' ? 0.001 : 0.000005) * price;
  const tradeCostUsd = Number(money?.priority ?? 0) + Math.max(Number(money?.tip ?? 0), minTipUsd) + 0.000005 * price;
  const set = <K extends keyof GlobalSettings>(k: K, v: GlobalSettings[K]) => setF({ ...f, [k]: v });
  const numInput = (k: keyof GlobalSettings, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input type="number" step="any" className="num" value={String(f[k])} onChange={(e) => set(k, Number(e.target.value) as never)} {...props} />
  );
  const usage = data.usage;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="flex flex-col gap-5"
      >
        <Panel title="Safety">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ignore signals older than (seconds)" hint="Late copies buy at worse prices; after a reconnect, old trades are recorded but not copied.">
              {numInput('maxSignalAgeSec', { min: 1, max: 600 })}
            </Field>
            <Field label="Daily loss limit ($)" hint="Pauses all trading when today’s realized live loss reaches this. 0 = off.">
              {moneyInput('dailyLoss')}
            </Field>
            <Field label="Sell retries" hint="Extra attempts with wider slippage (25% → 40% → 60%) if a sell fails.">
              {numInput('sellRetries', { min: 0, max: 5, step: 1 })}
            </Field>
            <Field label="Simulated fee per paper trade ($)" hint="Network + priority fees a real trade would cost.">
              {moneyInput('paperFee')}
            </Field>
            <Field label="Max token transfer fee (%)" hint="Some tokens take a cut of every buy and sell (Token-2022 transfer fee). Higher fees are skipped. 0 = skip all of them.">
              {numInput('maxTransferFeePct', { min: 0, max: 100 })}
            </Field>
          </div>
          <div className="mt-5 flex flex-col gap-3.5">
            {(
              [
                ['skipFreezeAuthority', 'Skip tokens with a freeze authority', 'The creator could freeze your tokens so you can’t sell.'],
                ['skipMintAuthority', 'Skip tokens that can still be minted', 'The creator could print more and dump them on holders. pump.fun coins are never mintable.'],
                ['copyCreatorBuys', 'Copy dev launches', 'When a trader creates a token and buys it in the same transaction. Off: launches are a common way to dump on followers.'],
                ['verifyJupiterTx', 'Check Jupiter transactions before signing', `Simulates each Jupiter-built trade and refuses it if it would take more than the trade plus ~${usd(0.02 * price)} for fees. Direct pump.fun trades are built by the bot itself.`],
                ['skipRiskyToken2022', 'Skip risky Token-2022 tokens', 'Transfer hooks, permanent delegates, non-transferable or pausable tokens – they can stop you from selling. Transfer fees have their own limit above.'],
                ['closeEmptyAccounts', 'Reclaim rent after a full exit', `Closes the empty token account (~${usd(0.00204 * price)} back each time).`],
                ['prefilterLogs', 'Filter unrelated transactions (free tier)', 'Keeps swaps and token transfers so transfers out can trigger sells. Skips unrelated activity.'],
              ] as const
            ).map(([k, label, hint]) => (
              <label key={k} className="flex items-start gap-3">
                <Toggle checked={f[k]} onChange={(v) => set(k, v)} label={label} />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="block text-[12px] text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </Panel>

        <Panel title="Fast pump.fun trading">
          <label className="mb-4 flex items-start gap-3">
            <Toggle checked={f.directPumpTrades} onChange={(v) => set('directPumpTrades', v)} label="Trade pump.fun tokens directly" />
            <span>
              <span className="font-medium">Trade pump.fun tokens directly</span>
              <span className="block text-[12px] text-muted">
                When the trader bought on pump.fun or PumpSwap (seen in their own transaction – no extra lookup), the bot builds the trade itself
                and sends it via Helius Sender: no Jupiter round trip, no 1-request/second queue, no Jupiter fee. Anything it can’t do directly
                goes through Jupiter.
              </span>
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Sending route"
              hint={
                f.senderRoute === 'max'
                  ? `Every pathway incl. Jito – fastest landing, tip at least ${usd(0.001 * price)} per trade.`
                  : `Staked validator connections – tip at least ${usd(0.000005 * price)}. Cheapest; a good default.`
              }
            >
              <select value={f.senderRoute} onChange={(e) => set('senderRoute', e.target.value as GlobalSettings['senderRoute'])}>
                <option value="swqos">Staked connections (cheap)</option>
                <option value="max">Max – all pathways (fastest)</option>
              </select>
            </Field>
            <Field label="Slippage when on auto (%)" hint="Used for direct trades when a trader’s slippage is set to auto.">
              {numInput('pumpSlippagePct', { min: 0.5, max: 90 })}
            </Field>
            <Field label="Priority fee per trade ($)" hint={`Higher lands sooner when the network is busy. ${usd(0.0001 * price)}–${usd(0.001 * price)} is typical.`}>
              {moneyInput('priority')}
            </Field>
            <Field label="Tip per trade ($)" hint="Raised to the route’s minimum automatically.">
              {moneyInput('tip')}
            </Field>
          </div>
          <div className="num mt-4 text-[12.5px] text-muted">
            Each direct trade costs about <span className="text-text">{usd(tradeCostUsd)}</span> in fees (priority + tip + network), plus the pool’s own fee.
          </div>
        </Panel>

        <Panel
          title="Telegram"
          action={
            <Button
              size="sm"
              type="button"
              disabled={!data.env.telegram}
              busy={testTg.isPending}
              onClick={() => testTg.mutate()}
              title={data.env.telegram ? '' : 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env'}
            >
              Send test message
            </Button>
          }
        >
          {!data.env.telegram && <p className="mb-3 text-[12.5px] text-warn">Not set up – add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env.</p>}
          <div className="flex flex-col gap-3.5">
            {(
              [
                ['telegramTrades', 'Copied trades and failures', 'Every buy and sell on your wallets: who was copied, your $ vs theirs, market cap vs theirs, speed, profit – and every failed copy with the error.'],
                ['telegramSkips', 'Skipped copies', 'When a trader’s trade is not copied, with the reason (too small, budget full, risky token, keys locked…).'],
                ['telegramHealth', 'Problems and status', 'Bot started/stopped, connection to Helius lost, errors, trades that couldn’t be read, tokens moved away by a trader.'],
              ] as const
            ).map(([k, label, hint]) => (
              <label key={k} className="flex items-start gap-3">
                <Toggle checked={f[k]} onChange={(v) => set(k, v)} label={label} />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="block text-[12px] text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </Panel>

        <Panel title="Tokens">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Never buy these (one CA per line)">
              <textarea rows={4} className="num text-[12px]" value={lists.blacklist} onChange={(e) => setLists({ ...lists, blacklist: e.target.value })} />
            </Field>
            <Field
              label="Extra quote tokens (one CA per line)"
              hint="Besides SOL, USDC, USDT and USD1. If a trader pays with one of these, the buy is copied as the same share of your SOL. Some pump.fun pools trade against other tokens."
            >
              <textarea rows={4} className="num text-[12px]" value={lists.extraQuoteMints} onChange={(e) => setLists({ ...lists, extraQuoteMints: e.target.value })} />
            </Field>
            <Field label="Price freshness (seconds)" hint="Prices are only fetched while Dashboard or Positions is open, and at most this often. Nothing is fetched when you aren't looking.">
              {numInput('priceRefreshSec', { min: 5, max: 300 })}
            </Field>
          </div>
        </Panel>

        <div className="flex justify-end">
          <Button variant="primary" type="submit" busy={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-5">
        <Panel title="From .env (restart to change)">
          <EnvRow label="Helius plan" value={data.env.heliusTier} />
          <EnvRow label="Helius key" value={data.env.heliusKey ? 'set' : <span className="text-warn">missing</span>} />
          <EnvRow label="Jupiter key" value={data.env.jupiterKey ? 'set' : <span className="text-warn">missing</span>} />
          <EnvRow label="Live trading" value={data.env.liveTrading ? <Badge tone="warn">on</Badge> : <Badge>off</Badge>} />
          <EnvRow label="Auto-unlock" value={data.env.autoUnlock ? 'on' : 'off'} hint="KEYSTORE_PASSPHRASE" />
          <EnvRow label="RPC budget" value={`${data.env.rpcRps}/s`} />
          <EnvRow label="Jupiter budget" value={`${data.env.jupiterRps}/s`} />
          <EnvRow label="Log level" value={data.env.logLevel} />
          <EnvRow label="Sender" value={<span className="text-[11px] break-all">{data.env.senderUrl.replace(/^https?:\/\//, '')}</span>} hint="SENDER_URL" />
          <EnvRow label="Data folder" value={<span className="text-[11px] break-all">{data.env.dataDir}</span>} />
        </Panel>

        <Panel title="Helius usage">
          {hu ? (
            <>
              <div className="num text-2xl">
                {hu.used.toLocaleString()} <span className="text-base text-muted">/ {hu.limit.toLocaleString()} credits</span>
              </div>
              <div className="mt-2">
                <UsageBar used={hu.used} limit={hu.limit} wide />
              </div>
              <div className="mt-2 text-[12px] text-muted">
                Whole project, {hu.plan ?? ''} plan · {hu.remaining.toLocaleString()} left · cycle {hu.cycleStart} → {hu.cycleEnd}
              </div>
              {Object.entries(hu.breakdown)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => (
                  <EnvRow key={k} label={k} value={v.toLocaleString()} />
                ))}
            </>
          ) : (
            <div className="text-[12px] text-warn">{usageErr ? (usageErr as Error).message : 'Loading…'}</div>
          )}
          <div className="mt-4 border-t border-rule pt-3 text-[12px] text-muted">
            Of that, this bot counted about <span className="num text-text">{usage.credits.toLocaleString()}</span> credits in {usage.month}
            {' '}(WebSocket data {usage.wsMb.toFixed(2)} MB). The rest comes from other uses of the same Helius key.
          </div>
          <div className="mt-3">
            {Object.entries(usage.rpcCalls)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([m, n]) => (
                <EnvRow key={m} label={m} value={n.toLocaleString()} />
              ))}
          </div>
        </Panel>

        <Panel title="Passphrase">
          <PassphraseForm />
        </Panel>
      </div>
    </div>
  );
}
