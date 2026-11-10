import crypto from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Logger } from 'pino';
import type { Keystore } from '../keystore/keystore.js';
import { walletDeltas, type Venue } from '../parser/parseTrades.js';
import { WSOL_MINT } from '../solana/constants.js';
import type { JupiterClient } from '../solana/jupiter.js';
import { PRIORITY, type RpcClient } from '../solana/rpc.js';
import { MIN_TIP_LAMPORTS, SenderRejectedError, tipInstruction, type SenderClient } from '../solana/sender.js';
import type { SettingsStore } from '../settings.js';
import { normalizeTransaction, type RawTransaction } from '../stream/normalize.js';
import { errorMessage, sleep, solToLamports } from '../util/misc.js';
import { NotRoutableError, type BuiltSwap, type PumpDirect } from './pump.js';

export interface SwapParams {
  wallet: string;
  inputMint: string;
  outputMint: string;
  /** Raw input amount (lamports when selling SOL). */
  amount: bigint;
  slippageBps: number | null;
  /** Where the trader traded (from their transaction), used to pick the fastest route. */
  venue?: Venue;
  /** Owner program of the token mint (SPL Token or Token-2022). */
  tokenProgram?: string;
  /** Persist synchronously before any network submission. */
  onSubmit?: (submission: Submission) => void;
}

export interface Submission {
  signature: string;
  blockhash: string;
  route: Route;
  tip: number;
  sentAt: number;
}

export type Route = 'pumpfun' | 'pumpswap' | 'jupiter';

export interface SwapFill {
  signature: string;
  inAmount: bigint;
  outAmount: bigint;
  feeLamports: number;
  sentAt: number;
  confirmedAt: number;
  route: Route;
}

export class SwapError extends Error {
  constructor(
    message: string,
    public readonly signature?: string,
    public readonly definitive = false,
  ) {
    super(message);
  }
}

export interface Executor {
  readonly paper: boolean;
  swap(p: SwapParams): Promise<SwapFill>;
  recover?(p: SwapParams, submission: Submission): Promise<SwapFill | null>;
}

const tokenMintOf = (p: SwapParams) => (p.inputMint === WSOL_MINT ? p.outputMint : p.inputMint);

/** Network + priority fees and token-account rent a swap may legitimately cost on top of its amount. */
const MAX_FEES_AND_RENT = 20_000_000; // 0.02 SOL

/**
 * Real trades through Jupiter Swap API v2: /order builds the transaction for your wallet, the bot
 * signs it in memory, and /execute lands it (priority fees, retries and confirmation handled by Jupiter).
 */
export class LiveExecutor implements Executor {
  readonly paper = false;

  constructor(
    private readonly jupiter: JupiterClient,
    private readonly keystore: Keystore,
    private readonly rpc: RpcClient,
    private readonly settings: SettingsStore,
  ) {}

  /**
   * The transaction comes from Jupiter's server, so before signing it is simulated and refused if it
   * would fail or take more SOL from your wallet than the trade itself (+ fees and rent headroom).
   */
  private async verify(tx: VersionedTransaction, p: SwapParams) {
    const conn = this.rpc.connection;
    const [before, sim] = await Promise.all([
      conn.getBalance(new PublicKey(p.wallet), 'confirmed'),
      conn.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [p.wallet] } }),
    ]);
    if (sim.value.err) throw new SwapError(`Jupiter transaction would fail: ${JSON.stringify(sim.value.err)}`);
    const after = sim.value.accounts?.[0]?.lamports;
    if (after == null) throw new SwapError('could not verify the Jupiter transaction (no simulation result)');
    const allowed = (p.inputMint === WSOL_MINT ? Number(p.amount) : 0) + MAX_FEES_AND_RENT;
    if (before - after > allowed) {
      throw new SwapError(
        `refused to sign: Jupiter's transaction would take ${((before - after) / 1e9).toFixed(4)} SOL, expected at most ${(allowed / 1e9).toFixed(4)}`,
      );
    }
  }

  async swap(p: SwapParams): Promise<SwapFill> {
    const kp = this.keystore.getKeypair(p.wallet);
    const order = await this.jupiter.order(
      { inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), taker: p.wallet, slippageBps: p.slippageBps },
      PRIORITY.trade,
    );
    if (!order.transaction) throw new SwapError(order.errorMessage || order.error || 'No route found');
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    if (this.settings.get().verifyJupiterTx) await this.verify(tx, p);
    tx.sign([kp]);
    const sentAt = Date.now();
    const signature = bs58.encode(tx.signatures[0]);
    p.onSubmit?.({ signature, blockhash: tx.message.recentBlockhash, route: 'jupiter', tip: 0, sentAt });
    const res = await this.jupiter.execute(Buffer.from(tx.serialize()).toString('base64'), order.requestId);
    if (res.status !== 'Success') {
      throw new SwapError(res.error || `Swap failed (code ${res.code ?? '?'})`, signature);
    }
    const fee =
      (order.signatureFeePayer === p.wallet ? (order.signatureFeeLamports ?? 0) : 0) +
      (order.prioritizationFeePayer === p.wallet ? (order.prioritizationFeeLamports ?? 0) : 0);
    return {
      signature: res.signature!,
      inAmount: BigInt(res.totalInputAmount ?? res.inputAmountResult ?? order.inAmount),
      outAmount: BigInt(res.totalOutputAmount ?? res.outputAmountResult ?? order.outAmount),
      feeLamports: fee,
      sentAt,
      confirmedAt: Date.now(),
      route: 'jupiter',
    };
  }
}

/** Simulated trades at real Jupiter quotes – nothing is signed or sent. */
export class PaperExecutor implements Executor {
  readonly paper = true;

  constructor(
    private readonly jupiter: JupiterClient,
    private readonly settings: SettingsStore,
  ) {}

  async swap(p: SwapParams): Promise<SwapFill> {
    const sentAt = Date.now();
    const quote = await this.jupiter.order(
      { inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), slippageBps: p.slippageBps },
      PRIORITY.trade,
    );
    if (!quote.outAmount || quote.outAmount === '0') throw new SwapError(quote.errorMessage || quote.error || 'No route found');
    return {
      signature: `paper-${crypto.randomUUID()}`,
      inAmount: BigInt(quote.inAmount ?? p.amount),
      outAmount: BigInt(quote.outAmount),
      feeLamports: solToLamports(this.settings.get().paperFeeSol),
      sentAt,
      confirmedAt: Date.now(),
      route: 'jupiter',
    };
  }
}

/**
 * pump.fun / PumpSwap trades built locally and sent through Helius Sender. Building needs one read
 * of the curve or pool (fetched in parallel with the blockhash). The exact fill is read back from the
 * confirmed transaction.
 */
export class DirectExecutor {
  constructor(
    private readonly pump: PumpDirect,
    private readonly rpc: RpcClient,
    private readonly sender: SenderClient,
    private readonly keystore: Keystore,
    private readonly settings: SettingsStore,
  ) {}

  /** Fees this route adds per transaction: priority fee + tip (+ the 5000-lamport base fee). */
  costs() {
    const s = this.settings.get();
    const tip = Math.max(solToLamports(s.tipSol), MIN_TIP_LAMPORTS[s.senderRoute]);
    return { tip, priority: solToLamports(s.priorityFeeSol), base: 5_000 };
  }

  build(p: SwapParams): Promise<BuiltSwap> {
    const slippagePct = p.slippageBps != null ? p.slippageBps / 100 : this.settings.get().pumpSlippagePct;
    const common = { user: p.wallet, slippagePct, tokenProgram: p.tokenProgram ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', hint: p.venue ?? null };
    return p.inputMint === WSOL_MINT
      ? this.pump.buildBuy({ ...common, mint: p.outputMint, lamports: p.amount })
      : this.pump.buildSell({ ...common, mint: p.inputMint, amount: p.amount });
  }

  /** Paper fill at the curve/pool's real price, with this route's fees. */
  async quote(p: SwapParams): Promise<SwapFill> {
    const sentAt = Date.now();
    const built = await this.build(p);
    const c = this.costs();
    return {
      signature: `paper-${crypto.randomUUID()}`,
      inAmount: p.amount,
      outAmount: built.expectedOut,
      feeLamports: c.tip + c.priority + c.base,
      sentAt,
      confirmedAt: Date.now(),
      route: built.route,
    };
  }

  async swap(p: SwapParams): Promise<SwapFill> {
    const kp = this.keystore.getKeypair(p.wallet);
    const conn = this.rpc.connection;
    const [{ blockhash, lastValidBlockHeight }, built] = await Promise.all([conn.getLatestBlockhash('confirmed'), this.build(p)]);
    const c = this.costs();
    const microLamports = Math.max(1, Math.floor((c.priority * 1_000_000) / built.computeUnits));
    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: built.computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
        ...built.instructions,
        tipInstruction(kp.publicKey, c.tip),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([kp]);
    const sig = bs58.encode(tx.signatures[0]);
    const sentAt = Date.now();
    p.onSubmit?.({ signature: sig, blockhash, route: built.route, tip: c.tip, sentAt });
    try {
      await this.sender.send(Buffer.from(tx.serialize()).toString('base64'), this.settings.get().senderRoute);
    } catch (err) {
      // Explicitly refused: nothing reached the network, so Jupiter may be tried instead.
      if (err instanceof SenderRejectedError) throw new NotRoutableError(err.message);
      // Timeout / connection trouble: the transaction may still land. Wait for it below rather than
      // risk buying twice through another route.
    }
    let conf;
    try {
      conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    } catch (err) {
      throw new SwapError(`not confirmed: ${errorMessage(err)}`, sig);
    }
    if (conf.value.err) throw new SwapError(`failed on-chain: ${JSON.stringify(conf.value.err)}`, sig, true);
    const confirmedAt = Date.now();
    return { ...(await this.readFill(sig, p, c.tip)), signature: sig, sentAt, confirmedAt, route: built.route };
  }

  /** Exact amounts from our own confirmed transaction. */
  private async readFill(signature: string, p: SwapParams, tip: number): Promise<Pick<SwapFill, 'inAmount' | 'outAmount' | 'feeLamports'>> {
    let raw: RawTransaction | null = null;
    for (let i = 0; i < 15 && !raw; i++) {
      raw = await this.rpc.call<RawTransaction | null>(
        'getTransaction',
        [signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
        PRIORITY.trade,
      );
      if (!raw) await sleep(300);
    }
    const tx = raw && normalizeTransaction({ ...raw, signature });
    if (!tx) throw new SwapError('confirmed, but the transaction could not be read back', signature);
    const d = walletDeltas(tx, p.wallet);
    const tokenDelta = d.balances.get(tokenMintOf(p))?.delta ?? 0n;
    const fee = (tx.accountKeys[0] === p.wallet ? tx.fee : 0) + tip;
    if (p.inputMint === WSOL_MINT) {
      if (tokenDelta <= 0n) throw new SwapError('confirmed, but no tokens were received', signature);
      return { inAmount: -d.solDelta - BigInt(tip), outAmount: tokenDelta, feeLamports: fee };
    }
    return { inAmount: -tokenDelta, outAmount: d.solDelta + BigInt(tip), feeLamports: fee };
  }
}

/** Resolve an already submitted transaction; never build or send a replacement here. */
export async function recoverSwap(rpc: RpcClient, p: SwapParams, submission: Submission): Promise<SwapFill | null> {
  const raw = await rpc.call<RawTransaction | null>('getTransaction',
    [submission.signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }], PRIORITY.trade);
  const tx = raw && normalizeTransaction({ ...raw, signature: submission.signature });
  if (!tx) {
    // Only declare a missing signature expired once its blockhash is invalid at finalized commitment.
    const valid = await rpc.call<{ value: boolean }>('isBlockhashValid', [submission.blockhash, { commitment: 'finalized' }], PRIORITY.trade);
    if (!valid.value) {
      const status = await rpc.call<{ value: Array<{ err: unknown } | null> }>('getSignatureStatuses',
        [[submission.signature], { searchTransactionHistory: true }], PRIORITY.trade);
      if (status.value[0] == null || status.value[0]?.err)
        throw new SwapError('transaction expired or failed on-chain', submission.signature, true);
    }
    return null;
  }
  if (tx.err) throw new SwapError(`failed on-chain: ${JSON.stringify(tx.err)}`, submission.signature, true);
  const d = walletDeltas(tx, p.wallet);
  const delta = d.balances.get(tokenMintOf(p))?.delta ?? 0n;
  const buying = p.inputMint === WSOL_MINT;
  if ((buying && delta <= 0n) || (!buying && delta >= 0n))
    throw new SwapError('confirmed transaction has unexpected token balances; needs reconciliation', submission.signature);
  return {
    signature: submission.signature,
    inAmount: buying ? -d.solDelta - BigInt(submission.tip) : -delta,
    outAmount: buying ? delta : d.solDelta + BigInt(submission.tip),
    feeLamports: (tx.accountKeys[0] === p.wallet ? tx.fee : 0) + submission.tip,
    sentAt: submission.sentAt, confirmedAt: Date.now(), route: submission.route,
  };
}

/** pump.fun tokens trade directly; everything else (or anything the direct path can't do) uses Jupiter. */
export function isPumpCandidate(p: SwapParams): boolean {
  if (p.venue === 'pumpfun' || p.venue === 'pumpswap') return true;
  // Manual trades have no trader transaction to read the venue from; pump.fun mints end in "pump".
  return p.venue == null && tokenMintOf(p).endsWith('pump');
}

/**
 * Picks the route for each trade: direct pump.fun / PumpSwap when the trader traded there (known
 * from their transaction, no extra lookup), Jupiter otherwise or when the direct path can't build it.
 */
export class RoutingExecutor implements Executor {
  constructor(
    readonly paper: boolean,
    private readonly direct: DirectExecutor,
    private readonly jupiter: Executor,
    private readonly settings: SettingsStore,
    private readonly log: Logger,
    private readonly rpc?: RpcClient,
  ) {}

  recover(p: SwapParams, submission: Submission): Promise<SwapFill | null> {
    if (!this.rpc) throw new Error('Recovery RPC unavailable');
    return recoverSwap(this.rpc, p, submission);
  }

  async swap(p: SwapParams): Promise<SwapFill> {
    if (this.settings.get().directPumpTrades && isPumpCandidate(p)) {
      try {
        return this.paper ? await this.direct.quote(p) : await this.direct.swap(p);
      } catch (err) {
        if (!(err instanceof NotRoutableError)) throw err;
        this.log.info(`direct pump.fun route not possible (${err.message}) – using Jupiter`);
      }
    }
    return this.jupiter.swap(p);
  }
}
