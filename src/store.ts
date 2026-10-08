import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Hex } from './types.js';

export interface Cursor {
  /** Last fully processed block. */
  lastBlock: number;
  /** Cursor position when the state was created; a reorg that outruns the hash window rewinds no further. */
  origin: number;
  /** Hashes of recently processed blocks, used to detect reorgs. */
  hashes: Record<number, Hex>;
}

interface StateShape {
  cursor: Cursor | null;
  seen: Record<string, number>;      // dedup key -> unix ms
  cooldowns: Record<string, number>; // cooldown key -> unix ms of last alert
  kv: Record<string, string>;        // rule scratch state (e.g. price baselines)
}

const MAX_SEEN = 20_000;

/** In-memory state. FileStore extends it with atomic JSON persistence. */
export class MemoryStore {
  protected s: StateShape = { cursor: null, seen: {}, cooldowns: {}, kv: {} };

  getCursor(): Cursor | null { return this.s.cursor ? structuredClone(this.s.cursor) : null; }
  setCursor(c: Cursor): void { this.s.cursor = structuredClone(c); this.persist(); }

  hasSeen(key: string): boolean { return key in this.s.seen; }
  markSeen(key: string, nowMs: number): void {
    this.s.seen[key] = nowMs;
    const keys = Object.keys(this.s.seen);
    if (keys.length > MAX_SEEN) {
      keys.sort((a, b) => this.s.seen[a]! - this.s.seen[b]!).slice(0, keys.length - MAX_SEEN).forEach((k) => delete this.s.seen[k]);
    }
    this.persist();
  }

  getCooldown(key: string): number | undefined { return this.s.cooldowns[key]; }
  setCooldown(key: string, nowMs: number): void { this.s.cooldowns[key] = nowMs; this.persist(); }

  getKv(key: string): string | undefined { return this.s.kv[key]; }
  setKv(key: string, value: string): void { this.s.kv[key] = value; this.persist(); }

  protected persist(): void {}
}

/** JSON file store; writes are atomic (temp file + rename) so a crash never leaves a torn cursor. */
export class FileStore extends MemoryStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      const loaded = JSON.parse(readFileSync(path, 'utf8')) as StateShape;
      this.s = { cursor: loaded.cursor ?? null, seen: loaded.seen ?? {}, cooldowns: loaded.cooldowns ?? {}, kv: loaded.kv ?? {} };
    }
  }
  protected override persist(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.s));
    renameSync(tmp, this.path);
  }
}
