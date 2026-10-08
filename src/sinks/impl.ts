import { createHmac } from 'node:crypto';
import type { Alert, Sink } from '../types.js';
import { postJson, type FetchLike } from './http.js';

const ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨' } as const;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lines = (a: Alert) => [`${a.title}`, a.message, `contract ${a.contract}`, `tx ${a.txHash} (block ${a.blockNumber})`];

export class TelegramSink implements Sink {
  constructor(readonly name: string, private o: { botToken: string; chatId: string; fetch: FetchLike }) {}
  send(a: Alert) {
    const text = `${ICON[a.severity]} <b>${esc(a.title)}</b>\n${esc(a.message)}\n<code>${esc(a.contract)}</code>\ntx <code>${esc(a.txHash)}</code> (block ${a.blockNumber})`;
    return postJson(this.o.fetch, `https://api.telegram.org/bot${this.o.botToken}/sendMessage`, {
      chat_id: this.o.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    });
  }
}

export class DiscordSink implements Sink {
  constructor(readonly name: string, private o: { webhookUrl: string; fetch: FetchLike }) {}
  send(a: Alert) {
    const color = { info: 0x3498db, warning: 0xf1c40f, critical: 0xe74c3c }[a.severity];
    return postJson(this.o.fetch, this.o.webhookUrl, {
      embeds: [{
        title: a.title, description: a.message, color,
        fields: [
          { name: 'Contract', value: a.contract }, { name: 'Tx', value: a.txHash },
          { name: 'Block', value: String(a.blockNumber), inline: true }, { name: 'Rule', value: a.ruleId, inline: true },
        ],
      }],
    });
  }
}

export class WebhookSink implements Sink {
  constructor(readonly name: string, private o: { url: string; secret?: string | undefined; headers?: Record<string, string> | undefined; fetch: FetchLike }) {}
  send(a: Alert) {
    const body = { version: 1, alert: a };
    const headers: Record<string, string> = { ...this.o.headers };
    if (this.o.secret) headers['x-signature-sha256'] = createHmac('sha256', this.o.secret).update(JSON.stringify(body)).digest('hex');
    return postJson(this.o.fetch, this.o.url, body, headers);
  }
}

/** Prints alerts to stdout. Used by the demo and as a handy dry-run sink. */
export class ConsoleSink implements Sink {
  constructor(readonly name = 'console', private out: (s: string) => void = console.log) {}
  async send(a: Alert) { this.out(`[${a.severity.toUpperCase()}] ${lines(a).join(' | ')}`); }
}
