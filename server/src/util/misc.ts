export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const LAMPORTS_PER_SOL = 1_000_000_000;

export const solToLamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);
export const lamportsToSol = (lamports: number | bigint) => Number(lamports) / LAMPORTS_PER_SOL;

/** Raw integer token amount → UI amount. */
export function rawToUi(raw: bigint | string, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

/** Multiplies a bigint by a 0..1 fraction without floating point overflow. */
export function mulFraction(value: bigint, fraction: number): bigint {
  if (fraction >= 1) return value;
  if (fraction <= 0) return 0n;
  const SCALE = 1_000_000_000n;
  return (value * BigInt(Math.floor(fraction * 1e9))) / SCALE;
}

/** Ratio a/b of two bigints as a float. */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  const SCALE = 1_000_000_000_000n;
  return Number((a * SCALE) / b) / 1e12;
}

export const shortAddr = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** Bounded set for de-duplicating signatures. */
export class LruSet {
  private set = new Set<string>();
  constructor(private readonly max = 10_000) {}
  has(v: string) {
    return this.set.has(v);
  }
  add(v: string) {
    this.set.add(v);
    if (this.set.size > this.max) this.set.delete(this.set.values().next().value!);
  }
}

/** Runs tasks for the same key one after another (e.g. a sell waits for the buy of the same token). */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }).catch(() => undefined);
    return next;
  }

  /** Number of keys with work queued or running. */
  get size(): number {
    return this.tails.size;
  }

  /** Resolves once every queued task has finished (used by tests and shutdown). */
  async drain(): Promise<void> {
    while (this.tails.size) await Promise.allSettled([...this.tails.values()]);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
