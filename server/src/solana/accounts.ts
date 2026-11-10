import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Logger } from 'pino';
import type { Keystore } from '../keystore/keystore.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from './constants.js';
import { PRIORITY, type RpcClient } from './rpc.js';
import { MIN_TIP_LAMPORTS, SenderRejectedError, tipInstruction, type SenderClient } from './sender.js';
import type { SettingsStore } from '../settings.js';
import { solToLamports } from '../util/misc.js';

export interface Holding {
  mint: string;
  account: string;
  program: string;
  raw: bigint;
  decimals: number;
}

interface TokenAccountsResponse {
  value: Array<{
    pubkey: string;
    account: { owner: string; data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } };
  }>;
}

/**
 * Balances of your wallets (and on-demand lookups of watched wallets). Nothing is polled or
 * subscribed: balances are read when you open My wallets / press Refresh, and right before a live buy.
 */
export class AccountService {
  private sol = new Map<string, { lamports: number; at: number }>();
  private holdingsCache = new Map<string, { list: Holding[]; at: number }>();

  constructor(
    private readonly rpc: RpcClient,
    private readonly keystore: Keystore,
    private readonly log: Logger,
  ) {}

  invalidate(owner: string) {
    this.holdingsCache.delete(owner);
  }

  private cashCache = new Map<string, { at: number; stables: Map<string, { raw: bigint; decimals: number }>; lamports: number | null }>();

  /**
   * A watched wallet's stablecoin balances (and optionally its SOL) in ONE request: their standard
   * token accounts for each mint, under both token programs. Cached 30 s so a burst of buys reads once.
   */
  async cashBalances(
    owner: string,
    mints: string[],
    withSol: boolean,
    maxAgeMs = 30_000,
  ): Promise<{ lamports: number | null; stables: Map<string, { raw: bigint; decimals: number }>; at: number }> {
    const c = this.cashCache.get(owner);
    if (c && Date.now() - c.at < maxAgeMs && (!withSol || c.lamports != null) && mints.every((m) => c.stables.has(m))) return c;
    const ownerPk = new PublicKey(owner);
    const atas = mints.flatMap((m) =>
      [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((program) => ({ mint: m, address: getAssociatedTokenAddressSync(new PublicKey(m), ownerPk, true, new PublicKey(program)).toBase58() })),
    );
    const addresses = [...(withSol ? [owner] : []), ...atas.map((a) => a.address)];
    const res = await this.rpc.call<{ value: Array<{ lamports: number; data: any } | null> }>(
      'getMultipleAccounts',
      [addresses, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      PRIORITY.trade,
    );
    const stables = new Map<string, { raw: bigint; decimals: number }>(mints.map((m) => [m, { raw: 0n, decimals: 6 }]));
    res.value.slice(withSol ? 1 : 0).forEach((acc, i) => {
      const info = acc?.data?.parsed?.info;
      if (!info?.tokenAmount) return;
      const cur = stables.get(atas[i].mint)!;
      stables.set(atas[i].mint, { raw: cur.raw + BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals });
    });
    const out = { at: Date.now(), stables, lamports: withSol ? (res.value[0]?.lamports ?? 0) : (c?.lamports ?? null) };
    this.cashCache.set(owner, out);
    return out;
  }

  /** Last known SOL balance without any request, or null if never read. */
  cachedSol(owner: string): { lamports: number; at: number } | null {
    return this.sol.get(owner) ?? null;
  }

  async solBalance(owner: string, maxAgeMs = 10_000, priority: number = PRIORITY.normal): Promise<number> {
    const c = this.sol.get(owner);
    if (c && Date.now() - c.at < maxAgeMs) return c.lamports;
    const res = await this.rpc.call<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }], priority);
    this.sol.set(owner, { lamports: res.value, at: Date.now() });
    return res.value;
  }

  async tokenBalance(owner: string, mint: string, priority: number = PRIORITY.trade): Promise<bigint> {
    const res = await this.rpc.call<TokenAccountsResponse>(
      'getTokenAccountsByOwner',
      [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      priority,
    );
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async holdings(owner: string, maxAgeMs = 20_000): Promise<Holding[]> {
    const c = this.holdingsCache.get(owner);
    if (c && Date.now() - c.at < maxAgeMs) return c.list;
    const list: Holding[] = [];
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const res = await this.rpc.call<TokenAccountsResponse>(
        'getTokenAccountsByOwner',
        [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        PRIORITY.normal,
      );
      for (const a of res.value) {
        const info = a.account.data.parsed.info;
        list.push({ mint: info.mint, account: a.pubkey, program: programId, raw: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals });
      }
    }
    this.holdingsCache.set(owner, { list, at: Date.now() });
    return list;
  }

  private landing: { sender: SenderClient | null; settings: SettingsStore } | null = null;

  /** Send maintenance transactions the same way trades are sent (priority fee + Helius Sender). */
  useLanding(sender: SenderClient | null, settings: SettingsStore) {
    this.landing = { sender, settings };
  }

  /** Closes token accounts with a zero balance, returning their rent (~0.002 SOL each) to the wallet. */
  async closeEmptyAccounts(owner: string, onlyMint?: string): Promise<{ closed: number; signatures: string[] }> {
    const kp = this.keystore.getKeypair(owner);
    const empty = (await this.holdings(owner, 0)).filter((h) => h.raw === 0n && (!onlyMint || h.mint === onlyMint || h.mint === WSOL_MINT));
    const signatures: string[] = [];
    for (let i = 0; i < empty.length; i += 18) {
      const batch = empty.slice(i, i + 18);
      const ixs = batch.map((h) => createCloseAccountInstruction(new PublicKey(h.account), kp.publicKey, kp.publicKey, [], new PublicKey(h.program)));
      signatures.push(await this.sendLanded(kp, ixs, 10_000 + batch.length * 5_000));
    }
    if (empty.length) this.log.info({ wallet: owner, closed: empty.length }, 'closed empty token accounts');
    this.invalidate(owner);
    return { closed: empty.length, signatures };
  }

  /**
   * Sends with your priority fee (and via Helius Sender with a tip, when available) and retries with a
   * fresh blockhash if it expires before landing – a busy network drops low-fee transactions.
   */
  private async sendLanded(kp: Keypair, ixs: TransactionInstruction[], computeUnits: number): Promise<string> {
    const conn = this.rpc.connection;
    const s = this.landing?.settings.get();
    const sender = this.landing?.sender ?? null;
    const priority = s ? solToLamports(s.priorityFeeSol) : 50_000;
    const route = s?.senderRoute ?? 'swqos';
    const tip = s ? Math.max(solToLamports(s.tipSol), MIN_TIP_LAMPORTS[route]) : MIN_TIP_LAMPORTS.swqos;
    for (let attempt = 1; ; attempt++) {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const msg = new TransactionMessage({
        payerKey: kp.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(1, Math.floor((priority * 1_000_000) / computeUnits)) }),
          ...ixs,
          ...(sender ? [tipInstruction(kp.publicKey, tip)] : []),
        ],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([kp]);
      const signature = bs58.encode(tx.signatures[0]);
      const raw = Buffer.from(tx.serialize());
      if (sender) {
        await sender.send(raw.toString('base64'), route).catch(async (err) => {
          if (!(err instanceof SenderRejectedError)) return; // may still land – wait for it below
          await conn.sendRawTransaction(raw, { maxRetries: 3 });
        });
      } else {
        await conn.sendRawTransaction(raw, { maxRetries: 3 });
      }
      try {
        const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (res.value.err) throw new Error(`failed on-chain: ${JSON.stringify(res.value.err)}`);
        return signature;
      } catch (err) {
        if (err instanceof TransactionExpiredBlockheightExceededError && attempt < 3) {
          this.log.info(`rent reclaim didn't land in time (attempt ${attempt}/3), retrying`);
          continue;
        }
        throw err;
      }
    }
  }
}
