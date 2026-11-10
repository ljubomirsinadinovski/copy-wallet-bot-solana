const LAMPORTS = 1_000_000_000;

/** SOL/USD from the server; when known, every SOL amount on the site is shown in dollars. */
let SOL_USD: number | null = null;
export const setSolUsd = (v: number | null) => {
  if (v) SOL_USD = v;
};

export function sol(lamports: number | null | undefined, digits = 4): string {
  if (lamports == null) return '—';
  if (SOL_USD) return usd((lamports / LAMPORTS) * SOL_USD);
  const v = lamports / LAMPORTS;
  return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
}

export const solPrice = () => SOL_USD;

/** A SOL amount as a dollar value for an input field ("" while the SOL price is unknown). */
export const usdInput = (solAmount: number, digits = 2) => (SOL_USD ? String(Number((solAmount * SOL_USD).toFixed(digits))) : '');

/** Dollars typed into a field → SOL (settings are stored in SOL because trades run in SOL). */
export function usdToSol(usdAmount: number): number {
  if (!SOL_USD) throw new Error('SOL price not known yet – try again in a moment');
  return usdAmount / SOL_USD;
}

/** "≈ $12.34" for a SOL amount typed into a field (empty while the SOL price is unknown). */
export const approxUsd = (solAmount: number) => (SOL_USD && Number.isFinite(solAmount) ? `≈ ${usd(solAmount * SOL_USD)}` : '');

export function signedSol(lamports: number | null | undefined, digits = 4): string {
  if (lamports == null) return '—';
  return `${lamports > 0 ? '+' : lamports < 0 ? '−' : ''}${sol(Math.abs(lamports), digits)}`;
}

export function usd(v: number | null | undefined): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  if (a >= 1) return `${s}$${a.toFixed(2)}`;
  return `${s}$${a.toPrecision(2)}`;
}

/** Market cap, compact: $42.1k */
export const mc = (v: number | null | undefined) => (v == null ? '—' : usd(v));

export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function signedPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(1)}%`;
}

export function tokens(raw: string | null | undefined, decimals: number | null | undefined): string {
  if (raw == null || decimals == null) return '—';
  const v = Number(BigInt(raw)) / 10 ** decimals;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function clock(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

export function dateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clock(ms) : `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${clock(ms)}`;
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export const short = (a: string | null | undefined, n = 4) => (!a ? '—' : a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);

export const links = {
  token: (mint: string) => `https://solscan.io/token/${mint}`,
  chart: (mint: string) => `https://dexscreener.com/solana/${mint}`,
  tx: (sig: string) => `https://solscan.io/tx/${sig}`,
  account: (a: string) => `https://solscan.io/account/${a}`,
};

export const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'text-muted' : v > 0 ? 'text-gain' : 'text-loss');
