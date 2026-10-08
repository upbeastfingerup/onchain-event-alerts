/**
 * Offline demo: runs the real Monitor/rules/dedup/reorg code against an in-memory chain.
 * No network, no secrets. `npm run demo`
 */
import { parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { ConsoleSink } from '../src/sinks/impl.js';
import { SinkDispatcher } from '../src/sinks/factory.js';
import { MemoryStore } from '../src/store.js';
import { MockChain, addr } from '../src/testing/mockChain.js';

const TOKEN = addr(0xaaa), POOL = addr(0xbbb), VAULT = addr(0xccc), ALICE = addr(1), BOB = addr(2);
const cfg = parseConfig({
  rules: [
    { id: 'whales', type: 'erc20_transfer', addresses: [TOKEN], minAmount: 1000000, decimals: 6, symbol: 'USDX', cooldownSeconds: 60 },
    { id: 'price', type: 'v2_price_move', addresses: [POOL], thresholdPercent: 5, pair: 'WETH/USDX', decimals0: 18, decimals1: 6 },
    { id: 'owner', type: 'ownership_transferred', addresses: [VAULT], severity: 'critical' },
    { id: 'pause', type: 'paused_state', addresses: [VAULT], severity: 'critical' },
  ],
});

const say = (s: string) => console.log(`\n--- ${s}`);
const chain = new MockChain(0);
let clock = Date.now();
const monitor = new Monitor(chain, new MemoryStore(), cfg.rules, new SinkDispatcher([new ConsoleSink()]), {
  confirmations: 2, maxBlockRange: 1000, reorgWindow: 64, now: () => clock, log: (m) => console.log(`  (monitor) ${m}`),
});
const step = async (label: string) => { const r = await monitor.tick(); console.log(`  tick: head=${r.head} safe=${r.safeHead} logs=${r.logs} sent=${r.alertsSent} suppressed=${r.suppressed} reorgDepth=${r.reorgDepth}`); void label; };
const mineEmpty = (n: number) => { for (let i = 0; i < n; i++) chain.mine(); };
const sync = (usdx: bigint) => ({ address: POOL, name: 'Sync' as const, args: { reserve0: 1000n * 10n ** 18n, reserve1: usdx * 10n ** 6n } });

await monitor.tick();
say('1. whale transfer (1.5M USDX) and a small one');
chain.mine({ address: TOKEN, name: 'Transfer', args: { from: ALICE, to: BOB, value: 1_500_000n * 10n ** 6n } }, { address: TOKEN, name: 'Transfer', args: { from: ALICE, to: BOB, value: 50n * 10n ** 6n } });
mineEmpty(2); await step('whale');

say('2. second whale inside the 60s cooldown -> suppressed');
chain.mine({ address: TOKEN, name: 'Transfer', args: { from: BOB, to: ALICE, value: 2_000_000n * 10n ** 6n } });
mineEmpty(2); await step('cooldown');

say('3. pool price baseline 2000, then +10% move');
chain.mine(sync(2_000_000n)); chain.mine(sync(2_200_000n)); mineEmpty(2); await step('price');

say('4. governance: ownership transfer + pause (critical)');
chain.mine({ address: VAULT, name: 'OwnershipTransferred', args: { previousOwner: ALICE, newOwner: BOB } }, { address: VAULT, name: 'Paused', args: { account: BOB } });
mineEmpty(2); await step('gov');

say('5. reorg: an unconfirmed block is replaced before it reaches confirmation depth -> never alerts');
chain.mine({ address: VAULT, name: 'Unpaused', args: { account: BOB } }); mineEmpty(1); await step('pre-reorg');
chain.reorg(chain.head - 1); mineEmpty(3); await step('post-reorg');

say('6. deep reorg: a processed block is replaced (new tx in its place) -> rewind and alert once for the new chain');
clock += 120_000;
const h = chain.head;
chain.mine({ address: TOKEN, name: 'Transfer', args: { from: ALICE, to: BOB, value: 3_000_000n * 10n ** 6n } }); mineEmpty(2); await step('seen');
chain.reorg(h + 1); // orphan the whale block + the two after it
clock += 120_000;     // past the cooldown so the replacement alert is visible
chain.mine({ address: TOKEN, name: 'Transfer', args: { from: BOB, to: ALICE, value: 4_000_000n * 10n ** 6n } }); mineEmpty(3); await step('after deep reorg');
