import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectVenue, parseWalletTrades } from '../src/parser/parseTrades.js';
import { USDC_MINT, WSOL_MINT } from '../src/solana/constants.js';
import { normalizeTransaction } from '../src/stream/normalize.js';
import type { NormalizedTx, TokenBalance } from '../src/stream/types.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const fixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

function loadFixture(name: string) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  const tx = normalizeTransaction({ ...fx.raw, signature: fx.raw.transaction.signatures[0] })!;
  return { ...fx, tx, trades: parseWalletTrades(tx, fx.wallet) };
}

describe('real mainnet transactions', () => {
  it('has fixtures', () => expect(fixtures.length).toBeGreaterThan(5));

  for (const name of fixtures) {
    const expectedSide = name.includes('-buy-') ? 'buy' : 'sell';
    it(`${name}: detects a ${expectedSide}`, () => {
      const { trades, pumpEvent, tx } = loadFixture(name);
      const main = trades.find((t: any) => t.side === expectedSide)!;
      expect(main).toBeDefined();
      expect(main.tokenAmount).toBeGreaterThan(0n);
      expect(main.pct).toBeGreaterThan(0);
      expect(main.pct).toBeLessThanOrEqual(1);
      expect(main.signature).toBe(tx.signature);
      if (main.fullExit) expect(main.pct).toBe(1);
      // Venue comes from the program IDs in the trader's own transaction.
      if (name.startsWith('pumpfun')) expect(main.venue).toBe('pumpfun');
      if (name.startsWith('pumpswap')) expect(main.venue).toBe('pumpswap');
      expect(main.venue).not.toBeNull();

      if (pumpEvent) {
        // pump.fun's own TradeEvent is an independent source of truth.
        expect(main.mint).toBe(pumpEvent.mint);
        expect(main.tokenAmount).toBe(BigInt(pumpEvent.tokenAmount));
        expect(pumpEvent.isBuy).toBe(expectedSide === 'buy');
        if (main.quoteMint === WSOL_MINT && BigInt(pumpEvent.solAmount) > 0n) {
          const ev = Number(pumpEvent.solAmount);
          const q = Number(main.quoteAmount);
          // Buys pay pump.fun's fee on top of the curve amount, sells receive net of it.
          if (expectedSide === 'buy') expect(q).toBeGreaterThanOrEqual(ev);
          else expect(q).toBeLessThanOrEqual(ev);
          expect(Math.abs(q - ev) / ev).toBeLessThan(0.03);
        }
      }
    });
  }

  it('reads the trader, not the relayer, when someone else pays the fee', () => {
    const relayed = fixtures.map(loadFixture).filter((f) => f.relayed);
    for (const f of relayed) {
      expect(f.tx.accountKeys[0]).not.toBe(f.wallet);
      expect(f.trades.length).toBeGreaterThan(0);
      // The relayer itself has no trade.
      expect(parseWalletTrades(f.tx, f.tx.accountKeys[0]).filter((t) => t.mint === f.trades[0].mint)).toHaveLength(0);
    }
  });
});

// ── synthetic edge cases ────────────────────────────────────────────────────

const W = 'Wallet1111111111111111111111111111111111111';
const RELAYER = 'Relayer111111111111111111111111111111111111';
const ATA = 'Ata11111111111111111111111111111111111111111';
const WSOL_ATA = 'WsolAta1111111111111111111111111111111111111';
const USDC_ATA = 'UsdcAta1111111111111111111111111111111111111';
const POOL = 'Pool111111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const SOL = 1_000_000_000;
const RENT = 2_039_280;
const FEE = 5_000;

function tb(accountIndex: number, mint: string, amount: bigint | number, owner = W, decimals = 6): TokenBalance {
  return { accountIndex, mint, owner, amount: String(amount), decimals };
}

const DEX_LOGS = ['Program log: Instruction: Buy'];

/** A transaction that went through a DEX unless `logs`/`accountKeys` say otherwise. */
function tx(p: Partial<NormalizedTx> & Pick<NormalizedTx, 'accountKeys' | 'preBalances' | 'postBalances'>): NormalizedTx {
  return { signature: 'sig', slot: 1, blockTime: null, err: null, fee: FEE, preTokenBalances: [], postTokenBalances: [], logs: DEX_LOGS, ...p };
}

describe('parser edge cases', () => {
  it('buy: excludes the network fee and new token-account rent from the size', () => {
    const t = tx({
      accountKeys: [W, ATA, POOL],
      preBalances: [10 * SOL, 0, 50 * SOL],
      postBalances: [10 * SOL - 1 * SOL - RENT - FEE, RENT, 51 * SOL],
      postTokenBalances: [tb(1, MINT, 1000)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('buy');
    expect(trade.quoteMint).toBe(WSOL_MINT);
    expect(trade.quoteAmount).toBe(BigInt(SOL));
    expect(trade.pct).toBeCloseTo(0.1, 9);
    expect(trade.tokenAmount).toBe(1000n);
  });

  it('relayed buy: does not add a fee the wallet did not pay', () => {
    const t = tx({
      accountKeys: [RELAYER, W, ATA, POOL],
      preBalances: [1 * SOL, 5 * SOL, RENT, 50 * SOL],
      postBalances: [1 * SOL - FEE, 4.5 * SOL, RENT, 50.5 * SOL],
      preTokenBalances: [tb(2, MINT, 0)],
      postTokenBalances: [tb(2, MINT, 777)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('buy');
    expect(trade.quoteAmount).toBe(BigInt(0.5 * SOL));
    expect(trade.pct).toBeCloseTo(0.1, 9);
  });

  it('buy paid from wrapped SOL counts WSOL in the balance', () => {
    // 1 SOL native + 2 SOL wrapped; spends 1.5 SOL of WSOL, closes the WSOL account.
    const t = tx({
      accountKeys: [W, WSOL_ATA, ATA, POOL],
      preBalances: [1 * SOL, RENT + 2 * SOL, RENT, 50 * SOL],
      postBalances: [1 * SOL + 0.5 * SOL + RENT - FEE, 0, RENT, 51.5 * SOL],
      preTokenBalances: [tb(1, WSOL_MINT, 2 * SOL, W, 9), tb(2, MINT, 0)],
      postTokenBalances: [tb(2, MINT, 5000)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('buy');
    expect(trade.quoteAmount).toBe(BigInt(1.5 * SOL));
    expect(trade.preQuoteBalance).toBe(BigInt(3 * SOL));
    expect(trade.pct).toBeCloseTo(0.5, 9);
  });

  it('buy paid in USDC is sized as a share of the USDC balance', () => {
    const t = tx({
      accountKeys: [W, USDC_ATA, ATA],
      preBalances: [1 * SOL, RENT, RENT],
      postBalances: [1 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, USDC_MINT, 100_000_000), tb(2, MINT, 0)],
      postTokenBalances: [tb(1, USDC_MINT, 60_000_000), tb(2, MINT, 42)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('buy');
    expect(trade.quoteMint).toBe(USDC_MINT);
    expect(trade.quoteAmount).toBe(40_000_000n);
    expect(trade.pct).toBeCloseTo(0.4, 9);
  });

  it('partial sell reports the share of the position sold', () => {
    const t = tx({
      accountKeys: [W, ATA],
      preBalances: [1 * SOL, RENT],
      postBalances: [1.3 * SOL - FEE, RENT],
      preTokenBalances: [tb(1, MINT, 1000)],
      postTokenBalances: [tb(1, MINT, 400)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('sell');
    expect(trade.pct).toBeCloseTo(0.6, 9);
    expect(trade.fullExit).toBe(false);
    expect(trade.quoteAmount).toBe(BigInt(0.3 * SOL));
  });

  it('selling all but dust counts as a full exit', () => {
    const t = tx({
      accountKeys: [W, ATA],
      preBalances: [1 * SOL, RENT],
      postBalances: [1.2 * SOL - FEE, RENT],
      preTokenBalances: [tb(1, MINT, 1000)],
      postTokenBalances: [tb(1, MINT, 5)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.fullExit).toBe(true);
    expect(trade.pct).toBe(1);
  });

  it('full sell that closes the token account does not count the rent refund as proceeds', () => {
    const t = tx({
      accountKeys: [W, ATA],
      preBalances: [1 * SOL, RENT],
      postBalances: [1.5 * SOL + RENT - FEE, 0],
      preTokenBalances: [tb(1, MINT, 1000)],
      postTokenBalances: [],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('sell');
    expect(trade.quoteAmount).toBe(BigInt(0.5 * SOL));
    expect(trade.fullExit).toBe(true);
  });

  it('sending tokens away is a transfer, not a sell', () => {
    const t = tx({
      logs: ['Program log: Instruction: TransferChecked'],
      accountKeys: [W, ATA, 'Other'],
      preBalances: [1 * SOL, RENT, RENT],
      postBalances: [1 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, MINT, 1000), tb(2, MINT, 0, 'OtherOwner')],
      postTokenBalances: [tb(1, MINT, 0), tb(2, MINT, 1000, 'OtherOwner')],
    });
    const trades = parseWalletTrades(t, W);
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('transfer_out');
  });

  it('receiving tokens without paying is a transfer in', () => {
    const t = tx({
      logs: [],
      accountKeys: ['Sender', ATA],
      preBalances: [1 * SOL, RENT],
      postBalances: [1 * SOL - FEE, RENT],
      preTokenBalances: [tb(1, MINT, 0)],
      postTokenBalances: [tb(1, MINT, 500)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('transfer_in');
  });

  it('a tiny SOL change (tip) with a token arriving is not treated as a buy', () => {
    const t = tx({
      accountKeys: [W, ATA],
      preBalances: [1 * SOL, RENT],
      postBalances: [1 * SOL - FEE - 50_000, RENT],
      preTokenBalances: [tb(1, MINT, 0)],
      postTokenBalances: [tb(1, MINT, 500)],
    });
    expect(parseWalletTrades(t, W)[0].side).toBe('transfer_in');
  });

  it('ignores failed transactions', () => {
    const t = tx({
      err: { InstructionError: [0, 'Custom'] },
      accountKeys: [W, ATA],
      preBalances: [1 * SOL, RENT],
      postBalances: [1 * SOL - FEE, RENT],
    });
    expect(parseWalletTrades(t, W)).toEqual([]);
  });

  it('token → token swap copies the exit but not the entry', () => {
    const OTHER = 'Other1111111111111111111111111111111111111';
    const t = tx({
      accountKeys: [W, ATA, 'Ata2'],
      preBalances: [1 * SOL, RENT, RENT],
      postBalances: [1 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, MINT, 1000), tb(2, OTHER, 0)],
      postTokenBalances: [tb(1, MINT, 0), tb(2, OTHER, 50)],
    });
    const trades = parseWalletTrades(t, W);
    expect(trades.find((x) => x.mint === MINT)!.side).toBe('sell');
    expect(trades.find((x) => x.mint === MINT)!.pct).toBe(1);
    expect(trades.find((x) => x.mint === OTHER)!.side).toBe('transfer_in');
  });

  it('treats a custom quote mint like USDC when configured', () => {
    const SPCX = 'Spcx111111111111111111111111111111111111111';
    const t = tx({
      accountKeys: [W, ATA, 'Ata2'],
      preBalances: [1 * SOL, RENT, RENT],
      postBalances: [1 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, SPCX, 1_000_000), tb(2, MINT, 0)],
      postTokenBalances: [tb(1, SPCX, 750_000), tb(2, MINT, 50)],
    });
    const [trade] = parseWalletTrades(t, W, new Set([USDC_MINT, SPCX]));
    expect(trade.side).toBe('buy');
    expect(trade.quoteMint).toBe(SPCX);
    expect(trade.pct).toBeCloseTo(0.25, 9);
  });
});

// ── withdrawals, deposits and bridges must never be copied ──────────────────

const EXCHANGE = 'Exchange111111111111111111111111111111111111';
const BRIDGE = 'Bridge1111111111111111111111111111111111111';

describe('withdrawals, bridges and cash-outs', () => {
  it('withdrawing SOL to an exchange is not a trade', () => {
    const t = tx({
      logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success'],
      accountKeys: [W, EXCHANGE],
      preBalances: [10 * SOL, 0],
      postBalances: [2 * SOL - FEE, 8 * SOL],
    });
    expect(parseWalletTrades(t, W)).toEqual([]);
  });

  it('sending memecoins to an exchange is a transfer, never a sell', () => {
    const t = tx({
      logs: ['Program log: Instruction: TransferChecked'],
      accountKeys: [W, ATA, 'ExchAta1111111111111111111111111111111111111'],
      preBalances: [1 * SOL, RENT, RENT],
      postBalances: [1 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, MINT, 1000), tb(2, MINT, 0, EXCHANGE)],
      postTokenBalances: [tb(1, MINT, 400), tb(2, MINT, 600, EXCHANGE)],
    });
    const trades = parseWalletTrades(t, W);
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('transfer_out');
    expect(trades[0].venue).toBeNull();
  });

  it('bridging USDC out is not a trade', () => {
    const t = tx({
      logs: ['Program log: Instruction: TransferTokens', 'Program log: Sequence: 1234'],
      accountKeys: [W, USDC_ATA, BRIDGE],
      preBalances: [1 * SOL, RENT, 1 * SOL],
      postBalances: [1 * SOL - FEE - 1_000_000, RENT, 1 * SOL + 1_000_000],
      preTokenBalances: [tb(1, USDC_MINT, 500_000_000)],
      postTokenBalances: [tb(1, USDC_MINT, 0)],
    });
    expect(parseWalletTrades(t, W)).toEqual([]);
  });

  it('a bridged-in token that cost a relayer fee is "received", not a buy', () => {
    const WRAPPED = 'Wrapped1111111111111111111111111111111111111';
    const t = tx({
      logs: ['Program log: Instruction: CompleteWrapped'],
      accountKeys: [W, ATA, BRIDGE],
      preBalances: [1 * SOL, 0, 1 * SOL],
      postBalances: [1 * SOL - FEE - RENT - 0.01 * SOL, RENT, 1.01 * SOL],
      postTokenBalances: [tb(1, WRAPPED, 5_000_000)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('transfer_in');
    expect(trade.note).toMatch(/without a DEX/);
  });

  it('selling on a DEX and withdrawing the SOL in the same transaction still counts as an exit', () => {
    const t = tx({
      accountKeys: [W, ATA, POOL, EXCHANGE],
      preBalances: [1 * SOL, RENT, 50 * SOL, 0],
      // +2 SOL from the sale, −3 SOL sent to the exchange
      postBalances: [0 * SOL - FEE + RENT + 1 * SOL - 1 * SOL, 0, 48 * SOL, 3 * SOL],
      preTokenBalances: [tb(1, MINT, 1000)],
      postTokenBalances: [],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('sell');
    expect(trade.fullExit).toBe(true);
  });

  it('detects the venue from program IDs, with zero extra lookups', () => {
    const base = { accountKeys: [W], preBalances: [0], postBalances: [0] };
    expect(detectVenue(tx({ ...base, accountKeys: [W, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], logs: [] }))).toBe('pumpfun');
    expect(detectVenue(tx({ ...base, accountKeys: [W, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'], logs: [] }))).toBe('pumpswap');
    expect(detectVenue(tx({ ...base, accountKeys: [W, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'], logs: [] }))).toBe('dex');
    expect(detectVenue(tx({ ...base, logs: ['Program log: Instruction: Swap'] }))).toBe('dex');
    expect(detectVenue(tx({ ...base, logs: ['Program log: Instruction: Transfer'] }))).toBeNull();
  });

  it('adding liquidity to a pool is not a sell (and not copied)', () => {
    const LP = 'LpMint11111111111111111111111111111111111111';
    const t = tx({
      logs: ['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]', 'Program log: Instruction: Deposit'],
      accountKeys: [W, ATA, 'LpAta111111111111111111111111111111111111111', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'],
      preBalances: [5 * SOL, RENT, 0, 1],
      postBalances: [4 * SOL - FEE - RENT, RENT, RENT, 1],
      preTokenBalances: [tb(1, MINT, 1000)],
      postTokenBalances: [tb(1, MINT, 500), tb(2, LP, 77)],
    });
    const trades = parseWalletTrades(t, W);
    expect(trades.find((x) => x.mint === MINT)!.side).toBe('transfer_out');
    expect(trades.find((x) => x.mint === LP)!.side).toBe('transfer_in');
    expect(trades.every((x) => x.side !== 'sell' && x.side !== 'buy')).toBe(true);
  });

  it('staking tokens is not a sell', () => {
    const RECEIPT = 'Receipt1111111111111111111111111111111111111';
    const t = tx({
      logs: ['Program log: Instruction: Stake'],
      accountKeys: [W, ATA, 'RcptAta11111111111111111111111111111111111111'],
      preBalances: [1 * SOL, RENT, RENT],
      postBalances: [1 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, MINT, 1000), tb(2, RECEIPT, 0)],
      postTokenBalances: [tb(1, MINT, 0), tb(2, RECEIPT, 1000)],
    });
    expect(parseWalletTrades(t, W).map((x) => x.side).sort()).toEqual(['transfer_in', 'transfer_out']);
  });

  it('a swap routed through a vault deposit is still a trade', () => {
    const t = tx({
      logs: ['Program log: Instruction: Route', 'Program log: Instruction: Deposit'],
      accountKeys: [W, ATA],
      preBalances: [2 * SOL, 0],
      postBalances: [1 * SOL - FEE - RENT, RENT],
      postTokenBalances: [tb(1, MINT, 1000)],
    });
    expect(parseWalletTrades(t, W)[0].side).toBe('buy');
  });

  it('flags a buy of a token created in the same transaction (dev launch)', () => {
    const t = tx({
      logs: ['Program log: Instruction: Create', 'Program log: Instruction: Buy'],
      accountKeys: [W, MINT, ATA, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
      preBalances: [5 * SOL, 0, 0, 1],
      postBalances: [4 * SOL - FEE - 2 * RENT, 1_461_600, RENT, 1],
      postTokenBalances: [tb(2, MINT, 1_000_000)],
    });
    const [trade] = parseWalletTrades(t, W);
    expect(trade.side).toBe('buy');
    expect(trade.createdInTx).toBe(true);
    expect(trade.venue).toBe('pumpfun');
  });
});

describe('one payment, several tokens', () => {
  const A = 'TokenA11111111111111111111111111111111111111';
  const B = 'TokenB11111111111111111111111111111111111111';
  const CURVE_A = 'CurveA11111111111111111111111111111111111111';
  const CURVE_B = 'CurveB11111111111111111111111111111111111111';

  it('real: a coin bought through another coin (USDC → SOL → GTA → BAWSAQ) is one buy of the whole amount', () => {
    for (const name of ['routed-buy-1.json', 'routed-buy-2.json']) {
      const { trades } = loadFixture(name);
      const buys = trades.filter((t: any) => t.side === 'buy');
      expect(buys).toHaveLength(1);
      expect(buys[0].mint).toBe('DkBdqHnJgCDxAV8YGcpoLARrp6bk9b1C5dmW6K4Zpump');
      expect(buys[0].note).toBe('routed through another token');
      // GTA – the coin BAWSAQ is priced in – is change left over from the route, never copied.
      const gta = trades.find((t: any) => t.mint === 'BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump');
      expect(gta.side).toBe('transfer_in');
    }
    // zups paid exactly $100 USDC, all of it for BAWSAQ (before the fix: $50 + $50).
    const zups = loadFixture('routed-buy-1.json').trades.find((t: any) => t.side === 'buy');
    expect(zups.quoteAmount).toBe(100_000_000n);
  });

  it('splits a genuine two-token buy by what each curve received', () => {
    // The wallet pays 3 SOL: curve A gets 1 SOL for 100 A, curve B gets 2 SOL for 200 B.
    const t = tx({
      accountKeys: [W, 'AtaA', 'AtaB', CURVE_A, CURVE_B, 'CurveAtaA', 'CurveAtaB'],
      preBalances: [10 * SOL, RENT, RENT, 50 * SOL, 50 * SOL, RENT, RENT],
      postBalances: [7 * SOL - FEE, RENT, RENT, 51 * SOL, 52 * SOL, RENT, RENT],
      preTokenBalances: [tb(1, A, 0), tb(2, B, 0), tb(5, A, 1000, CURVE_A), tb(6, B, 1000, CURVE_B)],
      postTokenBalances: [tb(1, A, 100), tb(2, B, 200), tb(5, A, 900, CURVE_A), tb(6, B, 800, CURVE_B)],
    });
    const trades = parseWalletTrades(t, W);
    expect(trades.map((x) => [x.mint, x.side, x.quoteAmount, x.note])).toEqual([
      [A, 'buy', BigInt(SOL), 'multi-buy'],
      [B, 'buy', BigInt(2 * SOL), 'multi-buy'],
    ]);
  });

  it('still splits evenly when the curves’ takings can’t be read', () => {
    const t = tx({
      accountKeys: [W, 'AtaA', 'AtaB'],
      preBalances: [10 * SOL, RENT, RENT],
      postBalances: [8 * SOL - FEE, RENT, RENT],
      preTokenBalances: [tb(1, A, 0), tb(2, B, 0)],
      postTokenBalances: [tb(1, A, 100), tb(2, B, 200)],
    });
    expect(parseWalletTrades(t, W).map((x) => x.quoteAmount)).toEqual([BigInt(SOL), BigInt(SOL)]);
  });

  it('a bundler buying for many wallets in one transaction is a full buy for each of them', () => {
    // The curve sells 3000 tokens to 30 wallets; each keeps 100 (3%).
    const wallets = Array.from({ length: 30 }, (_, i) => `Bundle${String(i).padStart(2, '0')}111111111111111111111111111111111`);
    const t = tx({
      accountKeys: [W, ...wallets.map((_, i) => `BAta${i}`), CURVE_A, 'CurveAtaA'],
      preBalances: [10 * SOL, ...wallets.map(() => RENT), 50 * SOL, RENT],
      postBalances: [7 * SOL - FEE, ...wallets.map(() => RENT), 53 * SOL, RENT],
      preTokenBalances: [...wallets.map((w, i) => tb(i + 1, A, 0, w)), tb(32, A, 10_000, CURVE_A)],
      postTokenBalances: [...wallets.map((w, i) => tb(i + 1, A, 100, w)), tb(32, A, 7_000, CURVE_A)],
    });
    const [trade] = parseWalletTrades(t, wallets[7]);
    expect(trade.side).toBe('transfer_in'); // these wallets didn't pay – the signer did
    const signerView = parseWalletTrades(
      { ...t, preTokenBalances: [...t.preTokenBalances, tb(40, A, 0, W)], postTokenBalances: [...t.postTokenBalances, tb(40, A, 100, W)] },
      W,
    );
    expect(signerView.find((x) => x.mint === A)!.side).toBe('buy');
  });

  it('a sell routed out through another coin keeps its SOL proceeds', () => {
    // The wallet sells 1000 A; the route leaves it 1 raw B; it receives 2 SOL.
    const t = tx({
      accountKeys: [W, 'AtaA', 'AtaB', CURVE_A, 'CurveAtaA', 'PoolB', 'PoolAtaB'],
      preBalances: [10 * SOL, RENT, RENT, 50 * SOL, RENT, 50 * SOL, RENT],
      postBalances: [12 * SOL - FEE, RENT, RENT, 50 * SOL, RENT, 48 * SOL, RENT],
      preTokenBalances: [tb(1, A, 1000), tb(2, B, 0), tb(4, A, 0, CURVE_A), tb(6, B, 50_000, 'PoolB')],
      postTokenBalances: [tb(1, A, 0), tb(2, B, 1), tb(4, A, 1000, CURVE_A), tb(6, B, 49_999 - 40_000, 'PoolB')],
    });
    const trades = parseWalletTrades(t, W);
    const sell = trades.find((x) => x.mint === A)!;
    expect(sell.side).toBe('sell');
    expect(sell.quoteAmount).toBe(BigInt(2 * SOL));
    expect(sell.note).toBe('routed through another token');
    expect(trades.find((x) => x.mint === B)!.side).toBe('transfer_in');
  });
});
