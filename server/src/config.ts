import path from 'node:path';
import { z } from 'zod';

const bool = z.preprocess(
  (v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()) : v),
  z.boolean(),
);

const schema = z.object({
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_TIER: z.enum(['free', 'developer']).default('free'),
  RPC_URL: z.string().url().optional(),
  WS_URL: z.string().optional(),
  RPC_RPS: z.coerce.number().positive().optional(),
  HELIUS_PROJECT_ID: z.string().optional(),
  SENDER_URL: z.string().url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  JUPITER_API_KEY: z.string().optional(),
  JUPITER_RPS: z.coerce.number().positive().default(1),
  LIVE_TRADING: bool.default(false),
  KEYSTORE_PASSPHRASE: z.string().optional(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8787),
  DATA_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: bool.optional(),
});

function loadConfig() {
  // Treat empty values (`KEY=` in .env) as unset.
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    console.error('Invalid configuration in .env:');
    for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    process.exit(1);
  }
  const e = parsed.data;
  const projectRoot = path.resolve(import.meta.dirname, '../..');
  const heliusKey = e.HELIUS_API_KEY ?? '';
  return {
    heliusApiKey: heliusKey,
    heliusTier: e.HELIUS_TIER,
    rpcUrl: e.RPC_URL ?? (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://api.mainnet-beta.solana.com'),
    wsUrl: e.WS_URL ?? (heliusKey ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}` : ''),
    rpcRps: e.HELIUS_TIER === 'free' ? Math.min(e.RPC_RPS ?? 10, 10) : (e.RPC_RPS ?? 50),
    heliusProjectId: e.HELIUS_PROJECT_ID ?? '',
    senderUrl: e.SENDER_URL ?? 'https://sender.helius-rpc.com/fast',
    telegramBotToken: e.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: e.TELEGRAM_CHAT_ID ?? '',
    jupiterApiKey: e.JUPITER_API_KEY ?? '',
    jupiterRps: e.JUPITER_RPS,
    liveTrading: e.LIVE_TRADING,
    keystorePassphrase: e.KEYSTORE_PASSPHRASE,
    host: e.HOST,
    port: e.PORT,
    dataDir: e.DATA_DIR ? path.resolve(projectRoot, e.DATA_DIR) : path.join(projectRoot, 'data'),
    logLevel: e.LOG_LEVEL,
    // Pretty by default in a terminal and under `pnpm dev` (where output is piped through concurrently).
    logPretty: e.LOG_PRETTY ?? (Boolean(process.stdout.isTTY) || process.env.npm_lifecycle_event?.startsWith('dev') === true),
    webDist: path.join(projectRoot, 'web', 'dist'),
    migrationsDir: path.resolve(import.meta.dirname, '../drizzle'),
  };
}

export const config = loadConfig();
export type Config = typeof config;

/** Hides API keys when URLs are logged. */
export function redactUrl(url: string): string {
  return url.replace(/(api-key=)[^&]+/i, '$1***');
}
