import { useEffect, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { api, type LogEntry } from './api';

// ── log store shared by the Logs page ─────────────────────────────────────
let logs: LogEntry[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function useLogs(): LogEntry[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => logs,
  );
}

let connected = false;
const connListeners = new Set<() => void>();
export function useLiveConnected(): boolean {
  return useSyncExternalStore(
    (cb) => {
      connListeners.add(cb);
      return () => connListeners.delete(cb);
    },
    () => connected,
  );
}

/**
 * One WebSocket for the whole app. Server events invalidate the matching queries (batched), so
 * every page updates within a moment of a trade without polling.
 */
export function useLiveUpdates(qc: QueryClient, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    const dirty = new Set<string>();
    let flush: ReturnType<typeof setTimeout> | null = null;

    const invalidate = (...keys: string[]) => {
      keys.forEach((k) => dirty.add(k));
      if (flush) return;
      flush = setTimeout(() => {
        flush = null;
        for (const k of dirty) qc.invalidateQueries({ queryKey: [k] });
        dirty.clear();
      }, 400);
    };

    api<LogEntry[]>('/logs?limit=500')
      .then((l) => {
        logs = l;
        emit();
      })
      .catch(() => undefined);

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      ws.onopen = () => {
        connected = true;
        connListeners.forEach((l) => l());
      };
      ws.onclose = () => {
        connected = false;
        connListeners.forEach((l) => l());
        if (!stopped) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case 'log':
            logs = [...logs.slice(-1999), msg.entry];
            emit();
            break;
          case 'trade':
            invalidate('dashboard', 'trades', 'positions', 'groups', 'wallets');
            break;
          case 'signal':
            invalidate('dashboard', 'signals', 'groups');
            break;
          case 'positions':
            invalidate('dashboard', 'positions', 'groups');
            break;
          case 'status':
            invalidate('status', 'settings', 'wallets');
            break;
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [qc, enabled]);
}
