import { describe, expect, it } from 'vitest';
import { FileStore, MemoryStore } from '../src/store.js';
import { MockChain } from '../src/testing/mockChain.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALICE, BOB, TOKEN, rules, setup, transferEv } from './helpers.js';

const E18 = 10n ** 18n;
const big = rules({ id: 'big', type: 'erc20_transfer', addresses: [TOKEN], minAmount: '100' });

describe('dedup + cooldown', () => {
  it('same log is never alerted twice, even across tick re-scans', async () => {
    const t = setup(big);
    t.chain.mine(transferEv(500n * E18));
    await t.monitor.tick();
    // force re-scan of the same block by rewinding the cursor manually
    t.store.setCursor({ lastBlock: 0, origin: -1, hashes: {} });
    const r = await t.monitor.tick();
    expect(t.rec.alerts).toHaveLength(1);
    expect(r.suppressed).toBe(1);
  });
  it('cooldown suppresses alerts inside the window and allows them after', async () => {
    let now = 1_000_000;
    const cd = rules({ id: 'big', type: 'erc20_transfer', addresses: [TOKEN], minAmount: '100', cooldownSeconds: 60 });
    const t = setup(cd, { now: () => now });
    t.chain.mine(transferEv(500n * E18));
    t.chain.mine(transferEv(600n * E18));
    const r1 = await t.monitor.tick();
    expect(r1.alertsSent).toBe(1);
    expect(r1.suppressed).toBe(1);
    now += 61_000;
    t.chain.mine(transferEv(700n * E18));
    await t.monitor.tick();
    expect(t.rec.alerts.map((a) => a.fields.amount)).toEqual(['500', '700']);
  });
  it('cooldown scope "contract" is independent per contract; "rule" is shared', async () => {
    const other = '0x00000000000000000000000000000000000000c1' as const;
    const mk = (scope: string) => rules({ id: 'x', type: 'erc20_transfer', addresses: [TOKEN, other], minAmount: '1', cooldownSeconds: 600, cooldownScope: scope });
    for (const [scope, expected] of [['contract', 2], ['rule', 1]] as const) {
      const t = setup(mk(scope));
      t.chain.mine(transferEv(5n * E18, ALICE, BOB, TOKEN), transferEv(5n * E18, ALICE, BOB, other));
      await t.monitor.tick();
      expect(t.rec.alerts).toHaveLength(expected);
    }
  });
});

describe('cursor', () => {
  it('only scans confirmed blocks and advances the cursor', async () => {
    const t = setup(big, { confirmations: 3 });
    t.chain.mine(transferEv(500n * E18)); // block 1, head 1
    expect((await t.monitor.tick()).alertsSent).toBe(0); // not yet 3 deep
    t.chain.mine(); t.chain.mine();
    expect((await t.monitor.tick()).alertsSent).toBe(0); // head 3, safe 0
    t.chain.mine();                                       // head 4, safe 1
    const r = await t.monitor.tick();
    expect(r.alertsSent).toBe(1);
    expect(t.store.getCursor()?.lastBlock).toBe(1);
  });
  it('chunks by maxBlockRange', async () => {
    const t = setup(big, { maxBlockRange: 10 });
    for (let i = 0; i < 25; i++) t.chain.mine();
    await t.monitor.tick();
    expect(t.chain.getLogsCalls).toEqual([[0, 9], [10, 19], [20, 25]]);
  });
  it('starts at the safe head when no startBlock is given (no history replay)', async () => {
    const chain = new MockChain(5);
    chain.mine(transferEv(500n * E18));
    const t = setup(big, { chain, startBlock: undefined as unknown as number });
    // setup defaults startBlock to 0; build explicitly for the "none" case:
    const store = new MemoryStore();
    const { Monitor } = await import('../src/monitor.js');
    const m = new Monitor(chain, store, big, t.rec, { confirmations: 0, maxBlockRange: 100, reorgWindow: 10 });
    await m.tick();
    expect(t.rec.alerts).toHaveLength(0);
    chain.mine(transferEv(500n * E18));
    await m.tick();
    expect(t.rec.alerts).toHaveLength(1);
  });
  it('resumes from a persisted file after a restart without re-alerting', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'oea-')), 'state.json');
    const chain = new MockChain(0);
    chain.mine(transferEv(500n * E18));
    const a = setup(big, { chain, store: new FileStore(path) });
    await a.monitor.tick();
    expect(a.rec.alerts).toHaveLength(1);
    chain.mine(transferEv(800n * E18));
    const b = setup(big, { chain, store: new FileStore(path) }); // "restart"
    const r = await b.monitor.tick();
    expect(r.scannedFrom).toBe(2);
    expect(b.rec.alerts.map((x) => x.fields.amount)).toEqual(['800']);
  });
});

describe('reorg handling', () => {
  it('detects a reorg, rewinds, and alerts on the replacement-chain logs once', async () => {
    const t = setup(big, { startBlock: null });
    await t.monitor.tick(); // anchors the cursor (and its hash) at block 0
    t.chain.mine(transferEv(500n * E18, ALICE, BOB, TOKEN)); // block 1 (will be orphaned)
    t.chain.mine();                                          // block 2
    await t.monitor.tick();
    expect(t.rec.alerts).toHaveLength(1);

    t.chain.reorg(1);                                        // drop blocks 1,2
    t.chain.mine(transferEv(900n * E18));                    // new block 1 with a different tx
    t.chain.mine();                                          // new block 2
    const r = await t.monitor.tick();
    expect(r.reorgDepth).toBe(2);
    expect(t.rec.alerts.map((a) => a.fields.amount)).toEqual(['500', '900']);
  });
  it('a log that survives the reorg (same tx + index) is not re-alerted', async () => {
    const t = setup(big, { startBlock: null });
    await t.monitor.tick();
    const tx = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    t.chain.mine({ ...transferEv(500n * E18), tx });
    await t.monitor.tick();
    t.chain.reorg(1);
    t.chain.mine({ ...transferEv(500n * E18), tx }); // same tx re-included in new block
    const r = await t.monitor.tick();
    expect(r.reorgDepth).toBe(1);
    expect(t.rec.alerts).toHaveLength(1);
    expect(r.suppressed).toBe(1);
  });
  it('handles the head moving backwards (block missing)', async () => {
    const t = setup(big, { startBlock: null });
    await t.monitor.tick();
    t.chain.mine(); t.chain.mine(); t.chain.mine();
    await t.monitor.tick();
    t.chain.reorg(2); // head now 1
    const r = await t.monitor.tick();
    expect(r.reorgDepth).toBe(3); // conservative: rewinds to the last remembered matching hash (block 0)
    expect(r.scannedTo).toBe(1);
    expect(t.store.getCursor()?.lastBlock).toBe(1);
  });
  it('confirmation depth keeps shallow reorgs from ever producing alerts', async () => {
    const t = setup(big, { confirmations: 2, startBlock: null });
    t.chain.mine(transferEv(500n * E18)); // block 1
    t.chain.mine();
    await t.monitor.tick();               // safe head 0
    t.chain.reorg(1);                     // orphaned before confirmation
    t.chain.mine(); t.chain.mine(); t.chain.mine();
    const r = await t.monitor.tick();
    expect(r.reorgDepth).toBe(0);
    expect(t.rec.alerts).toHaveLength(0);
  });
});

describe('reorg edge: sparse hashes', () => {
  it('a reorg inside one big scanned chunk rewinds to the origin and still recovers every log', async () => {
    const t = setup(big); // startBlock 0 -> origin -1
    t.chain.mine(transferEv(500n * E18)); t.chain.mine();
    await t.monitor.tick();               // one chunk 0..2, only block 2's hash remembered
    t.chain.reorg(1);
    t.chain.mine(transferEv(900n * E18)); t.chain.mine();
    await t.monitor.tick();
    expect(t.rec.alerts.map((a) => a.fields.amount)).toEqual(['500', '900']);
  });
});
