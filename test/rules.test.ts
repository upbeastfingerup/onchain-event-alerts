import { describe, expect, it } from 'vitest';
import { decodeLog } from '../src/decode.js';
import { evaluateRule, toUnits, type RuleState } from '../src/rules.js';
import { MockChain, addr } from '../src/testing/mockChain.js';
import { ALICE, BOB, POOL, TOKEN, rules } from './helpers.js';

const E18 = 10n ** 18n;
async function ev(e: Parameters<MockChain['mine']>[0]) {
  const c = new MockChain(0); c.mine(e);
  return decodeLog((await c.getLogs([e.address], 1, 1))[0]!)!;
}
const mem = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v) } satisfies RuleState; };

describe('toUnits', () => {
  it('converts decimals exactly', () => {
    expect(toUnits('1000000', 6)).toBe(1_000_000_000_000n);
    expect(toUnits('0.5', 18)).toBe(E18 / 2n);
    expect(toUnits('1.123456789', 6)).toBe(1_123_456n); // truncates extra precision
  });
});

describe('erc20_transfer', () => {
  const [r] = rules({ id: 't', type: 'erc20_transfer', addresses: [TOKEN], minAmount: '1000', symbol: 'USDX', decimals: 6 });
  it('fires at the threshold, not below', async () => {
    expect(evaluateRule(r!, await ev({ address: TOKEN, name: 'Transfer', args: { from: ALICE, to: BOB, value: 999_999_999n } }), mem())).toBeNull();
    const a = evaluateRule(r!, await ev({ address: TOKEN, name: 'Transfer', args: { from: ALICE, to: BOB, value: 1_000_000_000n } }), mem());
    expect(a?.message).toContain('1,000 USDX');
    expect(a?.fields.from).toBe(ALICE);
  });
  it('ignores other contracts and respects from/to filters', async () => {
    const e = await ev({ address: addr(9), name: 'Transfer', args: { from: ALICE, to: BOB, value: 10n ** 12n } });
    expect(evaluateRule(r!, e, mem())).toBeNull();
    const [f] = rules({ id: 'f', type: 'erc20_transfer', addresses: [TOKEN], minAmount: '1', decimals: 0, to: BOB });
    expect(evaluateRule(f!, await ev({ address: TOKEN, name: 'Transfer', args: { from: BOB, to: ALICE, value: 5n } }), mem())).toBeNull();
    expect(evaluateRule(f!, await ev({ address: TOKEN, name: 'Transfer', args: { from: ALICE, to: BOB, value: 5n } }), mem())).not.toBeNull();
  });
});

describe('v2_price_move', () => {
  const [r] = rules({ id: 'p', type: 'v2_price_move', addresses: [POOL], thresholdPercent: 5, pair: 'WETH/USDC', decimals0: 18, decimals1: 6 });
  const sync = (r0: bigint, r1: bigint) => ev({ address: POOL, name: 'Sync', args: { reserve0: r0, reserve1: r1 } });
  it('baselines on first Sync, ignores small moves, alerts on large ones and re-baselines', async () => {
    const st = mem();
    expect(evaluateRule(r!, await sync(1000n * E18, 2_000_000n * 10n ** 6n), st)).toBeNull(); // price 2000
    expect(evaluateRule(r!, await sync(1000n * E18, 2_080_000n * 10n ** 6n), st)).toBeNull(); // +4%
    const up = evaluateRule(r!, await sync(1000n * E18, 2_200_000n * 10n ** 6n), st);          // +10%
    expect(up?.fields.changePercent).toBe('10.00');
    expect(up?.title).toContain('up');
    expect(evaluateRule(r!, await sync(1000n * E18, 2_210_000n * 10n ** 6n), st)).toBeNull(); // relative to new baseline
    const down = evaluateRule(r!, await sync(1000n * E18, 1_900_000n * 10n ** 6n), st);        // -13.6%
    expect(down?.title).toContain('down');
  });
  it('ignores empty reserves', async () => {
    expect(evaluateRule(r!, await sync(0n, 0n), mem())).toBeNull();
  });
});

describe('v2_large_swap', () => {
  const [r] = rules({ id: 's', type: 'v2_large_swap', addresses: [POOL], minAmount: '10', token: 0 });
  it('uses the larger of in/out for the chosen token', async () => {
    const mk = (i: bigint, o: bigint) => ev({ address: POOL, name: 'Swap', args: { sender: ALICE, amount0In: i, amount1In: 0n, amount0Out: o, amount1Out: 0n, to: BOB } });
    expect(evaluateRule(r!, await mk(9n * E18, 0n), mem())).toBeNull();
    expect(evaluateRule(r!, await mk(0n, 11n * E18), mem())).not.toBeNull();
  });
});

describe('ownership / pause / liquidation', () => {
  it('ownership_transferred always fires for watched contracts', async () => {
    const [r] = rules({ id: 'o', type: 'ownership_transferred', addresses: [TOKEN], severity: 'critical' });
    const a = evaluateRule(r!, await ev({ address: TOKEN, name: 'OwnershipTransferred', args: { previousOwner: ALICE, newOwner: BOB } }), mem());
    expect(a?.severity).toBe('critical');
    expect(a?.fields.newOwner).toBe(BOB);
  });
  it('paused_state distinguishes Paused and Unpaused', async () => {
    const [r] = rules({ id: 'pz', type: 'paused_state', addresses: [TOKEN] });
    expect(evaluateRule(r!, await ev({ address: TOKEN, name: 'Paused', args: { account: ALICE } }), mem())?.fields.state).toBe('paused');
    expect(evaluateRule(r!, await ev({ address: TOKEN, name: 'Unpaused', args: { account: ALICE } }), mem())?.fields.state).toBe('unpaused');
  });
  it('aave_liquidation honours minDebtToCover', async () => {
    const [r] = rules({ id: 'l', type: 'aave_liquidation', addresses: [TOKEN], minDebtToCover: '500', debtDecimals: 6, debtSymbol: 'USDC' });
    const mk = (d: bigint) => ev({ address: TOKEN, name: 'LiquidationCall', args: { collateralAsset: addr(7), debtAsset: addr(8), user: ALICE, debtToCover: d, liquidatedCollateralAmount: 1n, liquidator: BOB, receiveAToken: true } });
    expect(evaluateRule(r!, await mk(499_999_999n), mem())).toBeNull();
    expect(evaluateRule(r!, await mk(500_000_000n), mem())?.message).toContain('500 USDC');
  });
  it('a rule never consumes the wrong event type', async () => {
    const [r] = rules({ id: 'o', type: 'ownership_transferred', addresses: [TOKEN] });
    expect(evaluateRule(r!, await ev({ address: TOKEN, name: 'Paused', args: { account: ALICE } }), mem())).toBeNull();
  });
});
