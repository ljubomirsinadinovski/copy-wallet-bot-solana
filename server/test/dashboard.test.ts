import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { dashboardView } from '../src/api/views.js';
import { openMemoryDb } from '../src/db/client.js';
import { myWallets, traderGroups, watchedWallets } from '../src/db/schema.js';
import { CopyEngine } from '../src/engine/copyEngine.js';
import type { Executor, SwapParams } from '../src/executor/executors.js';
import { SettingsStore } from '../src/settings.js';
import { WSOL_MINT } from '../src/solana/constants.js';
import type { NormalizedTx } from '../src/stream/types.js';

const MIGRATIONS = path.join(import.meta.dirname, '../drizzle');
const SOL = 1_000_000_000;
const RENT = 2_039_280;
const TRADER = 'Trader11111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOL_USD = 100;

/** Fills every swap at `price` SOL per whole token with a 5000-lamport fee. */
class FakeExecutor implements Executor {
  price = 0.00001;
  constructor(readonly paper: boolean) {}
  async swap(p: SwapParams) {
    const buying = p.inputMint === WSOL_MINT;
    const out = buying
      ? BigInt(Math.floor((Number(p.amount) / SOL / this.price) * 1e6))
      : BigInt(Math.floor((Number(p.amount) / 1e6) * this.price * SOL));
    return { signature: `sig-${Math.random()}`, inAmount: p.amount, outAmount: out, feeLamports: 5000, sentAt: Date.now(), confirmedAt: Date.now(), route: 'jupiter' as const };
  }
}

function traderTx(sig: string, solBefore: number, solAfter: number, tokBefore: bigint, tokAfter: bigint): NormalizedTx {
  return {
    signature: sig,
    slot: 1,
    blockTime: Date.now(),
    err: null,
    fee: 5000,
    accountKeys: [TRADER, 'TraderAta1111111111111111111111111111111111', PUMP],
    preBalances: [solBefore, RENT, 1],
    postBalances: [solAfter - 5000, RENT, 1],
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: TRADER, amount: String(tokBefore), decimals: 6 }],
    postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: TRADER, amount: String(tokAfter), decimals: 6 }],
    logs: [],
  };
}

describe('dashboard wallets', () => {
  it('worth = cash + open positions, and worth − start = realized + unrealized', async () => {
    const db = openMemoryDb(MIGRATIONS);
    const settings = new SettingsStore(db);
    const paper = new FakeExecutor(true);
    const token = { mint: MINT, symbol: 'TEST', decimals: 6, supply: String(10n ** 15n), freezeAuthority: null, mintAuthority: null, riskyExtensions: null, transferFeeBps: null };
    let priceSol: number | null = null;
    const prices = {
      get solUsd() { return SOL_USD; },
      solUsdFresh: async () => SOL_USD,
      priceSol: () => priceSol,
      priceUsd: () => (priceSol == null ? null : priceSol * SOL_USD),
      observe() {},
      refresh: async () => undefined,
    };
    const tokens = { get: async () => token, cached: () => token, symbol: () => 'TEST', ensureMetadata() {} };
    const engine = new CopyEngine({
      cfg: { liveTrading: false } as any,
      db,
      settings,
      keystore: { isUnlocked: true } as any,
      accounts: { cachedSol: () => null, invalidate() {} } as any,
      tokens: tokens as any,
      prices: prices as any,
      live: new FakeExecutor(false),
      paper,
      log: pino({ level: 'silent' }),
    });
    const wallet = db.insert(myWallets).values({ label: 'paper', pubkey: 'MyWa11et11111111111111111111111111111111111', secretCipher: 'x', source: 'generated', createdAt: 0 }).returning().get();
    const group = db.insert(traderGroups).values({ name: 'A', myWalletId: wallet.id, paperStartSol: 1, maxPct: 50, maxSolPerToken: 5, sizingMode: 'cash', createdAt: 0 }).returning().get();
    db.insert(watchedWallets).values({ groupId: group.id, address: TRADER, label: 'main', role: 'main', createdAt: 0 }).run();
    engine.reloadWatched();
    const feed = async (tx: NormalizedTx) => {
      await engine.onTx({ tx, detectedAt: Date.now(), source: 'enhanced' });
      await engine.idle();
    };

    // They spend 20% → you buy 0.196 SOL; they sell half → you sell half at double the price.
    await feed(traderTx('b', 10 * SOL, 8 * SOL, 0n, 1_000_000_000n));
    paper.price = 0.00002;
    await feed(traderTx('s', 8 * SOL, 9 * SOL, 1_000_000_000n, 500_000_000n));
    priceSol = 0.00003; // the token is now worth 3× your entry

    const ctx = { db, engine, settings, prices, tokens, accounts: { cachedSol: () => null } } as any;
    const w = (await dashboardView(ctx)).wallets[0];
    expect(w.startLamports).toBe(SOL);
    expect(w.openPositions).toBe(1);
    expect(w.worthLamports).toBe(w.paperCashLamports! + w.openValueLamports);
    expect(w.worthLamports! - w.startLamports!).toBe(w.realizedLamports + w.unrealizedLamports);
    expect(w.realizedLamports).toBeGreaterThan(0);
    expect(w.unrealizedLamports).toBeGreaterThan(0);
  });
});
