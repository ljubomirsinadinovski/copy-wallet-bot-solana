/**
 * Reads a pump.fun coin's reserves straight from the chain: the bonding curve while the coin is on
 * it, the PumpSwap pool after it graduated. One RPC request (1 Helius credit) per read once the
 * pool's vault addresses are known. Coins priced in SOL or in USDC are supported.
 */
import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPdaWithQuote, isSolLikeQuoteMint, isStableQuoteMint } from '@pump-fun/pump-sdk';
import { PUMP_AMM_SDK, canonicalPumpPoolPda } from '@pump-fun/pump-swap-sdk';
import { PRIORITY, type RpcClient } from '../../server/src/solana/rpc.js';

export interface Market {
  venue: 'pumpfun' | 'pumpswap';
  /** Token reserve used for pricing (raw units). */
  base: bigint;
  /** Quote reserve used for pricing (raw units of SOL or USDC), including any virtual part. */
  quote: bigint;
  /** What the coin is priced in: SOL, or a USD stablecoin (USDC). */
  quoteKind: 'sol' | 'usd';
  quoteDecimals: number;
}

type RpcAccount = { data: [string, string]; owner: string; lamports: number; executable: boolean; rentEpoch: number } | null;

const toBig = (v: BN) => BigInt(v.toString());
/** SPL token account layout: the amount is the u64 at byte 64 (same for Token-2022). */
const tokenAmount = (a: AccountInfo<Buffer>) => a.data.readBigUInt64LE(64);

function quoteOf(mint: PublicKey): Pick<Market, 'quoteKind' | 'quoteDecimals'> {
  if (isSolLikeQuoteMint(mint)) return { quoteKind: 'sol', quoteDecimals: 9 };
  if (isStableQuoteMint(mint)) return { quoteKind: 'usd', quoteDecimals: 6 };
  throw new Error('this coin is priced in another token (not SOL or USDC) – sell plans can’t follow it');
}

export class MarketReader {
  private vaults = new Map<string, { base: PublicKey; quote: PublicKey }>();
  /** Quote mint from the curve (still there after graduation): it decides which pool is the coin's. */
  private quoteMints = new Map<string, PublicKey>();
  private graduated = new Set<string>();

  constructor(private readonly rpc: RpcClient) {}

  async read(mint: string): Promise<Market> {
    const m = new PublicKey(mint);
    if (!this.graduated.has(mint)) {
      const [curve] = await this.accounts([bondingCurvePda(m)]);
      if (curve) {
        const bc = PUMP_SDK.decodeBondingCurve(curve);
        const q = quoteOf(bc.quoteMint);
        this.quoteMints.set(mint, bc.quoteMint);
        if (!bc.complete) return { venue: 'pumpfun', base: toBig(bc.virtualTokenReserves), quote: toBig(bc.virtualQuoteReserves), ...q };
      }
      this.graduated.add(mint);
    }
    const quoteMint = this.quoteMints.get(mint) ?? NATIVE_MINT;
    const poolKey = quoteMint.equals(PublicKey.default) || quoteMint.equals(NATIVE_MINT) ? canonicalPumpPoolPda(m) : canonicalPumpPoolPdaWithQuote(m, quoteMint);
    let vaults = this.vaults.get(mint);
    if (!vaults) {
      const [poolAcc] = await this.accounts([poolKey]);
      if (!poolAcc) throw new Error('no pump.fun curve or PumpSwap pool found for this coin – sell plans need one');
      const pool = PUMP_AMM_SDK.decodePool(poolAcc);
      quoteOf(pool.quoteMint);
      vaults = { base: pool.poolBaseTokenAccount, quote: pool.poolQuoteTokenAccount };
      this.vaults.set(mint, vaults);
    }
    const [poolAcc, baseAcc, quoteAcc] = await this.accounts([poolKey, vaults.base, vaults.quote]);
    if (!poolAcc || !baseAcc || !quoteAcc) throw new Error('PumpSwap pool accounts not found');
    const pool = PUMP_AMM_SDK.decodePool(poolAcc);
    // The pool prices with vault balance + virtual quote reserves (see pump-swap-sdk's sellBaseInput).
    return { venue: 'pumpswap', base: tokenAmount(baseAcc), quote: tokenAmount(quoteAcc) + toBig(pool.virtualQuoteReserves), ...quoteOf(pool.quoteMint) };
  }

  private async accounts(keys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>> {
    const res = await this.rpc.call<{ value: RpcAccount[] }>(
      'getMultipleAccounts',
      [keys.map((k) => k.toBase58()), { encoding: 'base64', commitment: 'confirmed' }],
      PRIORITY.normal,
    );
    return res.value.map((a) =>
      a ? { data: Buffer.from(a.data[0], 'base64'), owner: new PublicKey(a.owner), lamports: a.lamports, executable: a.executable, rentEpoch: a.rentEpoch } : null,
    );
  }
}
