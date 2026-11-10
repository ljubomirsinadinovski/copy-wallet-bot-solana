import crypto from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { sessions } from './db/schema.js';

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'cw_session';

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Login sessions are stored hashed in the DB so dev auto-restarts don't log you out. */
export class Sessions {
  private failures: number[] = [];

  constructor(private readonly db: Db) {
    this.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
  }

  create(): { token: string; maxAge: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const maxAge = SESSION_DAYS * 86_400;
    this.db.insert(sessions).values({ tokenHash: hash(token), createdAt: now, expiresAt: now + maxAge * 1000 }).run();
    return { token, maxAge };
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db.select().from(sessions).where(eq(sessions.tokenHash, hash(token))).get();
    return Boolean(row && row.expiresAt > Date.now());
  }

  destroy(token: string | undefined): void {
    if (token) this.db.delete(sessions).where(eq(sessions.tokenHash, hash(token))).run();
  }

  /** Simple brute-force brake: after 5 failures within a minute, refuse attempts for the rest of that minute. */
  throttled(): boolean {
    const cutoff = Date.now() - 60_000;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= 5;
  }

  recordFailure(): void {
    this.failures.push(Date.now());
  }
}
