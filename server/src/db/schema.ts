import { sqliteTable, integer, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Token amounts are stored as TEXT (raw integer strings) because some tokens exceed 64-bit integers.
// SOL amounts are stored as INTEGER lamports.

export const myWallets = sqliteTable('my_wallets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
  pubkey: text('pubkey').notNull().unique(),
  secretCipher: text('secret_cipher').notNull(),
  source: text('source', { enum: ['generated', 'imported'] }).notNull(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

export const traderGroups = sqliteTable('trader_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  myWalletId: integer('my_wallet_id')
    .notNull()
    .unique()
    .references(() => myWallets.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  paper: integer('paper', { mode: 'boolean' }).notNull().default(true),
  paperStartSol: real('paper_start_sol').notNull().default(1),
  multiplier: real('multiplier').notNull().default(1),
  minSol: real('min_sol').notNull().default(0.01),
  maxSol: real('max_sol').notNull().default(0.5),
  maxPct: real('max_pct').notNull().default(25),
  maxSolPerToken: real('max_sol_per_token').notNull().default(1),
  reserveSol: real('reserve_sol').notNull().default(0.02),
  slippageBps: integer('slippage_bps'),
  skipIfHolding: integer('skip_if_holding', { mode: 'boolean' }).notNull().default(false),
  /**
   * 'size': copy a fixed % of the dollars they spend (same shape as their position, just smaller).
   * 'cash': copy the % of their cash (SOL + stablecoins) they spent, applied to your balance.
   */
  sizingMode: text('sizing_mode', { enum: ['size', 'cash'] }).notNull().default('size'),
  /** 'size' mode: % of their dollar amount you spend. */
  copyPct: real('copy_pct').notNull().default(10),
  /** 'size' mode: smaller copies are raised to this many dollars. */
  minUsd: real('min_usd').notNull().default(3),
  /** 'size' mode: total dollars you put into one token across all buys and adds. */
  maxUsdPerToken: real('max_usd_per_token').notNull().default(50),
  maxOpenPositions: integer('max_open_positions').notNull().default(10),
  createdAt: integer('created_at').notNull(),
});

export const watchedWallets = sqliteTable('watched_wallets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  groupId: integer('group_id')
    .notNull()
    .references(() => traderGroups.id, { onDelete: 'cascade' }),
  address: text('address').notNull().unique(),
  label: text('label').notNull().default(''),
  role: text('role', { enum: ['main', 'side', 'bundler'] }).notNull().default('main'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  copyBuys: integer('copy_buys', { mode: 'boolean' }).notNull().default(true),
  copySells: integer('copy_sells', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

/** A trade detected on a watched wallet. */
export const signals = sqliteTable(
  'signals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    signature: text('signature').notNull(),
    watchedWalletId: integer('watched_wallet_id'),
    address: text('address').notNull(),
    slot: integer('slot').notNull(),
    blockTime: integer('block_time'),
    detectedAt: integer('detected_at').notNull(),
    side: text('side', { enum: ['buy', 'sell', 'transfer_in', 'transfer_out'] }).notNull(),
    mint: text('mint').notNull(),
    tokenDecimals: integer('token_decimals').notNull(),
    tokenAmount: text('token_amount').notNull(),
    preTokenBalance: text('pre_token_balance').notNull(),
    postTokenBalance: text('post_token_balance').notNull(),
    quoteMint: text('quote_mint'),
    quoteAmount: text('quote_amount'),
    preQuoteBalance: text('pre_quote_balance'),
    pct: real('pct').notNull(),
    /** Buys: the trader's cash (SOL + USDC + USDT + USD1, in $) before the trade, and what they spent. */
    basisUsd: real('basis_usd'),
    spentUsd: real('spent_usd'),
    fullExit: integer('full_exit', { mode: 'boolean' }).notNull().default(false),
    priceUsd: real('price_usd'),
    marketCapUsd: real('market_cap_usd'),
    source: text('source').notNull(),
    /** pumpfun | pumpswap | dex – from the program IDs in the trader's transaction. */
    venue: text('venue'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('signals_unique').on(t.signature, t.address, t.mint, t.side),
    index('signals_address_idx').on(t.address, t.detectedAt),
    index('signals_detected_idx').on(t.detectedAt),
  ],
);

/** A trade the bot executed (or simulated, or skipped) on one of your wallets. */
export const copyTrades = sqliteTable(
  'copy_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    signalId: integer('signal_id'),
    groupId: integer('group_id'),
    myWalletId: integer('my_wallet_id').notNull(),
    sourceWalletId: integer('source_wallet_id'),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    mint: text('mint').notNull(),
    paper: integer('paper', { mode: 'boolean' }).notNull(),
    manual: integer('manual', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['pending', 'sent', 'confirmed', 'failed', 'skipped'] }).notNull(),
    recovery: text('recovery'),
    skipReason: text('skip_reason'),
    error: text('error'),
    pct: real('pct'),
    /** buy: SOL spent; sell: SOL received (lamports). Before the fill: requested amount. */
    solLamports: integer('sol_lamports'),
    /** buy: tokens received; sell: tokens sold (raw). */
    tokenAmount: text('token_amount'),
    tokenDecimals: integer('token_decimals'),
    feeLamports: integer('fee_lamports'),
    realizedLamports: integer('realized_lamports'),
    signature: text('signature'),
    /** How it was executed: pumpfun / pumpswap (direct via Helius Sender), jupiter, or paper. */
    route: text('route'),
    priceUsd: real('price_usd'),
    solUsd: real('sol_usd'),
    marketCapUsd: real('market_cap_usd'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    sentAt: integer('sent_at'),
    confirmedAt: integer('confirmed_at'),
  },
  (t) => [
    index('trades_created_idx').on(t.createdAt),
    index('trades_wallet_idx').on(t.myWalletId, t.createdAt),
    index('trades_signal_idx').on(t.signalId),
  ],
);

/**
 * A position slice opened by one source wallet in one of your wallets. Sells from that source wallet
 * reduce only its own lot, so you exit when the wallet that got you in exits.
 */
export const lots = sqliteTable(
  'lots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    myWalletId: integer('my_wallet_id').notNull(),
    groupId: integer('group_id'),
    sourceWalletId: integer('source_wallet_id'),
    mint: text('mint').notNull(),
    paper: integer('paper', { mode: 'boolean' }).notNull(),
    status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
    tokenAmount: text('token_amount').notNull(),
    tokenDecimals: integer('token_decimals').notNull(),
    /** Remaining cost basis of the tokens still held. */
    costLamports: integer('cost_lamports').notNull(),
    totalCostLamports: integer('total_cost_lamports').notNull(),
    proceedsLamports: integer('proceeds_lamports').notNull().default(0),
    realizedLamports: integer('realized_lamports').notNull().default(0),
    boughtAmount: text('bought_amount').notNull(),
    soldAmount: text('sold_amount').notNull().default('0'),
    entryMcUsd: real('entry_mc_usd'),
    exitMcUsd: real('exit_mc_usd'),
    lastPriceSol: real('last_price_sol'),
    openedAt: integer('opened_at').notNull(),
    closedAt: integer('closed_at'),
    note: text('note'),
  },
  (t) => [index('lots_open_idx').on(t.status, t.myWalletId, t.mint)],
);

export const tokens = sqliteTable('tokens', {
  mint: text('mint').primaryKey(),
  symbol: text('symbol'),
  name: text('name'),
  icon: text('icon'),
  decimals: integer('decimals').notNull(),
  supply: text('supply').notNull(),
  tokenProgram: text('token_program').notNull(),
  freezeAuthority: text('freeze_authority'),
  mintAuthority: text('mint_authority'),
  riskyExtensions: text('risky_extensions'),
  /** Token-2022 transfer fee, 100 = 1%; null = none. */
  transferFeeBps: integer('transfer_fee_bps'),
  fetchedAt: integer('fetched_at').notNull(),
  metaFetchedAt: integer('meta_fetched_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export type MyWallet = typeof myWallets.$inferSelect;
export type TraderGroup = typeof traderGroups.$inferSelect;
export type WatchedWallet = typeof watchedWallets.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type CopyTrade = typeof copyTrades.$inferSelect;
export type Lot = typeof lots.$inferSelect;
export type Token = typeof tokens.$inferSelect;
