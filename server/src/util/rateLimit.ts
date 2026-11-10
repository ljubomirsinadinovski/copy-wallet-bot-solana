interface Job {
  priority: number;
  seq: number;
  run: () => void;
  send?: boolean;
}

/**
 * Token-bucket limiter with a priority queue. Higher priority jobs (trades) jump ahead of lower
 * ones (price refreshes) when the bucket is empty.
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: Job[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly rps: number,
    private readonly burst = Math.max(1, Math.ceil(rps)),
  ) {
    this.tokens = this.burst;
  }

  schedule<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ priority, seq: this.seq++, run: () => fn().then(resolve, reject) });
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      this.drain();
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rps);
    this.last = now;
  }

  private drain() {
    if (this.timer) return;
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!.run();
    }
    if (this.queue.length) {
      const wait = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, wait);
    }
  }
}

/** Rolling-window RPC limit: allow an immediate burst, but never refill past the per-second cap. */
export class RpcLimiter {
  private starts: number[] = [];
  private sends: number[] = [];
  private queue: Job[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly rps: number, private readonly sendRps = Infinity) {}

  schedule<T>(fn: () => Promise<T>, priority = 0, send = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ priority, send, seq: this.seq++, run: () => { Promise.resolve().then(fn).then(resolve, reject); } });
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      // A send-only wait must not delay a newly arrived ordinary request.
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.drain();
    });
  }
  get pending() { return this.queue.length; }
  private drain() {
    const now = Date.now();
    const windowMs = this.rps < 1 ? Math.ceil(1000 / this.rps) : 1000;
    this.starts = this.starts.filter((t) => now - t < windowMs);
    this.sends = this.sends.filter((t) => now - t < 1000);
    const cap = Math.max(1, Math.floor(this.rps));
    while (this.queue.length && this.starts.length < cap) {
      const index = this.queue.findIndex((job) => !job.send || this.sends.length < this.sendRps);
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1);
      this.starts.push(now);
      if (job.send) this.sends.push(now);
      job.run();
    }
    if (this.queue.length) {
      const availableAt = this.starts.length >= cap ? this.starts[0] + windowMs : this.sends[0] + 1000;
      this.timer = setTimeout(() => { this.timer = null; this.drain(); }, Math.max(1, availableAt - now));
    }
  }
}
