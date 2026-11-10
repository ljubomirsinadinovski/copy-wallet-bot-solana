export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/unlock') window.dispatchEvent(new Event('auth-lost'));
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export interface TokenRef {
  mint: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  decimals: number | null;
}

export interface AuthStatus {
  setup: boolean;
  loggedIn: boolean;
  unlocked: boolean;
  minPassphrase: number;
}

export interface Status {
  balance: { paperLamports: number; liveLamports: number; totalLamports: number; unknownWallets: number };
  stream: { kind: 'enhanced' | 'logs' | 'disabled'; connected: boolean; wallets: number; lastMessageAt: number | null; reconnects: number; pendingLookups: number; error: string | null };
  heliusTier: 'free' | 'developer';
  heliusKey: boolean;
  jupiterKey: boolean;
  liveTrading: boolean;
  autoUnlock: boolean;
  paused: boolean;
  pausedReason: string | null;
  unlocked: boolean;
  solUsd: number | null;
  usage: { month: string; credits: number; rpcCalls: Record<string, number>; wsMb: number };
  queues: { rpc: number; jupiter: number };
}

export interface Trade {
  id: number;
  signalId: number | null;
  side: 'buy' | 'sell';
  mint: string;
  paper: boolean;
  manual: boolean;
  status: 'pending' | 'sent' | 'confirmed' | 'failed' | 'skipped';
  skipReason: string | null;
  error: string | null;
  pct: number | null;
  solLamports: number | null;
  tokenAmount: string | null;
  tokenDecimals: number | null;
  feeLamports: number | null;
  realizedLamports: number | null;
  signature: string | null;
  /** pumpfun | pumpswap | jupiter, prefixed with "paper:" for simulated fills. */
  route: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  attempts: number;
  createdAt: number;
  sentAt: number | null;
  confirmedAt: number | null;
  token: TokenRef;
  wallet: { id: number; label: string } | null;
  group: { id: number; name: string } | null;
  source: { label: string; address: string; role: string } | null;
  trader: { side: 'buy' | 'sell' | 'transfer_in' | 'transfer_out'; signature: string; pct: number; basisUsd: number | null; spentUsd: number | null; marketCapUsd: number | null; quoteAmount: string | null; quoteMint: string | null; detectedAt: number; blockTime: number | null; venue: string | null } | null;
  reactionMs: number | null;
  detectLagMs: number | null;
}

export interface SignalRow {
  id: number;
  signature: string;
  address: string;
  side: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
  mint: string;
  tokenDecimals: number;
  tokenAmount: string;
  postTokenBalance: string;
  quoteMint: string | null;
  quoteAmount: string | null;
  pct: number;
  /** Buys: the trader's cash (SOL + stablecoins, $) before the trade; null if not computed. */
  basisUsd: number | null;
  /** Dollars they spent (buy) or received (sell). */
  spentUsd: number | null;
  fullExit: boolean;
  marketCapUsd: number | null;
  detectedAt: number;
  blockTime: number | null;
  venue: 'pumpfun' | 'pumpswap' | 'dex' | null;
  note: string | null;
  token: TokenRef;
  wallet: { id: number; label: string; role: string } | null;
  group: { id: number; name: string } | null;
}

export interface Position {
  key: string;
  token: TokenRef;
  paper: boolean;
  wallet: { id: number; label: string; pubkey: string } | null;
  group: { id: number; name: string } | null;
  tokenAmount: string;
  costLamports: number;
  valueLamports: number | null;
  pnlLamports: number | null;
  pnlPct: number | null;
  entryMcUsd: number | null;
  currentMcUsd: number | null;
  priceStale: boolean;
  openedAt: number;
  sources: Array<{ lotId: number; label: string; address: string | null; role: string | null; tokenAmount: string; costLamports: number; note: string | null }>;
}

export interface ClosedPosition {
  id: number;
  token: TokenRef;
  paper: boolean;
  wallet: { id: number; label: string } | null;
  group: { id: number; name: string } | null;
  source: { label: string; address: string | null; role: string | null };
  totalCostLamports: number;
  proceedsLamports: number;
  realizedLamports: number;
  pnlPct: number | null;
  entryMcUsd: number | null;
  exitMcUsd: number | null;
  openedAt: number;
  closedAt: number | null;
  note: string | null;
}

export interface Summary {
  realizedLamports: number;
  unrealizedLamports: number;
  totalPnlLamports: number;
  openValueLamports: number;
  openPositions: number;
  closedPositions: number;
  winRate: number | null;
  trades: { all: number; today: number; skippedToday: number; failedToday: number };
}

export interface WalletRow {
  id: number;
  label: string;
  pubkey: string;
  source: 'generated' | 'imported';
  createdAt: number;
  group: { id: number; name: string; paper: boolean } | null;
  solLamports: number | null;
  /** When the balance was last read from chain (null = never). */
  balanceAt: number | null;
  paperCashLamports: number | null;
}

/** A wallet on the dashboard: cash plus what its open positions are worth at the last loaded prices. */
export interface DashboardWallet extends WalletRow {
  openValueLamports: number;
  openPositions: number;
  unrealizedLamports: number;
  realizedLamports: number;
  /** Cash + open positions (null while an on-chain balance hasn't been read). */
  worthLamports: number | null;
  /** Paper wallets: the starting balance. */
  startLamports: number | null;
}

export interface Dashboard {
  live: Summary;
  paper: Summary;
  wallets: DashboardWallet[];
  recentTrades: Trade[];
  recentSignals: SignalRow[];
}

export interface WatchedRow {
  id: number;
  groupId: number;
  address: string;
  label: string;
  role: 'main' | 'side' | 'bundler';
  enabled: boolean;
  copyBuys: boolean;
  copySells: boolean;
  signals24h: number;
  lastSignalAt: number | null;
  holding: Array<{ token: TokenRef; tokenAmount: string; decimals: number; lastSide: string; lastAt: number; lastMcUsd: number | null; currentMcUsd: number | null }>;
}

export interface GroupRow {
  id: number;
  name: string;
  myWalletId: number;
  enabled: boolean;
  paper: boolean;
  paperStartSol: number;
  multiplier: number;
  minSol: number;
  maxSol: number;
  maxPct: number;
  maxSolPerToken: number;
  reserveSol: number;
  slippageBps: number | null;
  skipIfHolding: boolean;
  maxOpenPositions: number;
  sizingMode: 'size' | 'cash';
  copyPct: number;
  minUsd: number;
  maxUsdPerToken: number;
  wallet: { id: number; label: string; pubkey: string } | null;
  stats: { trades: number; realizedLamports: number; openPositions: number };
  wallets: WatchedRow[];
}

export interface GlobalSettings {
  paused: boolean;
  pausedReason: string | null;
  maxSignalAgeSec: number;
  dailyLossLimitSol: number;
  blacklist: string[];
  extraQuoteMints: string[];
  skipFreezeAuthority: boolean;
  skipMintAuthority: boolean;
  copyCreatorBuys: boolean;
  verifyJupiterTx: boolean;
  skipRiskyToken2022: boolean;
  maxTransferFeePct: number;
  sellRetries: number;
  prefilterLogs: boolean;
  priceRefreshSec: number;
  paperFeeSol: number;
  closeEmptyAccounts: boolean;
  directPumpTrades: boolean;
  telegramTrades: boolean;
  telegramSkips: boolean;
  telegramHealth: boolean;
  senderRoute: 'swqos' | 'max';
  tipSol: number;
  priorityFeeSol: number;
  pumpSlippagePct: number;
}

export interface SettingsResponse {
  global: GlobalSettings;
  env: { heliusTier: string; heliusKey: boolean; jupiterKey: boolean; jupiterRps: number; rpcRps: number; liveTrading: boolean; autoUnlock: boolean; dataDir: string; logLevel: string; senderUrl: string; telegram: boolean };
  usage: Status['usage'];
}

export interface HeliusUsage {
  used: number;
  limit: number;
  remaining: number;
  plan: string | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  breakdown: Record<string, number>;
}

export interface LogEntry {
  time: number;
  level: string;
  module?: string;
  msg: string;
  extra?: Record<string, unknown>;
}

export interface BacktestTrade {
  signature: string;
  time: number | null;
  side: 'buy' | 'sell';
  pct: number;
  theirUsd: number;
  theirMcUsd: number | null;
  yourUsd: number | null;
  yourMcUsd: number | null;
  pricedBy: string | null;
  lagMs: number | null;
  note: string | null;
}

export interface BacktestToken {
  mint: string;
  symbol: string | null;
  trades: BacktestTrade[];
  theirCostUsd: number;
  theirProceedsUsd: number;
  theirPnlUsd: number;
  theirPnlPct: number | null;
  yourCostUsd: number;
  yourProceedsUsd: number;
  yourFeesUsd: number;
  yourOpenUsd: number;
  yourPnlUsd: number;
  yourPnlPct: number | null;
  stillOpen: boolean;
}

export interface BacktestResult {
  wallet: string;
  delaySec: number;
  tokens: BacktestToken[];
  totals: { costUsd: number; proceedsUsd: number; openUsd: number; feesUsd: number; pnlUsd: number; pnlPct: number | null; theirPnlUsd: number; wins: number; losses: number };
  scannedTxs: number;
  creditsEstimate: number;
  warnings: string[];
  group: { id: number; name: string } | null;
  watchedLabel: string | null;
  solUsd: number;
}
