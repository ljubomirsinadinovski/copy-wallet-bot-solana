import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';
import { config } from './config.js';

export interface LogEntry {
  time: number;
  level: string;
  module?: string;
  msg: string;
  extra?: Record<string, unknown>;
}

const LEVEL_NAMES: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const RING_SIZE = 2000;
const ring: LogEntry[] = [];

/** Emits 'log' for every entry at info level or above; the web UI Logs page subscribes to it. */
export const logEvents = new EventEmitter();
logEvents.setMaxListeners(100);

function toEntry(line: string): LogEntry | null {
  try {
    const { time, level, module, msg, pid: _pid, hostname: _host, ...rest } = JSON.parse(line);
    return { time, level: LEVEL_NAMES[level] ?? String(level), module, msg: msg ?? '', extra: Object.keys(rest).length ? rest : undefined };
  } catch {
    return null;
  }
}

class RingStream extends Writable {
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    const entry = toEntry(chunk.toString());
    if (entry) {
      ring.push(entry);
      if (ring.length > RING_SIZE) ring.shift();
      logEvents.emit('log', entry);
    }
    cb();
  }
}

/**
 * Puts the end of the previous log files back into the Logs page after a restart, so what happened
 * while you were away is still there. Reads at most the last 1 MB of the two newest files.
 */
function restoreRecentLogs(dir: string) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^bot\.\d+\.log$/.test(f))
    .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .slice(-2);
  const restored: LogEntry[] = [];
  for (const { file } of files) {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 1_000_000);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is probably cut in half
    for (const line of lines) {
      const e = line.trim() ? toEntry(line) : null;
      if (e && ['info', 'warn', 'error', 'fatal'].includes(e.level)) restored.push(e);
    }
  }
  ring.unshift(...restored.slice(-RING_SIZE));
  ring.splice(0, Math.max(0, ring.length - RING_SIZE));
}

export function recentLogs(limit = 500): LogEntry[] {
  return ring.slice(-limit);
}

const consoleStream = config.logPretty
  ? pretty({
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname,module',
      messageFormat: '{if module}[{module}] {end}{msg}',
      sync: true,
    })
  : process.stdout;

const multistream = pino.multistream([
  { level: config.logLevel, stream: consoleStream },
  { level: 'info', stream: new RingStream() },
]);

export const logger: Logger = pino({ level: config.logLevel, base: undefined }, multistream);

export function moduleLogger(module: string): Logger {
  return logger.child({ module });
}

/** Adds the rotating log file (data/logs/bot.log, 10 MB × 5 files). */
export async function enableFileLogging(): Promise<void> {
  const dir = path.join(config.dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  try {
    restoreRecentLogs(dir);
  } catch {
    // a damaged log file must never stop the bot
  }
  const { default: pinoRoll } = await import('pino-roll');
  const stream = await pinoRoll({
    file: path.join(dir, 'bot'),
    extension: '.log',
    size: '10m',
    limit: { count: 5 },
    mkdir: true,
  });
  multistream.add({ level: config.logLevel, stream });
}
