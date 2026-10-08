import type { Config } from '../config.js';
import type { Dispatcher } from '../monitor.js';
import type { Alert, Sink } from '../types.js';
import type { FetchLike } from './http.js';
import { DiscordSink, TelegramSink, WebhookSink } from './impl.js';
import { ReliableSink, type ReliableOptions } from './reliable.js';

export class ConfigEnvError extends Error {}

/** Build sinks from config. Secrets are read from env vars named in the config, never from the file itself. */
export function buildSinks(cfg: Config, env: Record<string, string | undefined>, fetchImpl: FetchLike, rel: Partial<ReliableOptions> = {}): Sink[] {
  const need = (n: string) => {
    const v = env[n];
    if (!v) throw new ConfigEnvError(`environment variable ${n} is not set`);
    return v;
  };
  return cfg.sinks.map((s) => {
    const inner: Sink =
      s.type === 'telegram' ? new TelegramSink(s.name, { botToken: need(s.botTokenEnv), chatId: s.chatId, fetch: fetchImpl })
      : s.type === 'discord' ? new DiscordSink(s.name, { webhookUrl: need(s.webhookUrlEnv), fetch: fetchImpl })
      : new WebhookSink(s.name, { url: need(s.urlEnv), secret: s.secretEnv ? need(s.secretEnv) : undefined, headers: s.headers, fetch: fetchImpl });
    return new ReliableSink(inner, { ...cfg.delivery, ...rel });
  });
}

/** Fans an alert out to the selected sinks; one failing sink never blocks the others. */
export class SinkDispatcher implements Dispatcher {
  private readonly byName: Map<string, Sink>;
  constructor(sinks: Sink[], private onError: (sink: string, alert: Alert, e: unknown) => void = () => {}) {
    this.byName = new Map(sinks.map((s) => [s.name, s]));
  }
  async dispatch(alert: Alert, names: string[] | undefined): Promise<void> {
    const targets = (names ?? [...this.byName.keys()]).map((n) => this.byName.get(n)).filter((s): s is Sink => !!s);
    await Promise.all(targets.map((s) => s.send(alert).catch((e) => this.onError(s.name, alert, e))));
  }
}
