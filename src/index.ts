#!/usr/bin/env node
import { loadConfig, ConfigError } from './config.js';
import { createViemChain } from './chain.js';
import { Monitor, monitorOptionsFromConfig } from './monitor.js';
import { buildSinks, SinkDispatcher } from './sinks/factory.js';
import { FileStore } from './store.js';

const args = process.argv.slice(2);
const cmd = args[0];
const ci = args.indexOf('--config');
const configPath = ci >= 0 ? args[ci + 1] : 'config.yaml';
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  if (cmd !== 'run' && cmd !== 'validate') {
    console.error('usage: onchain-event-alerts <run|validate> [--config path]');
    process.exit(2);
  }
  const cfg = loadConfig(configPath!);
  if (cmd === 'validate') {
    console.log(`OK: ${cfg.rules.length} rule(s), ${cfg.sinks.length} sink(s)`);
    return;
  }
  const rpc = process.env[cfg.chain.rpcUrlEnv];
  if (!rpc) throw new ConfigError(`environment variable ${cfg.chain.rpcUrlEnv} is not set`);
  const sinks = buildSinks(cfg, process.env, (u, i) => fetch(u, i));
  const dispatcher = new SinkDispatcher(sinks, (s, a, e) => log(`sink ${s} failed for ${a.ruleId}: ${(e as Error).message}`));
  const monitor = new Monitor(createViemChain(rpc), new FileStore(cfg.statePath), cfg.rules, dispatcher, { ...monitorOptionsFromConfig(cfg.chain), log });
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort());
  log(`watching ${cfg.rules.length} rule(s) on ${cfg.chain.name}, confirmations=${cfg.chain.confirmations}`);
  await monitor.run(cfg.chain.pollIntervalMs, ac.signal);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
