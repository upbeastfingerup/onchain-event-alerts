import type { Rule } from './config.js';
import type { MemoryStore } from './store.js';
import type { Alert } from './types.js';

export type GateResult = 'send' | 'duplicate' | 'cooldown';

/**
 * Suppresses (1) exact duplicates - the same log seen again after a restart or a reorg rewind
 * re-scan - and (2) alert floods, via a per-rule (or per-rule+contract) cooldown window.
 */
export class AlertGate {
  constructor(private readonly store: MemoryStore) {}

  static dedupKey(a: Alert): string { return `${a.ruleId}:${a.txHash}:${a.logIndex}`; }
  static cooldownKey(rule: Rule, a: Alert): string {
    return rule.cooldownScope === 'rule' ? `cd:${rule.id}` : `cd:${rule.id}:${a.contract.toLowerCase()}`;
  }

  check(rule: Rule, alert: Alert, nowMs: number): GateResult {
    if (this.store.hasSeen(AlertGate.dedupKey(alert))) return 'duplicate';
    if (rule.cooldownSeconds > 0) {
      const last = this.store.getCooldown(AlertGate.cooldownKey(rule, alert));
      if (last !== undefined && nowMs - last < rule.cooldownSeconds * 1000) return 'cooldown';
    }
    return 'send';
  }

  /** Record that an alert was emitted. Cooldown-suppressed alerts are also marked seen (no late replay). */
  commit(rule: Rule, alert: Alert, result: GateResult, nowMs: number): void {
    this.store.markSeen(AlertGate.dedupKey(alert), nowMs);
    if (result === 'send' && rule.cooldownSeconds > 0) this.store.setCooldown(AlertGate.cooldownKey(rule, alert), nowMs);
  }
}
