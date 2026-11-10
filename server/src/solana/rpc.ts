import { Connection } from '@solana/web3.js';
import { RpcLimiter } from '../util/rateLimit.js';
import { sleep } from '../util/misc.js';
import type { UsageTracker } from '../util/usage.js';

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const PRIORITY = { trade: 10, stream: 5, normal: 0, background: -5 } as const;

/** JSON-RPC over HTTP with a request-per-second budget and credit accounting. */
export class RpcClient {
  private limiter: RpcLimiter;
  private id = 0;
  readonly connection: Connection;

  constructor(
    readonly url: string,
    rps: number,
    private readonly usage: UsageTracker,
    sendRps = 1,
  ) {
    this.limiter = new RpcLimiter(rps, sendRps);
    // web3.js Connection is used for building/sending transactions; its requests are counted too.
    this.connection = new Connection(url, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: (input, init) => this.request(input as string, init as RequestInit, PRIORITY.trade),
    });
  }

  get queued(): number {
    return this.limiter.pending;
  }

  private async request(url: string, init: RequestInit, priority: number): Promise<Response> {
    const body = JSON.parse(String(init.body ?? '{}'));
    if (Array.isArray(body)) {
      // Split SDK batches so each physical request obeys both the global and send limits.
      const responses = await Promise.all(body.map(async (req) => {
        const res = await this.request(url, { ...init, body: JSON.stringify(req) }, priority);
        if (!res.ok) throw new RpcError(res.status, `RPC batch HTTP ${res.status}`);
        return res.json();
      }));
      return new Response(JSON.stringify(responses), { headers: { 'content-type': 'application/json' } });
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.limiter.schedule(() => {
        // getTransactionsForAddress costs 10 credits per 100 transactions returned (≤100 per call here).
        this.usage.rpc(body.method ?? 'unknown', body.method === 'getTransactionsForAddress' ? 10 : 1);
        return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      }, priority, body.method === 'sendTransaction');
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await res.body?.cancel();
        await sleep(Math.max(200 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
        continue;
      }
      return res;
    }
  }

  async call<T>(method: string, params: unknown[], priority: number = PRIORITY.normal): Promise<T> {
    const res = await this.request(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    }, priority);
    if (!res.ok) throw new RpcError(res.status, `${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (json.error) throw new RpcError(json.error.code, `${method}: ${json.error.message}`);
    return json.result as T;
  }
}
