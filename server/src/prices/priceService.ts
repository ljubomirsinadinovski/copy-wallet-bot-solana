import type { Logger } from 'pino';
import { WSOL_MINT } from '../solana/constants.js';
import type { JupiterClient } from '../solana/jupiter.js';

interface Price {
  usd: number;
  at: number;
}

/**
 * USD prices from Jupiter, fetched only when something needs them – never on a timer:
 * - token prices when you open a page that shows position values (Dashboard, Positions);
 * - the SOL price after one of your trades fills (for its market cap), at most every 2 minutes.
 */
export class PriceService {
  private prices = new Map<string, Price>();
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly jupiter: JupiterClient,
    private readonly log: Logger,
  ) {}

  get solUsd(): number | null {
    return this.prices.get(WSOL_MINT)?.usd ?? null;
  }

  priceUsd(mint: string): number | null {
    return this.prices.get(mint)?.usd ?? null;
  }

  priceSol(mint: string): number | null {
    const usd = this.priceUsd(mint);
    const sol = this.solUsd;
    return usd != null && sol ? usd / sol : null;
  }

  /** Records a price observed from an actual fill (useful for brand-new tokens Jupiter has no price for yet). */
  observe(mint: string, usd: number) {
    const existing = this.prices.get(mint);
    if (!existing || Date.now() - existing.at > 5_000) this.prices.set(mint, { usd, at: Date.now() });
  }

  /** SOL/USD, refreshed if older than `maxAgeMs`. */
  async solUsdFresh(maxAgeMs = 120_000): Promise<number | null> {
    await this.refresh([], maxAgeMs);
    return this.solUsd;
  }

  /** Refreshes SOL and the given mints whose price is older than `maxAgeMs` (≤50 mints per call). */
  async refresh(mints: string[], maxAgeMs: number): Promise<void> {
    if (this.inflight) await this.inflight.catch(() => undefined);
    const now = Date.now();
    const stale = [...new Set([WSOL_MINT, ...mints])].filter((m) => now - (this.prices.get(m)?.at ?? 0) > maxAgeMs);
    if (!stale.length) return;
    this.inflight = (async () => {
      for (let i = 0; i < stale.length; i += 50) {
        const batch = stale.slice(i, i + 50);
        const res = await this.jupiter.prices(batch);
        const at = Date.now();
        for (const [mint, p] of Object.entries(res ?? {})) {
          if (p && typeof p.usdPrice === 'number') this.prices.set(mint, { usd: p.usdPrice, at });
        }
      }
    })();
    try {
      await this.inflight;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'price refresh failed');
    } finally {
      this.inflight = null;
    }
  }
}
