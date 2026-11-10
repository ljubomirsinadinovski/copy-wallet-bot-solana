import type { Logger } from 'pino';
import { RateLimiter } from '../util/rateLimit.js';
import { sleep } from '../util/misc.js';

const BASE = 'https://api.jup.ag';

export interface OrderResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps?: number;
  priceImpact?: number;
  router?: string;
  feeBps?: number;
  signatureFeeLamports?: number;
  signatureFeePayer?: string | null;
  prioritizationFeeLamports?: number;
  prioritizationFeePayer?: string | null;
  transaction?: string | null;
  requestId: string;
  errorCode?: number;
  errorMessage?: string;
  error?: string;
}

export interface ExecuteResponse {
  status: 'Success' | 'Failed';
  signature?: string;
  error?: string;
  code?: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

export interface JupToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals: number;
  totalSupply?: number;
  usdPrice?: number;
  mcap?: number;
}

export class JupiterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Jupiter Swap API v2 (/order → sign → /execute), Price API v3 and Tokens API v2.
 * /order, prices and tokens share one rate-limit bucket (1 rps on the free plan); /execute has its own.
 */
export class JupiterClient {
  private limiter: RateLimiter;

  constructor(
    private readonly apiKey: string,
    rps: number,
    private readonly log: Logger,
  ) {
    this.limiter = new RateLimiter(rps, 1);
    if (!apiKey) log.warn('JUPITER_API_KEY is not set – using keyless Jupiter access with lower limits');
  }

  get queued() {
    return this.limiter.pending;
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { 'x-api-key': this.apiKey } : {};
  }

  private async request<T>(path: string, init: RequestInit, limited: boolean, priority: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const doFetch = () => fetch(`${BASE}${path}`, { ...init, headers: { ...this.headers(), ...init.headers }, signal: AbortSignal.timeout(20_000) });
      const res = limited ? await this.limiter.schedule(doFetch, priority) : await doFetch();
      if (res.status === 429 && attempt < 3) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (!res.ok && !(body && typeof body === 'object' && 'status' in body)) {
        throw new JupiterError(body?.error ?? body?.errorMessage ?? `Jupiter ${path.split('?')[0]} HTTP ${res.status}: ${text.slice(0, 160)}`, res.status);
      }
      return body as T;
    }
  }

  order(
    p: { inputMint: string; outputMint: string; amount: string; taker?: string; slippageBps?: number | null },
    priority = 0,
  ): Promise<OrderResponse> {
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount });
    if (p.taker) q.set('taker', p.taker);
    if (p.slippageBps != null) q.set('slippageBps', String(p.slippageBps));
    return this.request<OrderResponse>(`/swap/v2/order?${q}`, { method: 'GET' }, true, priority);
  }

  execute(signedTransaction: string, requestId: string): Promise<ExecuteResponse> {
    return this.request<ExecuteResponse>(
      '/swap/v2/execute',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction, requestId }) },
      false,
      0,
    );
  }

  /** USD prices for up to 50 mints. Tokens without a reliable price are left out. */
  prices(ids: string[], priority = -5): Promise<Record<string, { usdPrice: number } | null>> {
    return this.request(`/price/v3?ids=${ids.join(',')}`, { method: 'GET' }, true, priority);
  }

  /** Token metadata for up to 100 mints. */
  tokens(ids: string[], priority = -5): Promise<JupToken[]> {
    return this.request(`/tokens/v2/search?query=${ids.join(',')}`, { method: 'GET' }, true, priority);
  }
}
