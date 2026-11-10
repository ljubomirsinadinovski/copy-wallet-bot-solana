import { EventEmitter } from 'node:events';
import type { CopyTrade, Signal } from './db/schema.js';

export type BusEvent =
  | { type: 'signal'; signal: Signal }
  | { type: 'trade'; trade: CopyTrade }
  | { type: 'positions' }
  | { type: 'status' }
  /** Something you should know about right away (sent to Telegram). */
  | { type: 'alert'; text: string };

/** In-process event bus; the API forwards these to the web UI over WebSocket. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(e: BusEvent) {
  bus.emit('event', e);
}
