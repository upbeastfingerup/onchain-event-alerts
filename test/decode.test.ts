import { describe, expect, it } from 'vitest';
import { decodeLog } from '../src/decode.js';
import { MockChain, addr } from '../src/testing/mockChain.js';
import { ALICE, BOB, POOL, TOKEN } from './helpers.js';

async function logOf(ev: Parameters<MockChain['mine']>[0]) {
  const c = new MockChain(0);
  c.mine(ev);
  return (await c.getLogs([ev.address], 1, 1))[0]!;
}

describe('decodeLog', () => {
  it('decodes ERC-20 Transfer', async () => {
    const d = decodeLog(await logOf({ address: TOKEN, name: 'Transfer', args: { from: ALICE, to: BOB, value: 5n * 10n ** 18n } }));
    expect(d?.name).toBe('Transfer');
    expect(d?.args.value).toBe(5n * 10n ** 18n);
    expect((d?.args.from as string).toLowerCase()).toBe(ALICE);
  });
  it('decodes V2 Sync and Swap', async () => {
    const sync = decodeLog(await logOf({ address: POOL, name: 'Sync', args: { reserve0: 100n, reserve1: 200n } }));
    expect(sync?.args).toMatchObject({ reserve0: 100n, reserve1: 200n });
    const swap = decodeLog(await logOf({ address: POOL, name: 'Swap', args: { sender: ALICE, amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 9n, to: BOB } }));
    expect(swap?.args).toMatchObject({ amount0In: 1n, amount1Out: 9n });
  });
  it('decodes OwnershipTransferred, Paused, Unpaused', async () => {
    expect(decodeLog(await logOf({ address: TOKEN, name: 'OwnershipTransferred', args: { previousOwner: ALICE, newOwner: BOB } }))?.name).toBe('OwnershipTransferred');
    expect(decodeLog(await logOf({ address: TOKEN, name: 'Paused', args: { account: ALICE } }))?.name).toBe('Paused');
    expect(decodeLog(await logOf({ address: TOKEN, name: 'Unpaused', args: { account: ALICE } }))?.name).toBe('Unpaused');
  });
  it('decodes Aave LiquidationCall', async () => {
    const d = decodeLog(await logOf({ address: TOKEN, name: 'LiquidationCall', args: { collateralAsset: addr(7), debtAsset: addr(8), user: ALICE, debtToCover: 42n, liquidatedCollateralAmount: 50n, liquidator: BOB, receiveAToken: false } }));
    expect(d?.name).toBe('LiquidationCall');
    expect(d?.args).toMatchObject({ debtToCover: 42n, receiveAToken: false });
  });
  it('returns null for unknown topics and ERC-721-shaped Transfers', async () => {
    const base = await logOf({ address: TOKEN, name: 'Transfer', args: { from: ALICE, to: BOB, value: 1n } });
    expect(decodeLog({ ...base, topics: [] })).toBeNull();
    expect(decodeLog({ ...base, topics: [('0x' + '11'.repeat(32)) as `0x${string}`] })).toBeNull();
    // ERC-721: 4 topics (tokenId indexed), empty data
    const erc721 = { ...base, topics: [...base.topics, ('0x' + '00'.repeat(31) + '01') as `0x${string}`], data: '0x' as const };
    expect(decodeLog(erc721)).toBeNull();
  });
});
