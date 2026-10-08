import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');
const decimalString = z.union([z.string(), z.number()]).transform(String).refine((s) => /^\d+(\.\d+)?$/.test(s), 'must be a non-negative decimal');

const common = {
  id: z.string().min(1).regex(/^[\w.-]+$/, 'id may contain letters, digits, _ . -'),
  addresses: z.array(address).min(1),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  /** Minimum seconds between alerts for the same rule+scope. 0 disables. */
  cooldownSeconds: z.number().int().min(0).default(0),
  cooldownScope: z.enum(['rule', 'contract']).default('contract'),
  /** Sink names to notify. Omitted = all configured sinks. */
  sinks: z.array(z.string()).optional(),
};

export const RuleSchema = z.discriminatedUnion('type', [
  z.object({
    ...common,
    type: z.literal('erc20_transfer'),
    minAmount: decimalString,
    decimals: z.number().int().min(0).max(36).default(18),
    symbol: z.string().default('TOKEN'),
    from: address.optional(),
    to: address.optional(),
  }),
  z.object({
    ...common,
    type: z.literal('v2_price_move'),
    /** Alert when the pool price moved at least this much (percent) since the last alert/baseline. */
    thresholdPercent: z.number().positive().max(10000),
    decimals0: z.number().int().min(0).max(36).default(18),
    decimals1: z.number().int().min(0).max(36).default(18),
    pair: z.string().default('token0/token1'),
  }),
  z.object({
    ...common,
    type: z.literal('v2_large_swap'),
    /** Minimum token amount (human units) on either side of the swap. */
    minAmount: decimalString,
    token: z.union([z.literal(0), z.literal(1)]).default(0),
    decimals: z.number().int().min(0).max(36).default(18),
    pair: z.string().default('token0/token1'),
  }),
  z.object({ ...common, type: z.literal('ownership_transferred') }),
  z.object({ ...common, type: z.literal('paused_state') }),
  z.object({
    ...common,
    type: z.literal('aave_liquidation'),
    minDebtToCover: decimalString.default('0'),
    debtDecimals: z.number().int().min(0).max(36).default(18),
    debtSymbol: z.string().default('DEBT'),
  }),
]);
export type Rule = z.infer<typeof RuleSchema>;

const SinkSchema = z.discriminatedUnion('type', [
  z.object({
    name: z.string().min(1), type: z.literal('telegram'),
    botTokenEnv: z.string().min(1), chatId: z.union([z.string(), z.number()]).transform(String),
  }),
  z.object({ name: z.string().min(1), type: z.literal('discord'), webhookUrlEnv: z.string().min(1) }),
  z.object({
    name: z.string().min(1), type: z.literal('webhook'), urlEnv: z.string().min(1),
    secretEnv: z.string().optional(), headers: z.record(z.string()).optional(),
  }),
]);
export type SinkConfig = z.infer<typeof SinkSchema>;

export const ConfigSchema = z
  .object({
    chain: z.object({
      name: z.string().default('evm'),
      rpcUrlEnv: z.string().default('RPC_URL'),
      /** Blocks behind head a block must be before it is processed (reorg safety). */
      confirmations: z.number().int().min(0).default(12),
      pollIntervalMs: z.number().int().min(100).default(12_000),
      maxBlockRange: z.number().int().min(1).default(1000),
      /** Where to begin on first run. Omitted = start at the current safe head (no history). */
      startBlock: z.number().int().min(0).optional(),
      /** How many processed block hashes to remember for reorg detection. */
      reorgWindow: z.number().int().min(1).default(128),
    }).default({}),
    statePath: z.string().default('./state.json'),
    delivery: z.object({
      maxRetries: z.number().int().min(0).default(4),
      baseDelayMs: z.number().int().min(1).default(500),
      maxDelayMs: z.number().int().min(1).default(30_000),
      minIntervalMs: z.number().int().min(0).default(1000),
    }).default({}),
    sinks: z.array(SinkSchema).default([]),
    rules: z.array(RuleSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const names = new Set<string>();
    cfg.sinks.forEach((s, i) => {
      if (names.has(s.name)) ctx.addIssue({ code: 'custom', path: ['sinks', i, 'name'], message: `duplicate sink name "${s.name}"` });
      names.add(s.name);
    });
    const ids = new Set<string>();
    cfg.rules.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: 'custom', path: ['rules', i, 'id'], message: `duplicate rule id "${r.id}"` });
      ids.add(r.id);
      for (const s of r.sinks ?? []) {
        if (!names.has(s)) ctx.addIssue({ code: 'custom', path: ['rules', i, 'sinks'], message: `unknown sink "${s}"` });
      }
    });
  });
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function parseConfig(raw: unknown): Config {
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid config:\n${msg}`);
  }
  return res.data;
}

/** Load YAML or JSON (JSON is valid YAML). */
export function loadConfig(path: string): Config {
  return parseConfig(parse(readFileSync(path, 'utf8')));
}
