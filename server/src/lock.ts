import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HEARTBEAT_MS = 5_000;
const STALE_MS = 20_000;

interface LockInfo {
  id: string;
  pid: number;
  host: string;
  startedAt: number;
  heartbeat: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes sure only one bot instance uses the data folder at a time (e.g. `pnpm dev` on the Mac and the
 * Docker container both mounting ./data). Works across the host/container boundary via a heartbeat
 * timestamp, since PIDs are not comparable between them.
 */
export function acquireLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'bot.lock');
  const host = os.hostname();
  const id = crypto.randomUUID();

  if (fs.existsSync(file)) {
    let existing: LockInfo | undefined;
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      existing = undefined;
    }
    if (existing) {
      const sameHost = existing.host === host;
      const fresh = Date.now() - existing.heartbeat < STALE_MS;
      // On the same machine we can check the PID directly; a lock left by our own PID is from a
      // previous run of this process slot (e.g. a restarted container where we are PID 1 again).
      const ownerAlive = sameHost ? existing.pid !== process.pid && pidAlive(existing.pid) : fresh;
      if (ownerAlive) {
        throw new Error(
          `Another copy of the bot is already running (pid ${existing.pid} on ${existing.host}, started ` +
            `${new Date(existing.startedAt).toLocaleString()}). Stop it first – running two at once would double every trade.`,
        );
      }
    }
  }

  const info: LockInfo = { id, pid: process.pid, host, startedAt: Date.now(), heartbeat: Date.now() };
  const write = () => fs.writeFileSync(file, JSON.stringify(info));
  write();
  const timer = setInterval(() => {
    info.heartbeat = Date.now();
    write();
  }, HEARTBEAT_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    try {
      const current: LockInfo = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.id === id) fs.unlinkSync(file);
    } catch {
      // already gone
    }
  };
}
