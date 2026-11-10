import type { Logger } from 'pino';
import type { Sessions } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { CopyEngine } from './engine/copyEngine.js';
import type { Keystore } from './keystore/keystore.js';
import type { PriceService } from './prices/priceService.js';
import type { SettingsStore } from './settings.js';
import type { AccountService } from './solana/accounts.js';
import type { JupiterClient } from './solana/jupiter.js';
import type { RpcClient } from './solana/rpc.js';
import type { TokenService } from './solana/tokens.js';
import type { WalletStream } from './stream/types.js';
import type { UsageTracker } from './util/usage.js';
import type { TelegramNotifier } from './notify/telegram.js';

export interface AppContext {
  cfg: Config;
  db: Db;
  settings: SettingsStore;
  keystore: Keystore;
  sessions: Sessions;
  accounts: AccountService;
  tokens: TokenService;
  prices: PriceService;
  engine: CopyEngine;
  stream: WalletStream;
  usage: UsageTracker;
  rpc: RpcClient;
  jupiter: JupiterClient;
  log: Logger;
  telegram: TelegramNotifier;
  /** Re-reads watched wallets and your wallets and updates the subscriptions. */
  refreshSubscriptions: () => void;
}
