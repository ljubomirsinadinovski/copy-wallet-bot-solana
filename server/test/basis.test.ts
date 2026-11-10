import { describe, expect, it } from 'vitest';
import { cashBasis, missingCash } from '../src/engine/basis.js';
import { parseWalletTrades } from '../src/parser/parseTrades.js';
import { USDC_MINT, USDT_MINT, USD1_MINT } from '../src/solana/constants.js';
import type { NormalizedTx, TokenBalance } from '../src/stream/types.js';

const W = 'Wallet1111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const SOL = 1_000_000_000;
const RENT = 2_039_280;
const FEE = 5_000;
const SOL_USD = 100;
const usd = (n: number) => BigInt(Math.round(n * 1e6)); // 6-decimal stablecoins

const tb = (accountIndex: number, mint: string, amount: bigint | number, owner = W, decimals = 6): TokenBalance => ({ accountIndex, mint, owner, amount: String(amount), decimals });
const tx = (p: Partial<NormalizedTx> & Pick<NormalizedTx, 'accountKeys' | 'preBalances' | 'postBalances'>): NormalizedTx => ({
  signature: 's',
  slot: 1,
  blockTime: null,
  err: null,
  fee: FEE,
  preTokenBalances: [],
  postTokenBalances: [],
  logs: ['Program log: Instruction: Buy'],
  ...p,
});
const noCash = { lamports: null, stables: new Map() };
const cash = (entries: Array<[string, number]>, lamports: number | null = null) => ({
  lamports,
  stables: new Map(entries.map(([m, v]) => [m, { raw: usd(v), decimals: 6 }])),
});

/** Trader buys MINT with `spendSol` SOL from a wallet holding `solBefore` SOL. */
function solBuy(solBefore: number, spendSol: number) {
  return tx({
    accountKeys: [W, 'Ata1111111111111111111111111111111111111111'],
    preBalances: [solBefore * SOL, 0],
    postBalances: [(solBefore - spendSol) * SOL - FEE - RENT, RENT],
    postTokenBalances: [tb(1, MINT, 1000)],
  });
}

describe('trader cash basis (SOL + USDC + USDT + USD1)', () => {
  it('side wallet with only SOL: 1 of 10 SOL = 10%', () => {
    const t = solBuy(10, 1);
    const [trade] = parseWalletTrades(t, W);
    const b = cashBasis(trade, t, SOL_USD, noCash)!;
    expect(b.basisUsd).toBeCloseTo(1000, 6);
    expect(b.spentUsd).toBeCloseTo(100, 6);
    expect(b.pct).toBeCloseTo(0.1, 9);
  });

  it('counts stablecoins the trade did not touch: $100 of SOL with $900 USDC on the side = 10%, not 100%', () => {
    const t = solBuy(1, 1);
    const [trade] = parseWalletTrades(t, W);
    expect(trade.pct).toBe(1); // share of SOL alone
    expect(missingCash(t, W)).toEqual({ stables: [USDC_MINT, USDT_MINT, USD1_MINT], sol: false });
    const b = cashBasis(trade, t, SOL_USD, cash([[USDC_MINT, 900]]))!;
    expect(b.pct).toBeCloseTo(0.1, 9);
  });

  it('fomo-style USDC buyer: $100 of $1000 USDC (+ a little SOL for fees)', () => {
    const t = tx({
      accountKeys: [W, 'UsdcAta1111111111111111111111111111111111111', 'Ata1111111111111111111111111111111111111111'],
      preBalances: [0.05 * SOL, RENT, 0],
      postBalances: [0.05 * SOL - FEE - RENT, RENT, RENT],
      preTokenBalances: [tb(1, USDC_MINT, usd(1000))],
      postTokenBalances: [tb(1, USDC_MINT, usd(900)), tb(2, MINT, 1000)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.quoteMint).toBe(USDC_MINT);
    // USDC comes from the transaction (exact); USDT/USD1 are read separately.
    expect(missingCash(t, W).stables).toEqual([USDT_MINT, USD1_MINT]);
    const b = cashBasis(trade, t, SOL_USD, cash([[USDT_MINT, 0]]))!;
    expect(b.basisUsd).toBeCloseTo(1005, 6);
    expect(b.pct).toBeCloseTo(100 / 1005, 9);
  });

  it('mixed: $100 USDC buy, $500 USDC + $400 USDT + 1 SOL = 10%', () => {
    const t = tx({
      accountKeys: [W, 'UsdcAta1111111111111111111111111111111111111', 'Ata1111111111111111111111111111111111111111'],
      preBalances: [1 * SOL, RENT, 0],
      postBalances: [1 * SOL - FEE - RENT, RENT, RENT],
      preTokenBalances: [tb(1, USDC_MINT, usd(500))],
      postTokenBalances: [tb(1, USDC_MINT, usd(400)), tb(2, MINT, 1000)],
    });
    const [trade] = parseWalletTrades(t, W);
    const b = cashBasis(trade, t, SOL_USD, cash([[USDT_MINT, 400]]))!;
    expect(b.basisUsd).toBeCloseTo(1000, 6);
    expect(b.pct).toBeCloseTo(0.1, 9);
  });

  it('relayed wallet that is not in the transaction: its SOL is read separately', () => {
    const t = tx({
      accountKeys: ['Relayer11111111111111111111111111111111111', 'UsdcAta1111111111111111111111111111111111111', 'Ata1111111111111111111111111111111111111111'],
      preBalances: [1 * SOL, RENT, RENT],
      postBalances: [1 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, USDC_MINT, usd(300)), tb(2, MINT, 0)],
      postTokenBalances: [tb(1, USDC_MINT, usd(200)), tb(2, MINT, 1000)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(missingCash(t, W).sol).toBe(true);
    const b = cashBasis(trade, t, SOL_USD, cash([], 7 * SOL))!;
    expect(b.basisUsd).toBeCloseTo(300 + 700, 6);
    expect(b.pct).toBeCloseTo(0.1, 9);
  });

  it('keeps the old rule for buys paid in other tokens', () => {
    const SPCX = 'Spcx111111111111111111111111111111111111111';
    const t = tx({
      accountKeys: [W, 'A', 'B'],
      preBalances: [1 * SOL, RENT, RENT],
      postBalances: [1 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, SPCX, 1000), tb(2, MINT, 0)],
      postTokenBalances: [tb(1, SPCX, 750), tb(2, MINT, 50)],
    });
    const [trade] = parseWalletTrades(t, W, new Set([USDC_MINT, SPCX]));
    expect(cashBasis(trade, t, SOL_USD, noCash)).toBeNull();
  });
});
