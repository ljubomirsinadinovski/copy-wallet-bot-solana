import type { SettingsStore } from '../settings.js';

export interface UsageSnapshot {
  month: string;
  credits: number;
  rpcCalls: Record<string, number>;
  wsMb: number;
}

const monthKey = () => new Date().toISOString().slice(0, 7);

/**
 * Estimates Helius credits used this month: 1 credit per standard RPC call, and
 * 2 credits per 0.1 MB of WebSocket data (Helius metering since May 2026).
 */
export class UsageTracker {
  private month = monthKey();
  private credits = 0;
  private rpcCalls: Record<string, number> = {};
  private wsBytes = 0;
  private timer: NodeJS.Timeout;

  constructor(private readonly settings: SettingsStore) {
    const saved = settings.getJson<{ credits: number; rpcCalls: Record<string, number>; wsBytes: number }>(
      `usage:${this.month}`,
    );
    if (saved) Object.assign(this, { credits: saved.credits, rpcCalls: saved.rpcCalls, wsBytes: saved.wsBytes });
    this.timer = setInterval(() => this.flush(), 60_000);
    this.timer.unref();
  }

  rpc(method: string, credits = 1) {
    this.rollover();
    this.rpcCalls[method] = (this.rpcCalls[method] ?? 0) + 1;
    this.credits += credits;
  }

  ws(bytes: number) {
    this.rollover();
    this.wsBytes += bytes;
    this.credits += (bytes / 100_000) * 2;
  }

  snapshot(): UsageSnapshot {
    return { month: this.month, credits: Math.round(this.credits), rpcCalls: { ...this.rpcCalls }, wsMb: this.wsBytes / 1e6 };
  }

  flush() {
    this.settings.setJson(`usage:${this.month}`, { credits: this.credits, rpcCalls: this.rpcCalls, wsBytes: this.wsBytes });
  }

  private rollover() {
    const m = monthKey();
    if (m !== this.month) {
      this.flush();
      this.month = m;
      this.credits = 0;
      this.rpcCalls = {};
      this.wsBytes = 0;
    }
  }
}
