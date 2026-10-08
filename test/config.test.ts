import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';

const good = { rules: [{ id: 'r1', type: 'erc20_transfer', addresses: ['0x' + 'a'.repeat(40)], minAmount: 1000 }] };

describe('config validation', () => {
  it('accepts a minimal config and applies defaults', () => {
    const c = parseConfig(good);
    expect(c.chain.confirmations).toBe(12);
    expect(c.rules[0]).toMatchObject({ cooldownSeconds: 0, severity: 'warning', decimals: 18, minAmount: '1000' });
  });
  it('rejects bad addresses, unknown rule types and empty rules', () => {
    expect(() => parseConfig({ rules: [{ ...good.rules[0], addresses: ['0x123'] }] })).toThrow(ConfigError);
    expect(() => parseConfig({ rules: [{ id: 'x', type: 'nope', addresses: [] }] })).toThrow(/Invalid config/);
    expect(() => parseConfig({ rules: [] })).toThrow();
  });
  it('rejects negative thresholds and malformed amounts', () => {
    expect(() => parseConfig({ rules: [{ ...good.rules[0], minAmount: '-5' }] })).toThrow();
    expect(() => parseConfig({ rules: [{ ...good.rules[0], cooldownSeconds: -1 }] })).toThrow();
    expect(() => parseConfig({ rules: [{ id: 'p', type: 'v2_price_move', addresses: ['0x' + 'b'.repeat(40)], thresholdPercent: 0 }] })).toThrow();
  });
  it('rejects duplicate rule ids, duplicate sinks and unknown sink references', () => {
    expect(() => parseConfig({ rules: [good.rules[0], good.rules[0]] })).toThrow(/duplicate rule id/);
    const s = { name: 'a', type: 'discord', webhookUrlEnv: 'X' };
    expect(() => parseConfig({ sinks: [s, s], rules: good.rules })).toThrow(/duplicate sink/);
    expect(() => parseConfig({ rules: [{ ...good.rules[0], sinks: ['ghost'] }] })).toThrow(/unknown sink "ghost"/);
  });
  it('error message lists the path of each problem', () => {
    try { parseConfig({ rules: [{ ...good.rules[0], addresses: ['bad'] }] }); expect.unreachable(); }
    catch (e) { expect((e as Error).message).toContain('rules.0.addresses.0'); }
  });
  it('shipped example config is valid, and JSON == YAML', () => {
    const c = loadConfig('examples/rules.example.yaml');
    expect(c.rules.length).toBeGreaterThanOrEqual(6);
    const y = parse(readFileSync('examples/rules.example.yaml', 'utf8'));
    expect(parseConfig(JSON.parse(JSON.stringify(y)))).toEqual(c);
  });
});
