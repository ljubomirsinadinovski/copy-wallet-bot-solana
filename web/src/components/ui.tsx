import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { TokenRef } from '../lib/api';
import { links, short, signedPct, signedSol, tone } from '../lib/format';

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'default' | 'primary' | 'danger' | 'ghost' | 'you';

export function Button({
  variant = 'default',
  size = 'md',
  busy,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    default: 'border-rule bg-panel-2 hover:border-faint text-text',
    primary: 'border-transparent bg-text text-bg hover:opacity-90',
    you: 'border-you/40 bg-you-soft text-you hover:border-you',
    danger: 'border-loss/40 text-loss hover:bg-loss/10',
    ghost: 'border-transparent text-muted hover:text-text',
  };
  return (
    <button
      // An HTML button submits its form unless told otherwise: Enter in a field would "click" the
      // first one – often Cancel. Only buttons marked type="submit" submit.
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5',
        styles[variant],
        className,
      )}
    >
      {busy ? <span className="num text-xs">…</span> : null}
      {children}
    </button>
  );
}

export function Panel({ title, action, children, className, flush }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cx('rounded-lg border border-rule bg-panel', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
          <h2 className="eyebrow">{title}</h2>
          {action}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

export function Badge({ children, tone: t = 'muted', title }: { children: ReactNode; tone?: 'muted' | 'you' | 'them' | 'gain' | 'loss' | 'warn'; title?: string }) {
  const map = {
    muted: 'border-rule text-muted',
    you: 'border-you/40 text-you',
    them: 'border-them/40 text-them',
    gain: 'border-gain/40 text-gain',
    loss: 'border-loss/40 text-loss',
    warn: 'border-warn/50 text-warn',
  };
  return (
    <span title={title} className={cx('num inline-flex h-5 items-center rounded border px-1.5 text-[10.5px] font-medium tracking-wide uppercase', map[t])}>
      {children}
    </span>
  );
}

const ROUTES: Record<string, string> = { pumpfun: 'pump.fun direct', pumpswap: 'PumpSwap direct', jupiter: 'Jupiter' };

/** How a trade was executed. Direct routes skip Jupiter and are sent via Helius Sender. */
export function RouteBadge({ route }: { route: string | null }) {
  if (!route) return null;
  const r = route.replace(/^paper:/, '');
  return (
    <Badge tone={r === 'jupiter' ? 'muted' : 'you'} title={r === 'jupiter' ? 'Routed through Jupiter' : 'Built locally and sent via Helius Sender – no aggregator'}>
      {ROUTES[r] ?? r}
    </Badge>
  );
}

const VENUES: Record<string, string> = { pumpfun: 'pump.fun', pumpswap: 'PumpSwap', dex: 'DEX' };

/** Where the trader traded – read from their transaction. */
export function VenueTag({ venue }: { venue: string | null | undefined }) {
  if (!venue) return null;
  return <span className="num rounded border border-them/30 px-1 text-[10px] text-them/90 uppercase">{VENUES[venue] ?? venue}</span>;
}

export function ModeBadge({ paper }: { paper: boolean }) {
  return paper ? <Badge>paper</Badge> : <Badge tone="warn">live</Badge>;
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${label ?? value}`}
      aria-label={`Copy ${label ?? 'value'}`}
      className="text-faint hover:text-text"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5" /></svg>
      )}
    </button>
  );
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx('hover:text-text hover:underline', className)}>
      {children}
    </a>
  );
}

/** Token symbol + contract address (copyable) + Solscan / DexScreener links. */
export function TokenCell({ token, compact }: { token: TokenRef; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center">
      <div className="min-w-0">
        <div className="truncate font-medium">{token.symbol ?? 'Unknown'}</div>
        {!compact && (
          <div className="num flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted">
            <span title={token.mint}>{short(token.mint, 4)}</span>
            <CopyButton value={token.mint} label="contract address" />
            <ExtLink href={links.token(token.mint)}>scan</ExtLink>
            <ExtLink href={links.chart(token.mint)}>chart</ExtLink>
          </div>
        )}
      </div>
    </div>
  );
}

export function Address({ value, label }: { value: string; label?: string }) {
  return (
    <span className="num inline-flex items-center gap-1.5 text-[12px]">
      <ExtLink href={links.account(value)} className="text-muted">
        {label ?? short(value, 5)}
      </ExtLink>
      <CopyButton value={value} label="address" />
    </span>
  );
}

export function Pnl({ lamports, pctValue, big }: { lamports: number | null | undefined; pctValue?: number | null; big?: boolean }) {
  return (
    <span className={cx('num', tone(lamports), big && 'text-lg font-medium')}>
      {signedSol(lamports)}
      {pctValue !== undefined && <span className="ml-1.5 text-[0.85em] opacity-80">{signedPct(pctValue)}</span>}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="font-display text-base font-semibold">{title}</div>
      {children && <div className="max-w-md text-muted">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-snug text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40', checked ? 'border-you bg-you-soft' : 'border-rule bg-panel-2')}
    >
      <span className={cx('absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all', checked ? 'left-[18px] bg-you' : 'left-0.5 bg-faint')} />
    </button>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose on every render; keep the latest without re-running the effect below.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    // Once, when the dialog opens: focus its first field (never the ✕), unless a field already has
    // focus (autoFocus). Re-focusing on later renders would pull the cursor out of what you're typing in.
    if (!ref.current?.contains(document.activeElement)) body.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-6" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx('max-h-[90vh] w-full overflow-auto rounded-t-xl border border-rule bg-panel p-5 sm:rounded-xl', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button type="button" className="text-muted hover:text-text" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div ref={body}>{children}</div>
      </div>
    </div>
  );
}

// ── toasts ────────────────────────────────────────────────────────────────
type Toast = { id: number; text: string; kind: 'ok' | 'error' };
let toasts: Toast[] = [];
let nextId = 1;
const toastListeners = new Set<() => void>();
const notify = () => toastListeners.forEach((l) => l());

export function toast(text: string, kind: Toast['kind'] = 'ok') {
  const t = { id: nextId++, text, kind };
  toasts = [...toasts, t];
  notify();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    notify();
  }, kind === 'error' ? 7000 : 3500);
}

export function Toasts() {
  const list = useSyncExternalStore(
    (cb) => {
      toastListeners.add(cb);
      return () => toastListeners.delete(cb);
    },
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 left-4 z-[60] flex flex-col items-end gap-2" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={cx('pointer-events-auto max-w-sm rounded-md border bg-panel px-3.5 py-2.5 shadow-lg', t.kind === 'error' ? 'border-loss/50 text-loss' : 'border-rule')}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
