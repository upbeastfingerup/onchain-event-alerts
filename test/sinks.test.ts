import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import { buildSinks, ConfigEnvError, SinkDispatcher } from '../src/sinks/factory.js';
import type { FetchLike } from '../src/sinks/http.js';
import { DiscordSink, TelegramSink, WebhookSink } from '../src/sinks/impl.js';
import { ReliableSink, SinkHttpError } from '../src/sinks/reliable.js';
import type { Alert, Sink } from '../src/types.js';
import { createHmac } from 'node:crypto';

const alert: Alert = { ruleId: 'r', ruleType: 'erc20_transfer', severity: 'critical', title: 'T <x>', message: 'm', contract: '0x' + 'a'.repeat(40) as `0x${string}`, txHash: '0x' + 'b'.repeat(64) as `0x${string}`, blockNumber: 7, logIndex: 0, fields: {} };

const resp = (status: number, headers: Record<string, string> = {}) => ({ ok: status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });
const fakeFetch = (...statuses: Array<number | { status: number; retryAfter?: string } | Error>): FetchLike & ReturnType<typeof vi.fn> => {
  const q = [...statuses];
  return vi.fn(async () => {
    const n = q.shift() ?? 200;
    if (n instanceof Error) throw n;
    return typeof n === 'number' ? resp(n) : resp(n.status, n.retryAfter ? { 'retry-after': n.retryAfter } : {});
  });
};
const opts = (sleeps: number[], extra = {}) => ({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10_000, minIntervalMs: 0, sleep: async (ms: number) => void sleeps.push(ms), random: () => 1, ...extra });

describe('ReliableSink retry/backoff', () => {
  it('retries 5xx with exponential backoff then succeeds', async () => {
    const f = fakeFetch(500, 503, 200); const sleeps: number[] = [];
    await new ReliableSink(new WebhookSink('w', { url: 'https://x', fetch: f }), opts(sleeps)).send(alert);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]); // random()=1 -> full backoff
  });
  it('retries network errors', async () => {
    const f = fakeFetch(new Error('ECONNRESET'), 200); const sleeps: number[] = [];
    await new ReliableSink(new WebhookSink('w', { url: 'https://x', fetch: f }), opts(sleeps)).send(alert);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('honours Retry-After on 429', async () => {
    const f = fakeFetch({ status: 429, retryAfter: '5' }, 200); const sleeps: number[] = [];
    await new ReliableSink(new WebhookSink('w', { url: 'https://x', fetch: f }), opts(sleeps)).send(alert);
    expect(sleeps).toEqual([5000]);
  });
  it('does not retry non-retryable 4xx', async () => {
    const f = fakeFetch(400, 200); const sleeps: number[] = [];
    await expect(new ReliableSink(new WebhookSink('w', { url: 'https://x', fetch: f }), opts(sleeps)).send(alert)).rejects.toBeInstanceOf(SinkHttpError);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
  it('gives up after maxRetries and rethrows', async () => {
    const f = fakeFetch(500, 500, 500, 500, 500); const sleeps: number[] = [];
    await expect(new ReliableSink(new WebhookSink('w', { url: 'https://x', fetch: f }), opts(sleeps)).send(alert)).rejects.toThrow('HTTP 500');
    expect(f).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });
  it('caps backoff at maxDelayMs', async () => {
    const f = fakeFetch(500, 500, 500, 200); const sleeps: number[] = [];
    await new ReliableSink(new WebhookSink('w', { url: 'https://x', fetch: f }), opts(sleeps, { baseDelayMs: 1000, maxDelayMs: 1500 })).send(alert);
    expect(sleeps).toEqual([1000, 1500, 1500]);
  });
});

describe('ReliableSink rate limit', () => {
  it('spaces concurrent sends by minIntervalMs', async () => {
    let t = 0; const sleeps: number[] = [];
    const inner: Sink = { name: 'i', send: async () => {} };
    const s = new ReliableSink(inner, { ...opts(sleeps, { minIntervalMs: 1000 }), now: () => t, sleep: async (ms) => { sleeps.push(ms); } });
    await Promise.all([s.send(alert), s.send(alert), s.send(alert)]);
    expect(sleeps).toEqual([1000, 2000]);
  });
});

describe('sink payloads', () => {
  it('telegram: posts HTML-escaped text to the bot API', async () => {
    const f = fakeFetch(200);
    await new TelegramSink('tg', { botToken: 'TEST_TOKEN', chatId: '42', fetch: f }).send(alert);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botTEST_TOKEN/sendMessage');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ chat_id: '42', parse_mode: 'HTML' });
    expect(body.text).toContain('T &lt;x&gt;');
  });
  it('discord: sends an embed', async () => {
    const f = fakeFetch(200);
    await new DiscordSink('d', { webhookUrl: 'https://discord.example/hook', fetch: f }).send(alert);
    const body = JSON.parse(f.mock.calls[0]![1].body);
    expect(body.embeds[0]).toMatchObject({ title: 'T <x>', color: 0xe74c3c });
  });
  it('webhook: signs the exact body with HMAC-SHA256 when a secret is set', async () => {
    const f = fakeFetch(200);
    await new WebhookSink('w', { url: 'https://x', secret: 's3cret', fetch: f }).send(alert);
    const init = f.mock.calls[0]![1];
    expect(init.headers['x-signature-sha256']).toBe(createHmac('sha256', 's3cret').update(init.body).digest('hex'));
  });
});

describe('factory + dispatcher', () => {
  const cfg = parseConfig({
    sinks: [{ name: 'hook', type: 'webhook', urlEnv: 'HOOK_URL' }, { name: 'dc', type: 'discord', webhookUrlEnv: 'DC_URL' }],
    rules: [{ id: 'r', type: 'paused_state', addresses: ['0x' + 'a'.repeat(40)] }],
  });
  it('fails clearly when an env var is missing', () => {
    expect(() => buildSinks(cfg, {}, fakeFetch())).toThrow(ConfigEnvError);
  });
  it('one failing sink does not block the others; sink filter is honoured', async () => {
    const ok = vi.fn(async () => {});
    const errors: string[] = [];
    const d = new SinkDispatcher([{ name: 'bad', send: async () => { throw new Error('boom'); } }, { name: 'good', send: ok }], (n) => errors.push(n));
    await d.dispatch(alert, undefined);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['bad']);
    await d.dispatch(alert, ['bad']);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
