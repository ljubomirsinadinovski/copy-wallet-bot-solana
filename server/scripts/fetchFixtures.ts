/**
 * Downloads recent real mainnet transactions to use as parser test fixtures.
 *   pnpm -F server fixtures            (uses the public RPC, or RPC_URL if set)
 *
 * For pump.fun transactions it also decodes the program's own TradeEvent, which gives an
 * independent expected value (exact token amount, buy/sell) to test the balance-based parser against.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { normalizeTransaction, type RawTransaction } from '../src/stream/normalize.js';
import { parseWalletTrades } from '../src/parser/parseTrades.js';

const RPC = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const OUT = path.join(import.meta.dirname, '../test/fixtures');
const PROGRAMS = {
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};
const PER_KIND = Number(process.env.PER_KIND ?? 4);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    const json: any = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }
  throw new Error('rate limited');
}

const TRADE_EVENT_DISC = crypto.createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');

/** Finds pump.fun TradeEvents in logs ("Program data:") or self-CPI event instructions. */
function pumpTradeEvents(raw: any): Array<{ mint: string; solAmount: string; tokenAmount: string; isBuy: boolean; user: string }> {
  const blobs: Buffer[] = [];
  for (const line of raw.meta?.logMessages ?? []) {
    if (line.startsWith('Program data: ')) blobs.push(Buffer.from(line.slice(14), 'base64'));
  }
  for (const group of raw.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (ix.programId === PROGRAMS.pumpfun && typeof ix.data === 'string') {
        const data = Buffer.from(bs58.decode(ix.data));
        if (data.subarray(0, 8).equals(EVENT_IX_TAG)) blobs.push(data.subarray(8));
      }
    }
  }
  const seen = new Set<string>();
  return blobs
    .filter((b) => {
      // The same event is emitted both as a log line and as a self-CPI instruction.
      const key = b.toString('hex');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((b) => b.length >= 8 + 32 + 8 + 8 + 1 + 32 && b.subarray(0, 8).equals(TRADE_EVENT_DISC))
    .map((b) => ({
      mint: bs58.encode(b.subarray(8, 40)),
      solAmount: b.readBigUInt64LE(40).toString(),
      tokenAmount: b.readBigUInt64LE(48).toString(),
      isBuy: b[56] === 1,
      user: bs58.encode(b.subarray(57, 89)),
    }));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.argv[2];
  for (const [kind, program] of Object.entries(PROGRAMS)) {
    if (only && kind !== only) continue;
    // Busy programs are flooded with failed bot transactions, so page back until enough succeed.
    const sigs: Array<{ signature: string; err: unknown }> = [];
    let before: string | undefined;
    for (let page = 0; page < 10 && sigs.filter((s) => !s.err).length < 40; page++) {
      const batch = await rpc<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [program, { limit: 1000, before }]);
      if (!batch.length) break;
      sigs.push(...batch);
      before = batch[batch.length - 1].signature;
      await sleep(300);
    }
    const found: Record<string, number> = { buy: 0, sell: 0 };
    for (const s of sigs) {
      if (s.err || (found.buy >= PER_KIND / 2 && found.sell >= PER_KIND / 2)) continue;
      await sleep(250);
      const raw = await rpc<RawTransaction & { meta: any }>('getTransaction', [
        s.signature,
        { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 },
      ]);
      if (!raw) continue;
      const tx = normalizeTransaction({ ...raw, signature: s.signature })!;
      // For pump.fun the trader is the event's `user`, who is not always the fee payer (relayed txs).
      const events = kind === 'pumpfun' ? pumpTradeEvents(raw) : [];
      if (kind === 'pumpfun' && events.length !== 1) continue;
      const wallet = events[0]?.user ?? tx.accountKeys[0];
      const trades = parseWalletTrades(tx, wallet).filter((t) => t.side === 'buy' || t.side === 'sell');
      if (trades.length !== 1) continue;
      const side = trades[0].side;
      if (found[side] >= PER_KIND / 2) continue;
      found[side]++;
      const name = `${kind}-${side}-${found[side]}`;
      fs.writeFileSync(
        path.join(OUT, `${name}.json`),
        JSON.stringify({ wallet, relayed: wallet !== tx.accountKeys[0], pumpEvent: events[0] ?? null, raw }, null, 1),
      );
      const t = trades[0];
      console.log(`${name}: ${t.side} ${t.mint.slice(0, 6)}… tokens=${t.tokenAmount} quote=${t.quoteAmount} pct=${(t.pct * 100).toFixed(2)}%` +
        (events[0] ? ` | event tokens=${events[0].tokenAmount} sol=${events[0].solAmount} isBuy=${events[0].isBuy}` : ''));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
