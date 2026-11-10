/**
 * Checks the direct pump.fun / PumpSwap trade builders against mainnet by SIMULATING transactions
 * (nothing is signed or sent). It borrows the wallets of people who just bought on pump.fun /
 * PumpSwap, since a simulation needs a wallet that actually holds SOL and the token.
 *
 *   pnpm -F server verify:pump          (public RPC, or RPC_URL if set)
 *
 * Run it after updating @pump-fun/* packages.
 */
import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NotRoutableError, PumpDirect } from '../src/executor/pump.js';
import { normalizeTransaction } from '../src/stream/normalize.js';
import { parseWalletTrades } from '../src/parser/parseTrades.js';
import { tipInstruction } from '../src/solana/sender.js';
import { PUMP_PROGRAM, PUMPSWAP_PROGRAM } from '../src/solana/constants.js';

const RPC = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const pump = new PumpDirect(conn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUY_LAMPORTS = 1_000_000n; // 0.001 SOL
const TIP = 5_000;

async function* recentBuyers(program: string, venue: 'pumpfun' | 'pumpswap') {
  let before: string | undefined;
  for (let page = 0; page < 6; page++) {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(program), { limit: 1000, before });
    before = sigs.at(-1)?.signature;
    for (const s of sigs.filter((x) => !x.err).slice(0, 80)) {
      await sleep(150);
      const raw: any = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
      if (!raw) continue;
      const tx = normalizeTransaction({
        ...raw,
        signature: s.signature,
        transaction: { ...raw.transaction, message: { accountKeys: raw.transaction.message.accountKeys.map((k: any) => k.pubkey.toBase58()) } },
      })!;
      const user = tx.accountKeys[0];
      const buy = parseWalletTrades(tx, user).find((t) => t.side === 'buy' && t.venue === venue && t.quoteMint?.startsWith('So111'));
      if (buy && buy.postTokenBalance > 1000n) yield { user, mint: buy.mint, tokens: buy.postTokenBalance, signature: s.signature };
    }
  }
  throw new Error(`no recent ${venue} buyer found`);
}

/** First recent buyer whose token can be built directly (SOL-priced curve/pool). */
async function routableBuyer(program: string, venue: 'pumpfun' | 'pumpswap') {
  for await (const b of recentBuyers(program, venue)) {
    const tp = await tokenProgram(b.mint);
    try {
      const buy = await pump.buildBuy({ mint: b.mint, user: b.user, lamports: BUY_LAMPORTS, slippagePct: 25, tokenProgram: tp, hint: venue });
      return { ...b, tp, buy };
    } catch (err) {
      if (!(err instanceof NotRoutableError)) throw err;
      console.log(`  · skipped ${b.mint.slice(0, 6)}…: ${err.message} → would use Jupiter`);
    }
  }
  throw new Error('unreachable');
}

async function simulate(label: string, user: string, built: Awaited<ReturnType<PumpDirect['buildBuy']>>) {
  const payer = new PublicKey(user);
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: built.computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      ...built.instructions,
      tipInstruction(payer, TIP),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const before = await conn.getBalance(payer);
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: [user] },
  });
  const v = sim.value;
  const after = v.accounts?.[0]?.lamports ?? before;
  const ixLogs = (v.logs ?? []).filter((l) => l.includes('Instruction:')).map((l) => l.replace('Program log: Instruction: ', '')).join(' → ');
  console.log(
    `${v.err ? '✗' : '✓'} ${label} [${built.route}] err=${JSON.stringify(v.err)} CU=${v.unitsConsumed}/${built.computeUnits} ` +
      `SOL change=${(after - before) / 1e9} expectedOut=${built.expectedOut} minOut=${built.minOut}\n    ${ixLogs}`,
  );
  if (v.err) console.log((v.logs ?? []).slice(-8).join('\n'));
  return !v.err && (v.unitsConsumed ?? 0) <= built.computeUnits;
}

async function tokenProgram(mint: string) {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  return info!.owner.toBase58();
}

async function main() {
  let ok = true;

  const c = await routableBuyer(PUMP_PROGRAM, 'pumpfun');
  console.log(`pump.fun curve: user ${c.user} mint ${c.mint} (from ${c.signature.slice(0, 12)}…)`);
  ok = (await simulate('curve buy 0.001 SOL', c.user, c.buy)) && ok;
  ok = (await simulate('curve sell half', c.user, await pump.buildSell({ mint: c.mint, user: c.user, amount: c.tokens / 2n, slippagePct: 25, tokenProgram: c.tp, hint: 'pumpfun' }))) && ok;

  const p = await routableBuyer(PUMPSWAP_PROGRAM, 'pumpswap');
  console.log(`PumpSwap pool: user ${p.user} mint ${p.mint} (from ${p.signature.slice(0, 12)}…)`);
  ok = (await simulate('pool buy 0.001 SOL', p.user, p.buy)) && ok;
  ok = (await simulate('pool sell half', p.user, await pump.buildSell({ mint: p.mint, user: p.user, amount: p.tokens / 2n, slippagePct: 25, tokenProgram: p.tp, hint: 'pumpswap' }))) && ok;

  // A non-pump token must be refused before anything is built (→ Jupiter fallback).
  try {
    await pump.buildBuy({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', user: c.user, lamports: BUY_LAMPORTS, slippagePct: 25, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', hint: null });
    console.log('✗ BONK was not refused');
    ok = false;
  } catch (err) {
    console.log(`${err instanceof NotRoutableError ? '✓' : '✗'} non-pump token refused: ${(err as Error).message.slice(0, 90)}`);
    ok = ok && err instanceof NotRoutableError;
  }

  console.log(ok ? '\nAll checks passed.' : '\nSome checks FAILED.');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
