import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/client.js';
import { settings } from './db/schema.js';

/** Trading knobs editable from the Settings page; they apply immediately without a restart. */
export const globalSettingsSchema = z.object({
  paused: z.boolean().default(false),
  pausedReason: z.string().nullable().default(null),
  /** Skip signals older than this (seconds since the trader's transaction). */
  maxSignalAgeSec: z.number().min(1).max(600).default(20),
  /** Auto-pause when today's realized loss (live trades) exceeds this many SOL. 0 = off. */
  dailyLossLimitSol: z.number().min(0).default(0),
  blacklist: z.array(z.string()).default([]),
  /** Extra mints traders pay with (besides SOL, USDC, USDT, USD1). A buy paid in one is sized as a share of that balance. */
  extraQuoteMints: z.array(z.string()).default([]),
  skipFreezeAuthority: z.boolean().default(true),
  /** Skip tokens whose supply can still be increased (the creator could mint and dump). */
  skipMintAuthority: z.boolean().default(true),
  /** Copy a buy when the trader created the token in that same transaction (dev launch). Off by default. */
  copyCreatorBuys: z.boolean().default(false),
  /** Simulate Jupiter-built transactions before signing and refuse any that would take more SOL than the trade. */
  verifyJupiterTx: z.boolean().default(true),
  skipRiskyToken2022: z.boolean().default(true),
  /** Highest Token-2022 transfer fee (%) you accept on a buy; every buy and sell of such a token pays it. */
  maxTransferFeePct: z.number().min(0).max(100).default(5),
  /** Extra sell attempts with rising slippage when a sell fails. */
  sellRetries: z.number().int().min(0).max(5).default(3),
  /** Fetch transaction details only when the logs look like a swap (free tier; saves credits). */
  prefilterLogs: z.boolean().default(true),
  priceRefreshSec: z.number().min(5).max(300).default(15),
  /** Simulated network + priority fee per paper trade. */
  paperFeeSol: z.number().min(0).default(0.0005),
  /** Close empty token accounts after a full live exit to reclaim ~0.002 SOL rent. */
  closeEmptyAccounts: z.boolean().default(true),
  /** Telegram: a message for every copied buy/sell and every failure. */
  telegramTrades: z.boolean().default(true),
  /** Telegram: a message when a trader's trade is not copied, with the reason. */
  telegramSkips: z.boolean().default(true),
  /** Telegram: bot started/stopped, connection lost, daily loss limit, tokens moved away. */
  telegramHealth: z.boolean().default(true),
  /** Trade pump.fun / PumpSwap tokens directly (built locally, sent via Helius Sender) instead of via Jupiter. */
  directPumpTrades: z.boolean().default(true),
  /** Helius Sender route: 'swqos' (staked connections, tiny tip) or 'max' (all pathways incl. Jito, ≥0.001 SOL tip). */
  senderRoute: z.enum(['swqos', 'max']).default('swqos'),
  /** Tip per direct trade (raised to the route's minimum automatically). */
  tipSol: z.number().min(0).max(0.05).default(0.00001),
  /** Priority fee per direct trade. */
  priorityFeeSol: z.number().min(0).max(0.05).default(0.0002),
  /** Slippage for direct trades when the trader group's slippage is on auto. */
  pumpSlippagePct: z.number().min(0.5).max(90).default(20),
});

export type GlobalSettings = z.infer<typeof globalSettingsSchema>;

const GLOBAL_KEY = 'global';

export class SettingsStore {
  private cache: GlobalSettings;

  constructor(private readonly db: Db) {
    this.cache = globalSettingsSchema.parse(this.getJson(GLOBAL_KEY) ?? {});
  }

  get(): GlobalSettings {
    return this.cache;
  }

  update(patch: Partial<GlobalSettings>): GlobalSettings {
    this.cache = globalSettingsSchema.parse({ ...this.cache, ...patch });
    this.setJson(GLOBAL_KEY, this.cache);
    return this.cache;
  }

  getJson<T = unknown>(key: string): T | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setJson(key: string, value: unknown): void {
    const json = JSON.stringify(value);
    this.db
      .insert(settings)
      .values({ key, value: json })
      .onConflictDoUpdate({ target: settings.key, set: { value: json } })
      .run();
  }
}
