import path from 'node:path';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { openMemoryDb, type Db } from '../src/db/client.js';
import { copyTrades, lots, myWallets, signals, traderGroups, watchedWallets } from '../src/db/schema.js';
import { CopyEngine, type EngineDeps } from '../src/engine/copyEngine.js';
import { SwapError, type Executor, type SwapParams } from '../src/executor/executors.js';
import { SettingsStore } from '../src/settings.js';
import { WSOL_MINT } from '../src/solana/constants.js';
import { riskyExtensions, transferFeeBps } from '../src/solana/tokens.js';
import type { NormalizedTx, StreamTx } from '../src/stream/types.js';

const MIGRATIONS = path.join(import.meta.dirname, '../drizzle');
const SOL = 1_000_000_000;
const RENT = 2_039_280;
const TRADER = 'Trader11111111111111111111111111111111111111';
const OTHER = 'Other111111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const MY = 'MyWa11et11111111111111111111111111111111111';
/** Token price: 1 token (6 decimals) = 0.00001 SOL. Supply 1B → MC = 10k SOL. */
const PRICE_SOL = 0.00001;
const SOL_USD = 100;

/** Fills every swap at PRICE_SOL with a fixed fee, like a perfectly liquid pool. */
class FakeExecutor implements Executor {
  calls: SwapParams[] = [];
  fail = false;
  constructor(readonly paper: boolean) {}
  async swap(p: SwapParams) {
    this.calls.push(p);
    if (this.fail) throw new Error('route failed');
    const buying = p.inputMint === WSOL_MINT;
    const out = buying
      ? BigInt(Math.floor((Number(p.amount) / SOL / PRICE_SOL) * 1e6))
      : BigInt(Math.floor((Number(p.amount) / 1e6) * PRICE_SOL * SOL));
    return { signature: `sig-${this.calls.length}`, inAmount: p.amount, outAmount: out, feeLamports: 5000, sentAt: Date.now(), confirmedAt: Date.now(), route: 'jupiter' as const };
  }
}

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function traderTx(sig: string, opts: { solBefore: number; solAfter: number; tokBefore: bigint; tokAfter: bigint; blockTime?: number; mint?: string }): StreamTx {
  const mint = opts.mint ?? MINT;
  const tx: NormalizedTx = {
    signature: sig,
    slot: 1,
    blockTime: opts.blockTime ?? Date.now(),
    err: null,
    fee: 5000,
    // The trader traded on pump.fun's bonding curve.
    accountKeys: [TRADER, 'TraderAta1111111111111111111111111111111111', PUMP],
    preBalances: [opts.solBefore, RENT, 1],
    postBalances: [opts.solAfter - 5000, RENT, 1],
    preTokenBalances: [{ accountIndex: 1, mint, owner: TRADER, amount: String(opts.tokBefore), decimals: 6 }],
    postTokenBalances: [{ accountIndex: 1, mint, owner: TRADER, amount: String(opts.tokAfter), decimals: 6 }],
    logs: [],
  };
  return { tx, detectedAt: Date.now(), source: 'enhanced' };
}

let db: Db;
let engine: CopyEngine;
let deps: EngineDeps;
let paperExec: FakeExecutor;
let liveExec: FakeExecutor;
let settings: SettingsStore;
let liveTrading: boolean;
let token: Record<string, unknown>;
/** The trader's stablecoin balances outside the transaction (read separately by the bot). */
let traderStables: Map<string, { raw: bigint; decimals: number }>;

function setup() {
  db = openMemoryDb(MIGRATIONS);
  settings = new SettingsStore(db);
  paperExec = new FakeExecutor(true);
  liveExec = new FakeExecutor(false);
  liveTrading = false;
  traderStables = new Map();
  token = { mint: MINT, symbol: 'TEST', decimals: 6, supply: String(1_000_000_000n * 1_000_000n), freezeAuthority: null, mintAuthority: null, riskyExtensions: null };
  const log = pino({ level: 'silent' });
  deps = {
    cfg: { get liveTrading() { return liveTrading; } } as any,
    db,
    settings,
    keystore: { isUnlocked: true } as any,
    accounts: {
      solBalance: async () => 5 * SOL,
      tokenBalance: async () => 10n ** 15n,
      cashBalances: async () => ({ lamports: null, stables: traderStables }),
      invalidate() {},
      closeEmptyAccounts: async () => ({ closed: 0, signatures: [] }),
    } as any,
    tokens: { get: async () => token, cached: () => token, symbol: () => 'TEST' } as any,
    prices: { solUsd: SOL_USD, solUsdFresh: async () => SOL_USD, priceUsd: () => null, priceSol: () => null, observe() {} } as any,
    live: liveExec,
    paper: paperExec,
    log,
  };
  engine = new CopyEngine(deps);
  const wallet = db.insert(myWallets).values({ label: 'mine', pubkey: MY, secretCipher: 'x', source: 'generated', createdAt: 0 }).returning().get();
  const group = db
    .insert(traderGroups)
    .values({ name: 'A', myWalletId: wallet.id, paperStartSol: 10, maxSol: 5, maxPct: 50, maxSolPerToken: 5, sizingMode: 'cash', createdAt: 0 })
    .returning()
    .get();
  db.insert(watchedWallets).values({ groupId: group.id, address: TRADER, label: 'main', role: 'main', createdAt: 0 }).run();
  db.insert(watchedWallets).values({ groupId: group.id, address: OTHER, label: 'side', role: 'side', createdAt: 0 }).run();
  engine.reloadWatched();
  return { wallet, group };
}

async function feed(st: StreamTx) {
  await engine.onTx(st);
  await engine.idle();
}

const trades = () => db.select().from(copyTrades).orderBy(copyTrades.id).all();
const openLots = () => db.select().from(lots).where(eq(lots.status, 'open')).all();

describe('copy engine (paper mode)', () => {
  beforeEach(() => {
    setup();
  });

  it('mirrors a buy by ratio, then a partial and a full sell', async () => {
    // Trader spends 10% of 20 SOL.
    await feed(traderTx('buy1', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 200_000n * 1_000_000n }));
    const [buy] = trades();
    expect(buy.status).toBe('confirmed');
    expect(buy.side).toBe('buy');
    expect(buy.pct).toBeCloseTo(0.1, 9);
    // 10% of (10 SOL paper balance − 0.02 reserve)
    expect(buy.solLamports).toBe(Math.floor(0.1 * 9.98 * SOL));
    expect(buy.marketCapUsd).toBeCloseTo(PRICE_SOL * SOL_USD * 1e9, -2);
    const lot = openLots()[0];
    const bought = BigInt(lot.tokenAmount);
    expect(bought).toBeGreaterThan(0n);

    // Trader sells half their bag → we sell half of our lot.
    await feed(traderTx('sell1', { solBefore: 18 * SOL, solAfter: 19 * SOL, tokBefore: 200_000n * 1_000_000n, tokAfter: 100_000n * 1_000_000n }));
    const sell1 = trades()[1];
    expect(sell1.side).toBe('sell');
    expect(sell1.status).toBe('confirmed');
    expect(BigInt(sell1.tokenAmount!)).toBe(bought / 2n);
    expect(BigInt(openLots()[0].tokenAmount)).toBe(bought - bought / 2n);

    // Trader exits completely → we sell the rest and the lot closes.
    await feed(traderTx('sell2', { solBefore: 19 * SOL, solAfter: 20 * SOL, tokBefore: 100_000n * 1_000_000n, tokAfter: 0n }));
    expect(openLots()).toHaveLength(0);
    const closed = db.select().from(lots).all()[0];
    expect(closed.status).toBe('closed');
    expect(closed.soldAmount).toBe(closed.boughtAmount);
    // Same price in and out → realized = −fees (3 trades × 5000 lamports) minus rounding.
    expect(closed.realizedLamports).toBeLessThan(0);
    expect(closed.realizedLamports).toBeGreaterThan(-20_000);
    expect(closed.entryMcUsd).toBeCloseTo(closed.exitMcUsd!, -3);

    // Paper cash reflects the round trip.
    const g = db.select().from(traderGroups).get()!;
    expect(engine.paperCash(g, g.myWalletId)).toBeCloseTo(10 * SOL + closed.realizedLamports, -2);
  });

  it('ignores duplicate notifications of the same transaction', async () => {
    const st = traderTx('dup', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n });
    await feed(st);
    await feed(st);
    expect(db.select().from(signals).all()).toHaveLength(1);
    expect(trades()).toHaveLength(1);
  });

  it('skips stale signals', async () => {
    await feed(traderTx('old', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n, blockTime: Date.now() - 120_000 }));
    const [t] = trades();
    expect(t.status).toBe('skipped');
    expect(t.skipReason).toMatch(/old/);
    expect(paperExec.calls).toHaveLength(0);
  });

  it('ignores sells from a wallet whose buys were not copied', async () => {
    await feed(traderTx('s', { solBefore: 1 * SOL, solAfter: 2 * SOL, tokBefore: 1_000_000n, tokAfter: 0n }));
    expect(trades()).toHaveLength(0);
    expect(db.select().from(signals).all()).toHaveLength(1);
  });

  it('respects the pause switch', async () => {
    settings.update({ paused: true });
    await feed(traderTx('p', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    expect(trades()[0].skipReason).toMatch(/paused/);
  });

  it('never sends a live trade while LIVE_TRADING is off', async () => {
    db.update(traderGroups).set({ paper: false }).run();
    await feed(traderTx('l', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    expect(trades()[0].skipReason).toMatch(/LIVE_TRADING/);
    expect(liveExec.calls).toHaveLength(0);

    liveTrading = true;
    await feed(traderTx('l2', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 1_000_000n, tokAfter: 2_000_000n }));
    expect(liveExec.calls).toHaveLength(1);
    // Live sizing uses the real wallet balance (5 SOL) minus reserve.
    expect(Number(liveExec.calls[0].amount)).toBe(Math.floor(0.1 * 4.98 * SOL));
  });

  it('retries a failing sell with wider slippage, then records the failure', async () => {
    await feed(traderTx('b', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    paperExec.fail = true;
    await feed(traderTx('s', { solBefore: 18 * SOL, solAfter: 19 * SOL, tokBefore: 1_000_000n, tokAfter: 0n }));
    const sell = trades()[1];
    expect(sell.status).toBe('failed');
    expect(sell.attempts).toBe(4);
    expect(paperExec.calls.slice(1).map((c) => c.slippageBps)).toEqual([null, 2500, 4000, 6000]);
    expect(openLots()).toHaveLength(1); // position kept, so a later sell can still exit
  });

  it('manual close sells every lot of the token across source wallets', async () => {
    await feed(traderTx('b1', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    const g = db.select().from(traderGroups).get()!;
    await engine.manualSell(g.myWalletId, MINT, 1, true);
    expect(openLots()).toHaveLength(0);
    expect(trades().at(-1)!.manual).toBe(true);
  });

  it('passes the trader\'s venue to the executor and records the route', async () => {
    await feed(traderTx('v', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    expect(paperExec.calls[0].venue).toBe('pumpfun');
    expect(trades()[0].route).toBe('paper:jupiter');
    expect(db.select().from(signals).get()!.venue).toBe('pumpfun');
  });

  it('does not copy a swap into staked SOL / stablecoins (cashing out)', async () => {
    const JITOSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
    await feed(traderTx('cash', { solBefore: 20 * SOL, solAfter: 2 * SOL, tokBefore: 0n, tokAfter: 17_000_000n, mint: JITOSOL }));
    const [t] = trades();
    expect(t.status).toBe('skipped');
    expect(t.skipReason).toMatch(/cashing out/);
    expect(paperExec.calls).toHaveLength(0);
  });

  it('skips a dev launch (token created in the trader\'s own buy transaction)', async () => {
    const st = traderTx('dev', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n });
    st.tx.accountKeys.push(MINT);
    st.tx.preBalances.push(0);
    st.tx.postBalances.push(1_461_600);
    await feed(st);
    expect(trades()[0].skipReason).toMatch(/dev launch/);
    expect(paperExec.calls).toHaveLength(0);
  });

  it('copies tokens with a transfer fee up to the limit, skips higher fees', async () => {
    token.transferFeeBps = 100; // 1%, the default limit is 5%
    await feed(traderTx('f1', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    expect(trades()[0].status).toBe('confirmed');

    settings.update({ maxTransferFeePct: 0.5 });
    await feed(traderTx('f2', { solBefore: 18 * SOL, solAfter: 16 * SOL, tokBefore: 1_000_000n, tokAfter: 2_000_000n }));
    expect(trades()[1].skipReason).toBe('transfer fee 1% is above your 0.5% limit');
  });

  it('reports a sell of a token whose buy was skipped', async () => {
    token.mintAuthority = 'SomeAuthority1111111111111111111111111111111';
    await feed(traderTx('b', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    await feed(traderTx('s', { solBefore: 18 * SOL, solAfter: 19 * SOL, tokBefore: 1_000_000n, tokAfter: 0n }));
    const sell = trades()[1];
    expect(sell.side).toBe('sell');
    expect(sell.status).toBe('skipped');
    expect(sell.skipReason).toMatch(/^not holding – the buy was skipped \(more of this token can still be minted/);
    expect(paperExec.calls).toHaveLength(0);
  });

  it('reports a sell after the position was already closed', async () => {
    await feed(traderTx('b', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    await feed(traderTx('s1', { solBefore: 18 * SOL, solAfter: 19 * SOL, tokBefore: 1_000_000n, tokAfter: 0n }));
    await feed(traderTx('s2', { solBefore: 19 * SOL, solAfter: 19.5 * SOL, tokBefore: 500_000n, tokAfter: 0n }));
    expect(trades().at(-1)!.skipReason).toBe('not holding – position already closed');
  });

  it('closes the position when a live sell takes the whole (fee-reduced) balance', async () => {
    db.update(traderGroups).set({ paper: false }).run();
    liveTrading = true;
    await feed(traderTx('b', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    const lot = openLots()[0];
    // A 1% transfer fee kept back part of the buy: the wallet holds less than the lot says.
    const held = (BigInt(lot.tokenAmount) * 99n) / 100n;
    deps.accounts.tokenBalance = async () => held;
    await feed(traderTx('s', { solBefore: 18 * SOL, solAfter: 19 * SOL, tokBefore: 1_000_000n, tokAfter: 0n }));
    expect(liveExec.calls.at(-1)!.amount).toBe(held);
    expect(openLots()).toHaveLength(0);
  });

  it('skips tokens whose supply can still be minted', async () => {
    token.mintAuthority = 'SomeAuthority1111111111111111111111111111111';
    await feed(traderTx('m', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    expect(trades()[0].skipReason).toMatch(/minted/);
  });

  /** TRADER sends tokens to `to` (no DEX involved). */
  function transferTx(sig: string, to: string, amount: bigint, traderBefore: bigint): StreamTx {
    const tx: NormalizedTx = {
      signature: sig,
      slot: 2,
      blockTime: Date.now(),
      err: null,
      fee: 5000,
      accountKeys: [TRADER, 'TraderAta1111111111111111111111111111111111', 'DestAta111111111111111111111111111111111111'],
      preBalances: [10 * SOL, RENT, RENT],
      postBalances: [10 * SOL - 5000, RENT, RENT],
      preTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: TRADER, amount: String(traderBefore), decimals: 6 },
        { accountIndex: 2, mint: MINT, owner: to, amount: '0', decimals: 6 },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: TRADER, amount: String(traderBefore - amount), decimals: 6 },
        { accountIndex: 2, mint: MINT, owner: to, amount: String(amount), decimals: 6 },
      ],
      logs: ['Program log: Instruction: TransferChecked'],
    };
    return { tx, detectedAt: Date.now(), source: 'enhanced' };
  }

  it('sells the transferred fraction once, even to another watched wallet', async () => {
    await feed(traderTx('b', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    const bought = BigInt(openLots()[0].tokenAmount);
    const transfer = transferTx('t', OTHER, 500_000n, 1_000_000n);
    await Promise.all([engine.onTx(transfer), engine.onTx(transfer)]);
    await engine.idle();
    expect(trades()).toHaveLength(2);
    expect(trades()[1].side).toBe('sell');
    expect(BigInt(trades()[1].tokenAmount!)).toBe(bought / 2n);
    expect(openLots()).toHaveLength(1);
    expect(BigInt(openLots()[0].tokenAmount)).toBe(bought - bought / 2n);
  });

  it('exits when all tokens move to an unknown wallet', async () => {
    await feed(traderTx('b', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    await feed(transferTx('t', 'Unknown111111111111111111111111111111111111', 1_000_000n, 1_000_000n));
    expect(trades()).toHaveLength(2);
    expect(openLots()).toHaveLength(0);
  });

  it('does not turn liquidity deposits into transfer exits', async () => {
    await feed(traderTx('b', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    const movement = transferTx('lp', OTHER, 1_000_000n, 1_000_000n);
    movement.tx.logs.push('Program log: Instruction: AddLiquidity');
    await feed(movement);
    expect(trades()[1].status).toBe('skipped');
    expect(trades()[1].skipReason).toMatch(/liquidity/);
    expect(openLots()).toHaveLength(1);
  });

  it('keeps the pause and copy-sells controls for transfer exits', async () => {
    await feed(traderTx('b', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    settings.update({ paused: true });
    await feed(transferTx('paused', OTHER, 500_000n, 1_000_000n));
    expect(trades()[1].skipReason).toMatch(/paused/);
    settings.update({ paused: false });
    db.update(watchedWallets).set({ copySells: false }).run();
    engine.reloadWatched();
    await feed(transferTx('disabled', OTHER, 500_000n, 1_000_000n));
    expect(trades()[2].skipReason).toMatch(/sells is off/);
    expect(paperExec.calls).toHaveLength(1);
  });

  it('manual buys share the same wallet cash reservations', async () => {
    db.update(traderGroups).set({ paperStartSol: 1 }).run();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = paperExec.swap.bind(paperExec);
    vi.spyOn(paperExec, 'swap').mockImplementation(async (p) => { await blocked; return original(p); });
    const first = engine.manualBuy(1, MINT, 0.7, true);
    await vi.waitFor(() => expect(trades()).toHaveLength(1));
    await expect(engine.manualBuy(1, 'Mint2', 0.7, true)).rejects.toThrow('unreserved balance');
    release();
    await first;
    expect(openLots()).toHaveLength(1);
  });

  it('reserves position slots across simultaneous buys of different tokens', async () => {
    db.update(traderGroups).set({ maxOpenPositions: 1 }).run();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = paperExec.swap.bind(paperExec);
    vi.spyOn(paperExec, 'swap').mockImplementation(async (p) => { await blocked; return original(p); });
    await engine.onTx(traderTx('one', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    await engine.onTx(traderTx('two', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n, mint: 'Mint2' }));
    await vi.waitFor(() => expect(trades().some((t) => t.skipReason?.includes('open positions'))).toBe(true));
    release();
    await engine.idle();
    expect(openLots()).toHaveLength(1);
  });

  it('reserves cash across simultaneous buys without waiting for fills', async () => {
    db.update(traderGroups).set({ paperStartSol: 1, maxPct: 100, maxOpenPositions: 0 }).run();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = paperExec.swap.bind(paperExec);
    const amounts: bigint[] = [];
    vi.spyOn(paperExec, 'swap').mockImplementation(async (p) => { amounts.push(p.amount); await blocked; return original(p); });
    for (let i = 0; i < 4; i++) await engine.onTx(traderTx('cash' + i, {
      solBefore: 20 * SOL, solAfter: 10 * SOL, tokBefore: 0n, tokAfter: 1_000_000n, mint: 'Mint' + i,
    }));
    await vi.waitFor(() => expect(amounts).toHaveLength(4));
    expect(amounts.reduce((a, b) => a + b, 0n)).toBeLessThan(BigInt(SOL));
    release();
    await engine.idle();
    expect(engine.paperCash(db.select().from(traderGroups).get()!, 1)).toBeGreaterThan(0);
  });

  it('does not repeat a submitted sell when readback fails; recovery books it once', async () => {
    liveTrading = true;
    db.update(traderGroups).set({ paper: false }).run();
    await feed(traderTx('buy-live', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    const before = BigInt(openLots()[0].tokenAmount);
    const original = liveExec.swap.bind(liveExec);
    let fill: Awaited<ReturnType<typeof original>>;
    vi.spyOn(liveExec, 'swap').mockImplementation(async (p) => {
      fill = await original(p);
      p.onSubmit?.({ signature: fill.signature, blockhash: 'hash', route: 'jupiter', tip: 0, sentAt: fill.sentAt });
      throw new Error('confirmed, but readback timed out');
    });
    await feed(traderTx('sell-live', { solBefore: 18 * SOL, solAfter: 19 * SOL, tokBefore: 1_000_000n, tokAfter: 500_000n }));
    expect(liveExec.calls).toHaveLength(2);
    expect(trades()[1].status).toBe('sent');
    await expect(engine.manualSell(1, MINT, 1, false)).rejects.toThrow(/unresolved/);
    expect(BigInt(openLots()[0].tokenAmount)).toBe(before);
    (liveExec as Executor).recover = async () => fill!;
    engine = new CopyEngine(deps); // Simulate a fresh process using the persisted records.
    await engine.recoverPending();
    await engine.recoverPending();
    expect(trades()[1].status).toBe('confirmed');
    expect(BigInt(openLots()[0].tokenAmount)).toBe(before - before / 2n);
    expect(liveExec.calls).toHaveLength(2);
  });

  it('recovers an unbooked buy and blocks new spending until its outcome is known', async () => {
    liveTrading = true;
    db.update(traderGroups).set({ paper: false }).run();
    const original = liveExec.swap.bind(liveExec);
    let fill: Awaited<ReturnType<typeof original>>;
    vi.spyOn(liveExec, 'swap').mockImplementation(async (p) => {
      fill = await original(p);
      p.onSubmit?.({ signature: fill.signature, blockhash: 'hash', route: 'jupiter', tip: 0, sentAt: fill.sentAt });
      throw new Error('connection lost');
    });
    await feed(traderTx('lost-buy', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    expect(openLots()).toHaveLength(0);
    expect(trades()[0].signature).toBe(fill!.signature);
    await feed(traderTx('blocked-buy', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n, mint: 'Mint2' }));
    expect(trades()[1].skipReason).toMatch(/unresolved/);
    (liveExec as Executor).recover = async () => fill!;
    engine = new CopyEngine(deps); // Simulate a fresh process using the persisted records.
    await engine.recoverPending();
    await engine.recoverPending();
    expect(openLots()).toHaveLength(1);
    expect(openLots()[0].tokenAmount).toBe(fill!.outAmount.toString());
    expect(trades()[0].status).toBe('confirmed');
  });

  it('keeps an unknown submitted trade pending on RPC failure, then marks proven expiry failed', async () => {
    liveTrading = true;
    db.update(traderGroups).set({ paper: false }).run();
    vi.spyOn(liveExec, 'swap').mockImplementation(async (p) => {
      p.onSubmit?.({ signature: 'unknown', blockhash: 'hash', route: 'jupiter', tip: 0, sentAt: Date.now() });
      throw new Error('timeout');
    });
    await feed(traderTx('unknown', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    (liveExec as Executor).recover = async () => { throw new Error('RPC unavailable'); };
    await engine.recoverPending();
    expect(trades()[0].status).toBe('sent');
    (liveExec as Executor).recover = async () => { throw new SwapError('expired', 'unknown', true); };
    await engine.recoverPending();
    expect(trades()[0].status).toBe('failed');
    expect(openLots()).toHaveLength(0);
  });

  it('retries only after a submitted transaction has definitively failed', async () => {
    liveTrading = true;
    db.update(traderGroups).set({ paper: false }).run();
    await feed(traderTx('buy', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    const original = liveExec.swap.bind(liveExec);
    let calls = 0;
    vi.spyOn(liveExec, 'swap').mockImplementation(async (p) => {
      if (++calls === 1) {
        p.onSubmit?.({ signature: 'failed-sig', blockhash: 'hash', route: 'pumpfun', tip: 0, sentAt: Date.now() });
        throw new SwapError('on-chain failure', 'failed-sig', true);
      }
      return original(p);
    });
    await feed(traderTx('sell', { solBefore: 18 * SOL, solAfter: 19 * SOL, tokBefore: 1_000_000n, tokAfter: 0n }));
    expect(calls).toBe(2);
    expect(trades()[1].status).toBe('confirmed');
    expect(trades()[1].attempts).toBe(2);
  });

  it('sizes against SOL + stablecoins: 2 SOL ($200) of 20 SOL + $1800 USDC = 5%', async () => {
    traderStables = new Map([['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', { raw: 1_800_000_000n, decimals: 6 }]]);
    await feed(traderTx('cash', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    const [buy] = trades();
    expect(buy.pct).toBeCloseTo(200 / 3800, 6);
    expect(buy.solLamports).toBe(Math.floor((200 / 3800) * 9.98 * SOL));
    const sig = db.select().from(signals).get()!;
    expect(sig.basisUsd).toBeCloseTo(3800, 3);
    expect(sig.spentUsd).toBeCloseTo(200, 3);
  });

  describe('"copy a % of their size" mode', () => {
    beforeEach(() => {
      // 10% of their dollars, $3 minimum, $50 per token, at most 50% of the balance per buy.
      db.update(traderGroups).set({ sizingMode: 'size', copyPct: 10, minUsd: 3, maxUsdPerToken: 50, maxPct: 50 }).run();
    });
    const usd = (lamports: number) => (lamports / SOL) * SOL_USD;

    it('copies 10% of their dollar amount, and adds keep the same shape', async () => {
      // They spend 2 SOL = $200 → you spend $20.
      await feed(traderTx('b1', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
      // They add 1 SOL = $100 → you add $10.
      await feed(traderTx('b2', { solBefore: 18 * SOL, solAfter: 17 * SOL, tokBefore: 1_000_000n, tokAfter: 1_500_000n }));
      const [a, b] = trades();
      expect(usd(a.solLamports!)).toBeCloseTo(20, 2);
      expect(usd(b.solLamports!)).toBeCloseTo(10, 2);
      expect(db.select().from(signals).all()[0].spentUsd).toBeCloseTo(200, 3);
    });

    it('raises tiny copies to the $3 minimum', async () => {
      // They spend 0.1 SOL = $10 → 10% would be $1 → you spend $3.
      await feed(traderTx('t', { solBefore: 20 * SOL, solAfter: 19.9 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
      const [t] = trades();
      expect(usd(t.solLamports!)).toBeCloseTo(3, 2);
      expect(t.skipReason).toMatch(/raised to the \$3\.00 minimum/);
    });

    it("uses at most the max % of your balance when you can't afford the full copy", async () => {
      // Paper balance 1 SOL ($100). They spend 10 SOL = $1000 → 10% = $100 > what you have.
      db.update(traderGroups).set({ paperStartSol: 1 }).run();
      await feed(traderTx('w', { solBefore: 100 * SOL, solAfter: 90 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
      const [t] = trades();
      // (1 − 0.02 reserve) × 50% = 0.49 SOL = $49
      expect(usd(t.solLamports!)).toBeCloseTo(49, 1);
      expect(t.skipReason).toMatch(/can't afford the full \$100 copy/);
    });

    it('stops adding once the per-token budget is full', async () => {
      // Two $40 copies: the second is cut to the $10 left in the $50 budget, a third is skipped.
      await feed(traderTx('a', { solBefore: 100 * SOL, solAfter: 96 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
      await feed(traderTx('b', { solBefore: 96 * SOL, solAfter: 92 * SOL, tokBefore: 1_000_000n, tokAfter: 2_000_000n }));
      await feed(traderTx('c', { solBefore: 92 * SOL, solAfter: 88 * SOL, tokBefore: 2_000_000n, tokAfter: 3_000_000n }));
      const [a, b, c] = trades();
      expect(usd(a.solLamports!)).toBeCloseTo(40, 1);
      // Cost basis includes the paper fee, so slightly under $10 is left.
      expect(usd(b.solLamports!)).toBeGreaterThan(9.9);
      expect(usd(b.solLamports!)).toBeLessThanOrEqual(10);
      expect(c.status).toBe('skipped');
      expect(c.skipReason).toMatch(/budget/);
    });

    it('is the same for every wallet in the group (side wallets included)', async () => {
      const sideBuy = traderTx('s', { solBefore: 3 * SOL, solAfter: 2 * SOL, tokBefore: 0n, tokAfter: 1_000_000n });
      sideBuy.tx.accountKeys[0] = OTHER;
      sideBuy.tx.preTokenBalances[0].owner = OTHER;
      sideBuy.tx.postTokenBalances[0].owner = OTHER;
      await feed(sideBuy);
      // Side wallet spends 1 SOL = $100 → $10, even though that was 33% of its balance.
      expect(usd(trades()[0].solLamports!)).toBeCloseTo(10, 2);
    });
  });
  it('max open positions 0 means no limit', async () => {
    db.update(traderGroups).set({ maxOpenPositions: 0 }).run();
    const OTHER_MINT = 'Mint2111111111111111111111111111111111111111';
    await feed(traderTx('p1', { solBefore: 20 * SOL, solAfter: 18 * SOL, tokBefore: 0n, tokAfter: 1_000_000n }));
    await feed(traderTx('p2', { solBefore: 18 * SOL, solAfter: 16 * SOL, tokBefore: 0n, tokAfter: 1_000_000n, mint: OTHER_MINT }));
    expect(trades().every((t) => t.status === 'confirmed')).toBe(true);
    expect(openLots()).toHaveLength(2);
  });
});

describe('token checks', () => {
  const fee = (newer: number, older: number) => ({
    extension: 'transferFeeConfig',
    state: { newerTransferFee: { transferFeeBasisPoints: newer }, olderTransferFee: { transferFeeBasisPoints: older } },
  });

  it('reads the transfer fee separately from the risky extensions', () => {
    expect(transferFeeBps([fee(100, 100)])).toBe(100);
    expect(transferFeeBps([fee(300, 100)])).toBe(300); // a scheduled raise counts
    expect(transferFeeBps([fee(0, 0)])).toBeNull();
    expect(transferFeeBps([])).toBeNull();
    expect(riskyExtensions([fee(100, 100)])).toEqual([]);
    expect(riskyExtensions([fee(100, 100), { extension: 'transferHook', state: { programId: 'X' } }])).toEqual(['transfer hook']);
  });
});
