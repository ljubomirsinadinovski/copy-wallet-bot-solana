import type { TokenRef } from '../../../web/src/lib/api';

export interface Session {
  setup: boolean;
  loggedIn: boolean;
  unlocked: boolean;
  liveTrading: boolean;
  minPassphrase: number;
  dataDir: string;
  solUsd: number | null;
}

export interface ManualWallet {
  id: number;
  label: string;
  pubkey: string;
  /** Name of the copy-trading group that uses this wallet, if any. */
  copyGroup: string | null;
  solLamports: number | null;
  balanceAt: number | null;
  paperCashLamports: number;
}

/** A wallet removed from this tool; its key is still stored (encrypted). */
export interface RemovedWallet {
  id: number;
  label: string;
  pubkey: string;
}

export interface TokenPreview {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  direct: boolean;
  warnings: string[];
}

export interface ManualPosition {
  key: string;
  wallet: { id: number; label: string; pubkey: string } | null;
  paper: boolean;
  token: TokenRef;
  recordedTokens: string;
  /** Read from the chain when the list was loaded (live positions); null if not read. */
  onChainTokens: string | null;
  heldTokens: string;
  costLamports: number;
  valueLamports: number | null;
  pnlLamports: number | null;
  realizedLamports: number;
  priceUsd: number | null;
  priceStale: boolean;
  entryMcUsd: number | null;
  currentMcUsd: number | null;
  openedAt: number;
  otherLots: boolean;
  /** The unfinished sell plan on this position, if any. */
  plan: { id: number; status: PlanStatus } | null;
}

export interface ClosedManual {
  id: number;
  wallet: { id: number; label: string } | null;
  paper: boolean;
  token: TokenRef;
  investedLamports: number;
  proceedsLamports: number;
  realizedLamports: number;
  entryMcUsd: number | null;
  exitMcUsd: number | null;
  openedAt: number;
  closedAt: number | null;
  note: string | null;
}

export type PlanStatus = 'active' | 'paused' | 'done' | 'cancelled';

export interface PlanSettings {
  participationPct: number;
  maxImpactPct: number;
  minSellUsd: number;
  slippagePct: number;
  stopDropPct: number | null;
}

export interface SellPlan {
  id: number;
  /** Whole tokens in existence (for "worth at that market cap"). */
  supply: number | null;
  status: PlanStatus;
  paper: boolean;
  wallet: { id: number; label: string } | null;
  token: TokenRef;
  /** Tokens held when the plan started; the levels' % are of this. */
  bagTokens: string;
  moonBagTokens: string;
  levels: Array<{ id: number; mcUsd: number; pct: number; targetTokens: string; soldTokens: string; doneAt: number | null; selling: boolean }>;
  settings: PlanSettings;
  highMcUsd: number | null;
  /** The trailing stop fired: the rest of the levels is being sold. */
  exiting: boolean;
  soldTokens: string;
  proceedsLamports: number;
  sells: number;
  lastError: string | null;
  endReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** What the last check saw (null until the tool has checked since it started). */
  mcUsd: number | null;
  checkedAt: number | null;
  venue: string | null;
  note: string | null;
  nextCheckAt: number | null;
}
