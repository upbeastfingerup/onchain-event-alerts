import { parseConfig, type Rule } from '../src/config.js';
import { Monitor, type Dispatcher } from '../src/monitor.js';
import { MemoryStore } from '../src/store.js';
import { MockChain, addr } from '../src/testing/mockChain.js';
import type { Alert } from '../src/types.js';

export const TOKEN = addr(0xaaa);
export const POOL = addr(0xbbb);
export const ALICE = addr(1);
export const BOB = addr(2);

export function rules(...r: unknown[]): Rule[] {
  return parseConfig({ rules: r }).rules;
}

export class Recorder implements Dispatcher {
  alerts: Alert[] = [];
  async dispatch(a: Alert) { this.alerts.push(a); }
}

export function setup(ruleList: Rule[], opts: { confirmations?: number; maxBlockRange?: number; startBlock?: number | null; now?: () => number; store?: MemoryStore; chain?: MockChain } = {}) {
  const chain = opts.chain ?? new MockChain(0);
  const store = opts.store ?? new MemoryStore();
  const rec = new Recorder();
  const monitor = new Monitor(chain, store, ruleList, rec, {
    confirmations: opts.confirmations ?? 0, maxBlockRange: opts.maxBlockRange ?? 1000, reorgWindow: 64,
    startBlock: opts.startBlock === null ? undefined : (opts.startBlock ?? 0), now: opts.now ?? (() => 1_000_000),
  });
  return { chain, store, rec, monitor };
}

export const transferEv = (value: bigint, from = ALICE, to = BOB, address = TOKEN) =>
  ({ address, name: 'Transfer' as const, args: { from, to, value } });
