import type { Logger } from 'pino';
import { errorMessage, sleep } from '../util/misc.js';

/** Escapes text for Telegram's HTML mode. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Sends messages to your Telegram chat. Messages are queued and sent about one per second (Telegram's
 * per-chat limit); a Telegram outage never blocks or slows down trading.
 */
export class TelegramNotifier {
  private queue: string[] = [];
  private sending = false;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  /** Queue a message (HTML). */
  send(html: string): void {
    if (!this.configured) return;
    this.queue.push(html);
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
    void this.pump();
  }

  /** Send immediately and report errors (used by the test button and at shutdown). */
  async sendNow(html: string, timeoutMs = 10_000): Promise<void> {
    if (!this.configured) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    await this.post(html, timeoutMs);
  }

  private async pump() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const msg = this.queue.shift()!;
        try {
          await this.post(msg);
        } catch (err) {
          this.log.warn({ err: errorMessage(err) }, 'telegram message not delivered');
        }
        await sleep(1100);
      }
    } finally {
      this.sending = false;
    }
  }

  private async post(html: string, timeoutMs = 10_000, retry = true): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
    if (res.status === 429 && retry) {
      await sleep(((body.parameters?.retry_after ?? 3) + 0.5) * 1000);
      return this.post(html, timeoutMs, false);
    }
    // Never include the URL (it contains the bot token) in errors.
    throw new Error(`Telegram: ${body.description ?? `HTTP ${res.status}`}`);
  }
}
