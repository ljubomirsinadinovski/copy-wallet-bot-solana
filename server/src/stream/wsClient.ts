import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from 'pino';
import type { UsageTracker } from '../util/usage.js';

interface Sub {
  method: string;
  params: unknown[];
  unsubMethod: string;
  handler: (result: any) => void;
  serverId: number | null;
}

/**
 * JSON-RPC WebSocket client for Solana subscriptions that survives disconnects: it reconnects with
 * backoff, re-creates every subscription, and pings regularly (Helius closes idle sockets after 10 min).
 * Emits 'open', 'close', 'message'.
 */
export class JsonRpcWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private subs = new Map<number, Sub>();
  private serverToLocal = new Map<number, number>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextLocal = 1;
  private nextReq = 1;
  private backoff = 1000;
  private stopped = true;
  private pingTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  connected = false;
  reconnects = 0;
  lastMessageAt: number | null = null;
  lastError: string | null = null;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly usage: UsageTracker,
  ) {
    super();
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Registers a subscription; it is (re)sent on every connect. Returns a local id for unsubscribe. */
  subscribe(method: string, params: unknown[], unsubMethod: string, handler: (result: any) => void): number {
    const local = this.nextLocal++;
    const sub: Sub = { method, params, unsubMethod, handler, serverId: null };
    this.subs.set(local, sub);
    if (this.connected) void this.sendSubscribe(local, sub);
    return local;
  }

  unsubscribe(local: number) {
    const sub = this.subs.get(local);
    if (!sub) return;
    this.subs.delete(local);
    if (sub.serverId !== null) {
      this.serverToLocal.delete(sub.serverId);
      if (this.connected) this.request(sub.unsubMethod, [sub.serverId]).catch(() => undefined);
    }
  }

  get subscriptionCount() {
    return this.subs.size;
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.backoff = 1000;
      this.lastError = null;
      this.log.info({ subscriptions: this.subs.size }, 'websocket connected');
      for (const [local, sub] of this.subs) void this.sendSubscribe(local, sub);
      this.startPing();
      this.emit('open');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const text = data.toString();
      this.usage.ws(text.length);
      this.lastMessageAt = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'RPC error'));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method && msg.params?.subscription !== undefined) {
        const local = this.serverToLocal.get(msg.params.subscription);
        const sub = local !== undefined ? this.subs.get(local) : undefined;
        if (sub) {
          try {
            sub.handler(msg.params.result);
          } catch (err) {
            this.log.error({ err }, 'subscription handler failed');
          }
        }
      }
    });

    ws.on('pong', () => {
      this.awaitingPong = false;
    });

    ws.on('error', (err) => {
      this.lastError = err.message;
      this.log.warn({ err: err.message }, 'websocket error');
    });

    ws.on('close', (code) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.serverToLocal.clear();
      for (const sub of this.subs.values()) sub.serverId = null;
      for (const p of this.pending.values()) p.reject(new Error('socket closed'));
      this.pending.clear();
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.emit('close');
      if (this.stopped) return;
      if (wasConnected) this.log.warn({ code }, `websocket closed, reconnecting in ${this.backoff / 1000}s`);
      this.reconnects++;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        this.log.warn('websocket ping timed out, reconnecting');
        this.ws.terminate();
        return;
      }
      this.awaitingPong = true;
      this.ws.ping();
    }, 30_000);
  }

  private async sendSubscribe(local: number, sub: Sub) {
    try {
      const serverId = await this.request<number>(sub.method, sub.params);
      if (!this.subs.has(local)) {
        // Unsubscribed while the request was in flight.
        this.request(sub.unsubMethod, [serverId]).catch(() => undefined);
        return;
      }
      sub.serverId = serverId;
      this.serverToLocal.set(serverId, local);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.error({ method: sub.method, err: (err as Error).message }, 'subscribe failed');
    }
  }

  private request<T>(method: string, params: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
      const id = this.nextReq++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 15_000);
    });
  }
}
