import { eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { tokens, type Token } from '../db/schema.js';
import { USD1_MINT, USDC_MINT, USDT_MINT, WSOL_MINT } from './constants.js';
import type { JupiterClient } from './jupiter.js';
import { PRIORITY, type RpcClient } from './rpc.js';

interface ParsedMint {
  value: {
    owner: string;
    data: {
      parsed?: {
        type: string;
        info: {
          decimals: number;
          supply: string;
          freezeAuthority: string | null;
          mintAuthority: string | null;
          extensions?: Array<{ extension: string; state?: any }>;
        };
      };
    };
  } | null;
}

const KNOWN: Record<string, string> = { [WSOL_MINT]: 'SOL', [USDC_MINT]: 'USDC', [USDT_MINT]: 'USDT', [USD1_MINT]: 'USD1' };

/**
 * Token-2022 features that can stop you from selling. A transfer fee is not listed here: it only takes
 * a cut, so it has its own limit (see transferFeeBps).
 */
export function riskyExtensions(exts: Array<{ extension: string; state?: any }> = []): string[] {
  const risky: string[] = [];
  for (const e of exts) {
    const s = e.state ?? {};
    switch (e.extension) {
      case 'transferHook':
        if (s.programId) risky.push('transfer hook');
        break;
      case 'permanentDelegate':
        if (s.delegate) risky.push('permanent delegate');
        break;
      case 'nonTransferable':
        risky.push('non-transferable');
        break;
      case 'defaultAccountState':
        if (s.accountState === 'frozen') risky.push('frozen by default');
        break;
      case 'pausableConfig':
        risky.push('pausable');
        break;
    }
  }
  return risky;
}

/** Token-2022 transfer fee in basis points (100 = 1%), the higher of the current and the scheduled one; null = none. */
export function transferFeeBps(exts: Array<{ extension: string; state?: any }> = []): number | null {
  const s = exts.find((e) => e.extension === 'transferFeeConfig')?.state;
  if (!s) return null;
  const bps = Math.max(s.newerTransferFee?.transferFeeBasisPoints ?? 0, s.olderTransferFee?.transferFeeBasisPoints ?? 0);
  return bps > 0 ? bps : null;
}

/** Mint facts (decimals, supply, authorities) from chain, plus name/symbol/icon from Jupiter. */
export class TokenService {
  private memo = new Map<string, Token>();
  private inflight = new Map<string, Promise<Token>>();
  private metaPending = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly rpc: RpcClient,
    private readonly jupiter: JupiterClient,
    private readonly log: Logger,
  ) {}

  /**
   * Looks up the name/symbol for tokens a page is showing without one – display only, never needed
   * for trading. One batched Jupiter call; each token is retried at most every 10 minutes.
   * Many pump.fun coins already have their name on-chain, read for free with the mint.
   */
  ensureMetadata(mints: string[]): void {
    const cutoff = Date.now() - 10 * 60_000;
    const wanted = [...new Set(mints)].filter((m) => {
      const t = this.cached(m);
      return t && !t.symbol && (t.metaFetchedAt ?? 0) < cutoff && !this.metaPending.has(m);
    });
    if (!wanted.length) return;
    wanted.forEach((m) => this.metaPending.add(m));
    void this.refreshMetadata(wanted.slice(0, 100)).finally(() => wanted.forEach((m) => this.metaPending.delete(m)));
  }

  cached(mint: string): Token | undefined {
    if (this.memo.has(mint)) return this.memo.get(mint);
    const row = this.db.select().from(tokens).where(eq(tokens.mint, mint)).get();
    if (row) this.memo.set(mint, row);
    return row;
  }

  symbol(mint: string): string {
    return KNOWN[mint] ?? this.cached(mint)?.symbol ?? mint.slice(0, 4) + '…';
  }

  /** Cached mint info; supply is refreshed if older than `maxAgeMs` (it changes with burns). */
  async get(mint: string, maxAgeMs = 6 * 3600_000): Promise<Token> {
    const row = this.cached(mint);
    if (row && Date.now() - row.fetchedAt < maxAgeMs) return row;
    let p = this.inflight.get(mint);
    if (!p) {
      p = this.fetchMint(mint).finally(() => this.inflight.delete(mint));
      this.inflight.set(mint, p);
    }
    return p;
  }

  private async fetchMint(mint: string): Promise<Token> {
    const res = await this.rpc.call<ParsedMint>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }], PRIORITY.trade);
    const info = res.value?.data.parsed?.info;
    if (!res.value) throw new Error(`No token exists at ${mint} on Solana – check the address`);
    if (!info) throw new Error(`${mint} is not a token mint`);
    const meta = info.extensions?.find((e) => e.extension === 'tokenMetadata')?.state;
    const existing = this.cached(mint);
    const row: Token = {
      mint,
      symbol: existing?.symbol ?? meta?.symbol ?? null,
      name: existing?.name ?? meta?.name ?? null,
      icon: existing?.icon ?? null,
      decimals: info.decimals,
      supply: info.supply,
      tokenProgram: res.value.owner,
      freezeAuthority: info.freezeAuthority,
      mintAuthority: info.mintAuthority,
      riskyExtensions: riskyExtensions(info.extensions).join(', ') || null,
      transferFeeBps: transferFeeBps(info.extensions),
      fetchedAt: Date.now(),
      metaFetchedAt: existing?.metaFetchedAt ?? null,
    };
    this.db.insert(tokens).values(row).onConflictDoUpdate({ target: tokens.mint, set: row }).run();
    this.memo.set(mint, row);
    return row;
  }

  private async refreshMetadata(mints: string[]) {
    const rows = this.all(mints);
    if (!rows.length) return;
    try {
      const found = await this.jupiter.tokens(rows.map((r) => r.mint));
      const byId = new Map(found.map((t) => [t.id, t]));
      const now = Date.now();
      for (const r of rows) {
        const t = byId.get(r.mint);
        const set = { symbol: t?.symbol ?? r.symbol, name: t?.name ?? r.name, icon: t?.icon ?? r.icon, metaFetchedAt: now };
        this.db.update(tokens).set(set).where(eq(tokens.mint, r.mint)).run();
        this.memo.set(r.mint, { ...r, ...set });
      }
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'token metadata refresh failed');
    }
  }

  all(mints: string[]): Token[] {
    if (!mints.length) return [];
    return this.db.select().from(tokens).where(inArray(tokens.mint, mints)).all();
  }
}
