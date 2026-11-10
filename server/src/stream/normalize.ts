import type { NormalizedTx, TokenBalance } from './types.js';

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface RawMeta {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: RawTokenBalance[] | null;
  postTokenBalances?: RawTokenBalance[] | null;
  logMessages?: string[] | null;
  loadedAddresses?: { writable: string[]; readonly: string[] } | null;
}

export interface RawTransaction {
  slot: number;
  blockTime?: number | null;
  signature?: string;
  transaction: {
    signatures: string[];
    message: { accountKeys: Array<string | { pubkey: string }> };
  };
  meta: RawMeta | null;
}

const tokenBalances = (list: RawTokenBalance[] | null | undefined): TokenBalance[] =>
  (list ?? []).map((b) => ({
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner,
    programId: b.programId,
    amount: b.uiTokenAmount.amount,
    decimals: b.uiTokenAmount.decimals,
  }));

/** Converts a getTransaction / transactionSubscribe payload (json or jsonParsed encoding). */
export function normalizeTransaction(raw: RawTransaction): NormalizedTx | null {
  const meta = raw.meta;
  if (!meta || !raw.transaction?.message) return null;
  const keys = raw.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  // `json` encoding lists lookup-table addresses separately; `jsonParsed` already includes them.
  if (keys.length < meta.preBalances.length && meta.loadedAddresses) {
    keys.push(...meta.loadedAddresses.writable, ...meta.loadedAddresses.readonly);
  }
  return {
    signature: raw.signature ?? raw.transaction.signatures[0],
    slot: raw.slot,
    blockTime: raw.blockTime ? raw.blockTime * 1000 : null,
    err: meta.err,
    fee: meta.fee,
    accountKeys: keys,
    preBalances: meta.preBalances,
    postBalances: meta.postBalances,
    preTokenBalances: tokenBalances(meta.preTokenBalances),
    postTokenBalances: tokenBalances(meta.postTokenBalances),
    logs: meta.logMessages ?? [],
  };
}

/** Every address that took part: account keys plus token-account owners. */
export function involvedAddresses(tx: NormalizedTx): Set<string> {
  const set = new Set(tx.accountKeys);
  for (const b of tx.preTokenBalances) if (b.owner) set.add(b.owner);
  for (const b of tx.postTokenBalances) if (b.owner) set.add(b.owner);
  return set;
}
