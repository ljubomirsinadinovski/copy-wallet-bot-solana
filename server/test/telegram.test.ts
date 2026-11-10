import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db/client.js';
import { copyTrades, lots, myWallets, signals, traderGroups, watchedWallets } from '../src/db/schema.js';
import { tradeMessage } from '../src/notify/index.js';

const SOL = 1_000_000_000;
const MINT = '58EAJ5d1KLxzGJPmnqhTHwmrHsVMfVxDcGMWgvmGpump';

function setup() {
  const db = openMemoryDb(path.join(import.meta.dirname, '../drizzle'));
  const w = db.insert(myWallets).values({ label: 'frank wallet', pubkey: 'MyWa11et11111111111111111111111111111111111', secretCipher: 'x', source: 'generated', createdAt: 0 }).returning().get();
  const g = db.insert(traderGroups).values({ name: 'frank', myWalletId: w.id, paper: false, createdAt: 0 }).returning().get();
  const src = db.insert(watchedWallets).values({ groupId: g.id, address: 'Side1111111111111111111111111111111111111111', label: 'early buyer', role: 'side', createdAt: 0 }).returning().get();
  const sig = db
    .insert(signals)
    .values({
      signature: 'theirSig', watchedWalletId: src.id, address: src.address, slot: 1, blockTime: 1_000, detectedAt: 1_600, side: 'buy', mint: MINT,
      tokenDecimals: 6, tokenAmount: '1000', preTokenBalance: '0', postTokenBalance: '1000', pct: 0.1, spentUsd: 102, marketCapUsd: 31_000, source: 'enhanced',
    })
    .returning()
    .get();
  const ctx: any = {
    db,
    tokens: { cached: () => ({ symbol: 'LUNCHBOX', decimals: 6 }), ensureMetadata() {} },
    prices: { solUsd: 100 },
    engine: { paperCash: () => 0 },
    accounts: { solBalance: async () => 0.9 * SOL },
  };
  const base = { signalId: sig.id, groupId: g.id, myWalletId: w.id, sourceWalletId: src.id, mint: MINT, paper: false, pct: 0.1, createdAt: 2_000 };
  return { db, ctx, base, w, g, src };
}

describe('telegram trade messages', () => {
  it('copied buy: who, $ vs theirs, market cap vs theirs, speed, route, position, wallet', async () => {
    const { db, ctx, base, w, g, src } = setup();
    const t = db
      .insert(copyTrades)
      .values({ ...base, side: 'buy', status: 'confirmed', solLamports: 0.102 * SOL, feeLamports: 0.0002 * SOL, signature: 'mySig', route: 'pumpfun', solUsd: 100, marketCapUsd: 38_500, sentAt: 2_000, confirmedAt: 2_700 })
      .returning()
      .get();
    db.insert(lots).values({ myWalletId: w.id, groupId: g.id, sourceWalletId: src.id, mint: MINT, paper: false, tokenAmount: '1000', tokenDecimals: 6, costLamports: 0.1022 * SOL, totalCostLamports: 0.1022 * SOL, boughtAmount: '1000', openedAt: 0 }).run();
    const msg = await tradeMessage(ctx, t);
    expect(msg).toContain('🟢 <b>BUY</b> · 💰 LIVE · copied <b>frank</b> · early buyer (side)');
    expect(msg).toContain('<b>LUNCHBOX</b> · <code>58EAJ5d1KLxzGJPmnqhTHwmrHsVMfVxDcGMWgvmGpump</code>');
    expect(msg).toContain('You: <b>$10.20</b> at MC $38.5k');
    expect(msg).toContain('Them: $102.00 at MC $31.0k → you entered 24% higher');
    expect(msg).toContain('seen 600ms after their trade · sent 400ms later · landed in 700ms · via pump.fun direct');
    expect(msg).toContain('Position: $10.22 in LUNCHBOX · Wallet: $90.00');
    expect(msg).toContain('solscan.io/tx/mySig');
    expect(msg).toContain('solscan.io/tx/theirSig');
  });

  it('failed buy: error, what was tried, theirs', async () => {
    const { db, ctx, base } = setup();
    const t = db.insert(copyTrades).values({ ...base, side: 'buy', status: 'failed', solLamports: 0.1 * SOL, error: 'slippage <exceeded>', attempts: 1 }).returning().get();
    const msg = await tradeMessage(ctx, t);
    expect(msg).toContain('⚠️ <b>BUY FAILED</b> · 💰 LIVE');
    expect(msg).toContain('Tried: $10.00');
    expect(msg).toContain('Error: <code>slippage &lt;exceeded&gt;</code>');
    expect(msg).toContain('Them: $102.00 at MC $31.0k');
  });

  it('skipped copy: reason', async () => {
    const { db, ctx, base } = setup();
    const t = db.insert(copyTrades).values({ ...base, side: 'buy', status: 'skipped', skipReason: 'per-token budget of $50 is used up' }).returning().get();
    const msg = await tradeMessage(ctx, t);
    expect(msg).toContain('⏭ Skipped BUY');
    expect(msg).toContain('Reason: per-token budget of $50 is used up');
  });
});
