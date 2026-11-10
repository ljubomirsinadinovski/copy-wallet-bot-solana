import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getPumpProgram,
  getSellSolAmountFromTokenAmount,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, canonicalPumpPoolPda, sellBaseInput } from '@pump-fun/pump-swap-sdk';
import type { Venue } from '../parser/parseTrades.js';
import { errorMessage } from '../util/misc.js';

/** The trade can't be done directly (not a pump token, non-SOL pool, …). Nothing was sent; use Jupiter. */
export class NotRoutableError extends Error {}

export interface BuiltSwap {
  route: 'pumpfun' | 'pumpswap';
  instructions: TransactionInstruction[];
  /** Expected output before slippage: tokens for a buy, lamports for a sell. */
  expectedOut: bigint;
  /** Minimum accepted output after slippage. */
  minOut: bigint;
  computeUnits: number;
}

const toBN = (v: bigint | number) => new BN(v.toString());
const toBig = (v: BN) => BigInt(v.toString());
const isSol = (mint: PublicKey) => mint.equals(PublicKey.default) || mint.equals(NATIVE_MINT);
const notSol = (quote: PublicKey) => {
  const q = quote.toBase58();
  return `bonding curve is priced in ${q.slice(0, 4)}…${q.slice(-4)} (another token), not SOL`;
};
const afterSlippage = (v: bigint, pct: number) => (v * BigInt(Math.round((100 - pct) * 100))) / 10_000n;

// Compute budgets. Measured on mainnet (scripts/verifyPump.ts): curve buy ~72k, curve sell ~58k,
// pool buy ~104k, pool sell ~90k – plus room for creating a token account. Keeping the limit tight
// matters: the priority fee is spread over the limit, so a smaller limit bids more per unit.
const CU = { curveBuy: 130_000, curveSell: 95_000, poolBuy: 165_000, poolSell: 135_000 };

/**
 * Builds pump.fun bonding-curve and PumpSwap trades locally with the official SDKs – no aggregator
 * round trip. Reading the curve or pool is a single RPC request; the protocol's global/fee config is
 * cached.
 */
export class PumpDirect {
  private online: OnlinePumpSdk;
  private amm: OnlinePumpAmmSdk;
  private program: ReturnType<typeof getPumpProgram>;
  private globals: { global: Global; feeConfig: FeeConfig; at: number } | null = null;
  private globalsLoading: Promise<{ global: Global; feeConfig: FeeConfig }> | null = null;

  constructor(connection: Connection) {
    this.online = new OnlinePumpSdk(connection);
    this.amm = new OnlinePumpAmmSdk(connection);
    this.program = getPumpProgram(connection);
  }

  /** pump.fun's global + fee config, cached for 10 minutes. */
  async loadGlobals(): Promise<{ global: Global; feeConfig: FeeConfig }> {
    if (this.globals && Date.now() - this.globals.at < 10 * 60_000) return this.globals;
    if (!this.globalsLoading) {
      this.globalsLoading = Promise.all([this.online.fetchGlobal(), this.online.fetchFeeConfig()])
        .then(([global, feeConfig]) => {
          this.globals = { global, feeConfig, at: Date.now() };
          return this.globals;
        })
        .finally(() => {
          this.globalsLoading = null;
        });
    }
    return this.globalsLoading;
  }

  async buildBuy(p: { mint: string; user: string; lamports: bigint; slippagePct: number; tokenProgram: string; hint: Venue }): Promise<BuiltSwap> {
    const mint = new PublicKey(p.mint);
    const user = new PublicKey(p.user);
    const tokenProgram = new PublicKey(p.tokenProgram);
    if (p.hint !== 'pumpswap') {
      const [state, globals] = await Promise.all([this.online.fetchBuyState(mint, user, tokenProgram).catch(() => null), this.loadGlobals()]);
      if (!state) await this.explainCurve(mint);
      if (state && !state.bondingCurve.complete) {
        const bc = state.bondingCurve;
        if (!isSol(bc.quoteMint)) throw new NotRoutableError(notSol(bc.quoteMint));
        const expected = toBig(
          getBuyTokenAmountFromSolAmount({
            ...globals,
            mintSupply: bc.tokenTotalSupply,
            bondingCurve: bc,
            amount: toBN(p.lamports),
            quoteMint: bc.quoteMint,
            creatorFeeBps: bc.creatorFeeBps,
          }),
        );
        if (expected <= 0n) throw new NotRoutableError('bonding curve has no tokens left');
        const minOut = afterSlippage(expected, p.slippagePct);
        const instructions = await PUMP_SDK.buyInstructions({
          global: globals.global,
          bondingCurveAccountInfo: state.bondingCurveAccountInfo,
          bondingCurve: bc,
          associatedUserAccountInfo: state.associatedUserAccountInfo,
          mint,
          user,
          amount: toBN(expected),
          solAmount: toBN(p.lamports),
          slippage: 0,
          tokenProgram,
        });
        this.toExactSolIn(instructions, p.lamports, minOut);
        return { route: 'pumpfun', instructions, expectedOut: expected, minOut, computeUnits: CU.curveBuy };
      }
    }
    // Graduated (or the trader used PumpSwap): trade in the canonical pool.
    const state = await this.poolState(mint, user);
    const r = buyQuoteInput({ ...this.poolArgs(state), quote: toBN(p.lamports), slippage: p.slippagePct });
    const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, toBN(p.lamports), p.slippagePct);
    return { route: 'pumpswap', instructions, expectedOut: toBig(r.base), minOut: afterSlippage(toBig(r.base), p.slippagePct), computeUnits: CU.poolBuy };
  }

  async buildSell(p: { mint: string; user: string; amount: bigint; slippagePct: number; tokenProgram: string; hint: Venue }): Promise<BuiltSwap> {
    const mint = new PublicKey(p.mint);
    const user = new PublicKey(p.user);
    const tokenProgram = new PublicKey(p.tokenProgram);
    if (p.hint !== 'pumpswap') {
      const [state, globals] = await Promise.all([this.online.fetchSellState(mint, user, tokenProgram).catch(() => null), this.loadGlobals()]);
      if (!state) await this.explainCurve(mint);
      if (state && !state.bondingCurve.complete) {
        const bc: BondingCurve = state.bondingCurve;
        if (!isSol(bc.quoteMint)) throw new NotRoutableError(notSol(bc.quoteMint));
        const expected = getSellSolAmountFromTokenAmount({ ...globals, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: toBN(p.amount) });
        const instructions = await PUMP_SDK.sellInstructions({
          global: globals.global,
          bondingCurveAccountInfo: state.bondingCurveAccountInfo,
          bondingCurve: bc,
          mint,
          user,
          amount: toBN(p.amount),
          solAmount: expected,
          slippage: p.slippagePct,
          tokenProgram,
          mayhemMode: bc.isMayhemMode,
          cashback: bc.isCashbackCoin,
        });
        return {
          route: 'pumpfun',
          instructions,
          expectedOut: toBig(expected),
          minOut: afterSlippage(toBig(expected), p.slippagePct),
          computeUnits: CU.curveSell,
        };
      }
    }
    const state = await this.poolState(mint, user);
    const r = sellBaseInput({
      ...this.poolArgs(state),
      feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees),
      base: toBN(p.amount),
      slippage: p.slippagePct,
    });
    const instructions = await PUMP_AMM_SDK.sellBaseInput(state, toBN(p.amount), p.slippagePct);
    return { route: 'pumpswap', instructions, expectedOut: toBig(r.uiQuote), minOut: toBig(r.minQuote), computeUnits: CU.poolSell };
  }

  /** The curve couldn't be loaded for trading: if it exists but is priced in another token, say so. */
  private async explainCurve(mint: PublicKey) {
    const bc = await this.online.fetchBondingCurve(mint).catch(() => null);
    if (bc && !bc.complete && !isSol(bc.quoteMint)) throw new NotRoutableError(notSol(bc.quoteMint));
  }

  private async poolState(mint: PublicKey, user: PublicKey) {
    let state;
    try {
      state = await this.amm.swapSolanaState(canonicalPumpPoolPda(mint), user);
    } catch (err) {
      throw new NotRoutableError(`no pump.fun curve or PumpSwap pool for this token (${errorMessage(err)})`);
    }
    if (!isSol(state.pool.quoteMint)) throw new NotRoutableError('PumpSwap pool is not priced in SOL');
    return state;
  }

  private poolArgs(state: Awaited<ReturnType<OnlinePumpAmmSdk['swapSolanaState']>>) {
    return {
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
      quoteMint: state.pool.quoteMint,
      isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps,
    };
  }

  /**
   * The SDK builds the legacy `buy` (buy N tokens, pay up to X). We want "spend exactly X SOL, get at
   * least N tokens" so the copy size is exact; `buy_exact_sol_in` takes the identical account list,
   * so only the instruction data changes.
   */
  private toExactSolIn(instructions: TransactionInstruction[], lamports: bigint, minOut: bigint) {
    const buy = instructions.find((ix) => ix.programId.equals(PUMP_PROGRAM_ID));
    if (!buy) throw new NotRoutableError('pump.fun buy instruction missing');
    buy.data = this.program.coder.instruction.encode('buyExactSolIn', {
      spendableSolIn: toBN(lamports),
      minTokensOut: toBN(minOut),
      trackVolume: { 0: true },
      partialFill: { 0: false },
    });
  }
}
