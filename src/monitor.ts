import type { Config, Rule } from './config.js';
import { decodeLog } from './decode.js';
import { AlertGate } from './gate.js';
import { evaluateRule } from './rules.js';
import type { Cursor, MemoryStore } from './store.js';
import type { Alert, ChainClient, Hex, Sink } from './types.js';

export interface Dispatcher {
  dispatch(alert: Alert, sinkNames: string[] | undefined): Promise<void>;
}

export interface MonitorOptions {
  confirmations: number;
  maxBlockRange: number;
  reorgWindow: number;
  startBlock?: number | undefined;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface TickResult {
  head: number;
  safeHead: number;
  scannedFrom: number | null;
  scannedTo: number | null;
  logs: number;
  alertsSent: number;
  suppressed: number;
  reorgDepth: number;
}

export class Monitor {
  private readonly gate: AlertGate;
  private readonly addresses: Hex[];
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(
    private readonly chain: ChainClient,
    private readonly store: MemoryStore,
    private readonly rules: Rule[],
    private readonly dispatcher: Dispatcher,
    private readonly opts: MonitorOptions,
  ) {
    this.gate = new AlertGate(store);
    this.addresses = [...new Set(rules.flatMap((r) => r.addresses.map((a) => a.toLowerCase() as Hex)))];
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** One poll iteration. Safe to call repeatedly; all progress is persisted in the store. */
  async tick(): Promise<TickResult> {
    const head = await this.chain.getBlockNumber();
    const safeHead = Math.max(0, head - this.opts.confirmations);
    const res: TickResult = { head, safeHead, scannedFrom: null, scannedTo: null, logs: 0, alertsSent: 0, suppressed: 0, reorgDepth: 0 };

    let cursor = this.store.getCursor();
    if (!cursor) {
      const start = this.opts.startBlock !== undefined ? this.opts.startBlock - 1 : safeHead;
      cursor = { lastBlock: Math.max(-1, start), origin: Math.max(-1, start), hashes: {} };
      const h = start >= 0 ? await this.chain.getBlockHash(start) : null;
      if (h) cursor.hashes[start] = h;
      this.store.setCursor(cursor);
    }

    const rewind = await this.detectReorg(cursor);
    cursor = rewind.cursor;
    res.reorgDepth = rewind.depth;
    if (rewind.depth > 0) {
      this.log(`reorg detected: rewound ${rewind.depth} block(s) to ${cursor.lastBlock}`);
      this.store.setCursor(cursor);
    }

    let from = cursor.lastBlock + 1;
    while (from <= safeHead) {
      const to = Math.min(from + this.opts.maxBlockRange - 1, safeHead);
      const logs = await this.chain.getLogs(this.addresses, from, to);
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      res.logs += logs.length;
      for (const raw of logs) {
        const ev = decodeLog(raw);
        if (!ev) continue;
        for (const rule of this.rules) {
          const alert = evaluateRule(rule, ev, { get: (k) => this.store.getKv(k), set: (k, v) => this.store.setKv(k, v) });
          if (!alert) continue;
          const now = this.now();
          const verdict = this.gate.check(rule, alert, now);
          this.gate.commit(rule, alert, verdict, now);
          if (verdict !== 'send') { res.suppressed++; continue; }
          res.alertsSent++;
          await this.dispatcher.dispatch(alert, rule.sinks);
        }
      }
      const toHash = await this.chain.getBlockHash(to);
      if (toHash) cursor.hashes[to] = toHash;
      cursor.lastBlock = to;
      for (const k of Object.keys(cursor.hashes)) if (Number(k) <= to - this.opts.reorgWindow) delete cursor.hashes[Number(k)];
      this.store.setCursor(cursor); // persist after every chunk: restart resumes here
      res.scannedFrom ??= from;
      res.scannedTo = to;
      from = to + 1;
    }
    return res;
  }

  /**
   * Compare remembered block hashes with the chain. Any mismatch (or a block that no longer exists)
   * means those blocks were reorged out; rewind the cursor to the newest block that still matches.
   * Logs from the replaced blocks are re-scanned; the dedup gate prevents duplicate alerts for
   * logs that survive in the new chain (same tx hash + log index).
   */
  private async detectReorg(cursor: Cursor): Promise<{ cursor: Cursor; depth: number }> {
    const known = Object.keys(cursor.hashes).map(Number).sort((a, b) => b - a);
    let depth = 0;
    const next: Cursor = { lastBlock: cursor.lastBlock, origin: cursor.origin, hashes: { ...cursor.hashes } };
    for (const n of known) {
      const onChain = await this.chain.getBlockHash(n);
      if (onChain && onChain.toLowerCase() === next.hashes[n]!.toLowerCase()) {
        next.lastBlock = Math.min(next.lastBlock, n);
        return { cursor: next, depth: cursor.lastBlock - next.lastBlock };
      }
      delete next.hashes[n];
      depth++;
    }
    if (known.length === 0) return { cursor: next, depth: 0 };
    // Nothing remembered matched (hashes are sparse when a tick scans many blocks at once):
    // rewind conservatively - at most one chunk before the oldest remembered hash, never before the origin.
    next.lastBlock = Math.max(cursor.origin, Math.min(...known) - this.opts.maxBlockRange);
    return { cursor: next, depth: cursor.lastBlock - next.lastBlock };
  }

  /** Poll forever until the signal aborts. Errors in a tick are logged and retried next interval. */
  async run(pollIntervalMs: number, signal: AbortSignal, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<void> {
    while (!signal.aborted) {
      try {
        const r = await this.tick();
        if (r.scannedTo !== null) this.log(`scanned ${r.scannedFrom}-${r.scannedTo}: ${r.logs} logs, ${r.alertsSent} alerts, ${r.suppressed} suppressed`);
      } catch (e) {
        this.log(`tick failed: ${(e as Error).message}`);
      }
      await sleep(pollIntervalMs);
    }
  }
}

export function monitorOptionsFromConfig(c: Config['chain']): MonitorOptions {
  return { confirmations: c.confirmations, maxBlockRange: c.maxBlockRange, reorgWindow: c.reorgWindow, startBlock: c.startBlock };
}
