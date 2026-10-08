import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, pad } from 'viem';
import { EVENT_ABI } from '../abi.js';
import type { ChainClient, EventName, Hex, RawLog } from '../types.js';

interface MockBlock { hash: Hex; logs: Omit<RawLog, 'blockNumber' | 'blockHash'>[] }

/** Deterministic in-memory chain with reorg support. Used by tests and the demo. */
export class MockChain implements ChainClient {
  blocks: MockBlock[] = [];
  private nonce = 0;
  getLogsCalls: Array<[number, number]> = [];

  constructor(initialHeight = 0) { for (let i = 0; i <= initialHeight; i++) this.mine(); }

  get head() { return this.blocks.length - 1; }
  private freshHash(): Hex { return keccak256(toHex(`block-${this.nonce++}`)); }

  /** Mine a block containing the given logs (event name + args are ABI-encoded for real). */
  mine(...events: Array<{ address: Hex; name: EventName; args: Record<string, unknown>; tx?: Hex }>): number {
    const logs = events.map((e, i) => {
      const item = EVENT_ABI.find((x) => x.type === 'event' && x.name === e.name)!;
      const topics = encodeEventTopics({ abi: EVENT_ABI, eventName: e.name as never, args: e.args as never }) as Hex[];
      const nonIndexed = item.inputs.filter((x) => !('indexed' in x && x.indexed));
      const data = nonIndexed.length ? encodeAbiParameters(nonIndexed, nonIndexed.map((x) => e.args[x.name!] as never)) : '0x';
      return { address: e.address, topics, data: data as Hex, transactionHash: e.tx ?? keccak256(toHex(`tx-${this.nonce++}`)), logIndex: i };
    });
    this.blocks.push({ hash: this.freshHash(), logs });
    return this.head;
  }

  /** Drop every block with number >= fromBlock (new hashes follow when mined again). */
  reorg(fromBlock: number) { this.blocks.length = fromBlock; }

  async getBlockNumber() { return this.head; }
  async getBlockHash(n: number) { return this.blocks[n]?.hash ?? null; }
  async getLogs(addresses: Hex[], from: number, to: number): Promise<RawLog[]> {
    this.getLogsCalls.push([from, to]);
    const set = new Set(addresses.map((a) => a.toLowerCase()));
    const out: RawLog[] = [];
    for (let n = from; n <= Math.min(to, this.head); n++) {
      for (const l of this.blocks[n]!.logs) if (set.has(l.address.toLowerCase())) out.push({ ...l, blockNumber: n, blockHash: this.blocks[n]!.hash });
    }
    return out;
  }
}

export const addr = (n: number): Hex => pad(toHex(n), { size: 20 });
