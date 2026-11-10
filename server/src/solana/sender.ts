import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { sleep } from '../util/misc.js';

/** Helius Sender tip accounts (mainnet). A transfer to one of them must be in every Sender transaction. */
const TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map((a) => new PublicKey(a));

export type SenderRoute = 'swqos' | 'max';

/** Sender explicitly refused the transaction, so it was not forwarded anywhere. */
export class SenderRejectedError extends Error {}

/**
 * Minimum tips (lamports). "max" sends through every pathway (incl. Jito) with a 0.001 SOL minimum;
 * "swqos" uses staked connections only, with a 0.000005 SOL minimum.
 */
export const MIN_TIP_LAMPORTS: Record<SenderRoute, number> = { max: 1_000_000, swqos: 5_000 };

export function tipInstruction(from: PublicKey, lamports: number): TransactionInstruction {
  const to = TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
}

/**
 * Helius Sender: sends a signed transaction through several landing paths at once. Uses no API
 * credits; the tip pays for it. With the Helius API key the limit is 50 tx/s instead of 1.
 */
export class SenderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  url(route: SenderRoute): string {
    const q = new URLSearchParams();
    // Never send the key over plain http (the regional endpoints) – it would travel unencrypted.
    if (this.apiKey && this.baseUrl.startsWith('https:')) q.set('api-key', this.apiKey);
    if (route === 'swqos') q.set('swqos_only', 'true');
    const qs = q.toString();
    return qs ? `${this.baseUrl}?${qs}` : this.baseUrl;
  }

  async send(base64Tx: string, route: SenderRoute): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url(route), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'sendTransaction',
          params: [base64Tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429 && attempt < 2) {
        await sleep(300);
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as { result?: string; error?: { message: string } };
      // A JSON-RPC error or a 4xx means it was refused. A 5xx or a dropped connection is ambiguous:
      // the transaction may already be on its way, so that is not reported as a rejection.
      if (json.error || (res.status >= 400 && res.status < 500)) {
        throw new SenderRejectedError(`Sender rejected the transaction: ${json.error?.message ?? `HTTP ${res.status}`}`);
      }
      if (!res.ok || !json.result) throw new Error(`Sender answered HTTP ${res.status}`);
      return json.result;
    }
  }
}
