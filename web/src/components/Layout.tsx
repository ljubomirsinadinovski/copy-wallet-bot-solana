import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type HeliusUsage, type Status } from '../lib/api';
import { ago, setSolUsd, sol } from '../lib/format';
import { useLiveConnected } from '../lib/live';
import { refreshHeader } from '../lib/onDemand';
import { Button, cx, Field, Modal, toast } from './ui';

/** Two strokes meeting in the middle: the trader's move (amber) and yours (cyan). */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M5 23 L11.5 9 L16 18.5" stroke="var(--them)" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 18.5 L20.5 9 L27 23" stroke="var(--you)" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV = [
  ['/', 'Dashboard'],
  ['/positions', 'Positions'],
  ['/traders', 'Traders'],
  ['/wallets', 'My wallets'],
  ['/trades', 'Trades'],
  ['/backtest', 'Backtest'],
  ['/logs', 'Logs'],
  ['/settings', 'Settings'],
] as const;

/** Real credits used on your Helius project this billing cycle (read when a page opens or on Refresh). */
export function useHeliusUsage() {
  return useQuery({ queryKey: ['helius-usage'], queryFn: () => api<HeliusUsage>('/helius-usage'), retry: false, staleTime: 10_000 });
}

export function UsageBar({ used, limit, wide }: { used: number; limit: number; wide?: boolean }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <span className={cx('inline-block h-1.5 overflow-hidden rounded-full bg-panel-2', wide ? 'w-full' : 'w-16')}>
      <span className={cx('block h-full', share > 0.85 ? 'bg-loss' : share > 0.6 ? 'bg-warn' : 'bg-you')} style={{ width: `${share * 100}%` }} />
    </span>
  );
}

/** Bot status for the header: loaded when a page opens, on Refresh, and when the server pushes a change. */
export function useStatus() {
  // Fresh for 10 s, so pages showing it don't each reload it again right after a page opens.
  return useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/status'), staleTime: 10_000 });
}

function StatusItem({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="eyebrow !text-[9.5px]">{label}</span>
      <span className="num flex items-center gap-1.5 text-[12.5px] whitespace-nowrap">{children}</span>
    </div>
  );
}

function Dot({ on, warn }: { on: boolean; warn?: boolean }) {
  return <span className={cx('inline-block h-2 w-2 rounded-full', on ? (warn ? 'bg-warn' : 'live-dot bg-gain') : 'bg-loss')} />;
}

export function UnlockModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [pass, setPass] = useState('');
  const m = useMutation({
    mutationFn: () => api('/auth/unlock', { body: { passphrase: pass } }),
    onSuccess: () => {
      toast('Wallets unlocked – the bot can sign trades');
      setPass('');
      onClose();
      void qc.invalidateQueries();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="Unlock wallets">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <p className="text-muted">The bot restarted, so your wallet keys are locked again. Enter your passphrase to let it sign live trades.</p>
        <Field label="Passphrase">
          <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        {m.error && <div className="text-loss">{(m.error as Error).message}</div>}
        <Button variant="primary" type="submit" busy={m.isPending}>
          Unlock
        </Button>
      </form>
    </Modal>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data: s } = useStatus();
  setSolUsd(s?.solUsd ?? null);
  const wsUp = useLiveConnected();
  const [unlockOpen, setUnlockOpen] = useState(false);

  // The header reloads whenever you open a page (the first one loads it anyway).
  const { pathname } = useLocation();
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    void refreshHeader(qc);
  }, [pathname, qc]);

  const pause = useMutation({
    mutationFn: (paused: boolean) => api(paused ? '/engine/pause' : '/engine/resume', { body: {} }),
    onSuccess: (_d, paused) => {
      toast(paused ? 'All trading paused' : 'Trading resumed');
      void qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const streamOk = Boolean(s?.stream.connected);
  const { data: hu } = useHeliusUsage();
  const credits = hu?.used ?? s?.usage.credits ?? 0;
  const allowance = hu?.limit ?? (s?.heliusTier === 'developer' ? 10_000_000 : 1_000_000);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-rule bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Mark />
            <span className="font-display text-xl font-bold tracking-tight">copy-wallet</span>
          </div>

          {s && (
            <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-2">
              <StatusItem
                label="Watching"
                title={s.stream.error ?? (s.stream.lastMessageAt ? `last message ${ago(s.stream.lastMessageAt)} ago` : '')}
              >
                <Dot on={streamOk} />
                {s.stream.kind === 'disabled' ? 'off – no Helius key' : `${s.stream.wallets} wallets · ${s.heliusTier}`}
              </StatusItem>
              <StatusItem label="Trading">
                {s.paused ? (
                  <span className="text-loss">paused</span>
                ) : s.liveTrading ? (
                  <span className="text-warn">live enabled</span>
                ) : (
                  <span className="text-muted">paper only</span>
                )}
              </StatusItem>
              <StatusItem label="Wallet keys">
                {s.unlocked ? (
                  <span className="text-muted">unlocked</span>
                ) : (
                  <button className="text-warn underline decoration-dotted underline-offset-2" onClick={() => setUnlockOpen(true)}>
                    locked – unlock
                  </button>
                )}
              </StatusItem>
              <StatusItem
                label="Balance · all wallets"
                title={`On-chain ${sol(s.balance.liveLamports)} + paper ${sol(s.balance.paperLamports)}${s.balance.unknownWallets ? ` · ${s.balance.unknownWallets} wallet(s) not read yet` : ''}. Cash only – open positions are on the Dashboard.`}
              >
                {sol(s.balance.totalLamports)}
              </StatusItem>
              <StatusItem label="SOL price">{s.solUsd ? `$${s.solUsd.toFixed(2)}` : '—'}</StatusItem>
              <StatusItem
                label="Helius credits"
                title={hu ? `Used this billing cycle (${hu.cycleStart} → ${hu.cycleEnd}), ${hu.plan ?? ''} plan` : 'Estimated – set HELIUS_PROJECT_ID for real numbers'}
              >
                <UsageBar used={credits} limit={allowance} />
                {(credits / 1000).toFixed(0)}k <span className="text-faint">/ {(allowance / 1e6).toFixed(allowance % 1e6 ? 1 : 0)}M</span>
              </StatusItem>
              {!wsUp && <StatusItem label="Page">reconnecting…</StatusItem>}
            </div>
          )}

          {s && (
            <Button variant={s.paused ? 'you' : 'danger'} onClick={() => pause.mutate(!s.paused)} busy={pause.isPending} className="ml-auto">
              {s.paused ? 'Resume trading' : 'Pause all trading'}
            </Button>
          )}
        </div>
        <nav className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-3" aria-label="Main">
          {NAV.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cx('border-b-2 px-2.5 py-2 text-[13px] font-medium whitespace-nowrap', isActive ? 'border-you text-text' : 'border-transparent text-muted hover:text-text')
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      {s && <Banners s={s} onUnlock={() => setUnlockOpen(true)} />}
      {/* Re-render pages once the SOL price is known, so every amount switches to dollars. */}
      <main key={s?.solUsd ? 'usd' : 'sol'} className="mx-auto max-w-[1400px] px-4 py-5">
        {children}
      </main>
      <UnlockModal open={unlockOpen} onClose={() => setUnlockOpen(false)} />
    </div>
  );
}

function Banners({ s, onUnlock }: { s: Status; onUnlock: () => void }) {
  const items: Array<{ tone: 'loss' | 'warn' | 'muted'; text: ReactNode }> = [];
  if (s.paused) items.push({ tone: 'loss', text: `Trading is paused${s.pausedReason ? ` – ${s.pausedReason}` : ''}. Sells are not followed while paused; use Positions to close manually.` });
  if (!s.heliusKey) items.push({ tone: 'warn', text: 'Add HELIUS_API_KEY to .env to start watching wallets.' });
  if (!s.jupiterKey) items.push({ tone: 'muted', text: 'No JUPITER_API_KEY set – quotes and swaps use keyless access with tighter limits. A free key from portal.jup.ag is recommended.' });
  if (s.liveTrading && !s.unlocked)
    items.push({
      tone: 'warn',
      text: (
        <>
          Live trading is on but your wallet keys are locked, so live groups can’t trade.{' '}
          <button className="underline" onClick={onUnlock}>
            Unlock now
          </button>
        </>
      ),
    });
  if (!items.length) return null;
  return (
    <div className="mx-auto mt-4 flex max-w-[1400px] flex-col gap-2 px-4">
      {items.map((b, i) => (
        <div key={i} className={cx('rounded-md border px-3.5 py-2 text-[13px]', b.tone === 'loss' ? 'border-loss/40 text-loss' : b.tone === 'warn' ? 'border-warn/40 text-warn' : 'border-rule text-muted')}>
          {b.text}
        </div>
      ))}
    </div>
  );
}
