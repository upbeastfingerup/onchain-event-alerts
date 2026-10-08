import { createPublicClient, http } from 'viem';
import type { ChainClient, Hex, RawLog } from './types.js';

export function createViemChain(rpcUrl: string): ChainClient {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 3 }) });
  return {
    async getBlockNumber() { return Number(await client.getBlockNumber()); },
    async getBlockHash(n) {
      try { return (await client.getBlock({ blockNumber: BigInt(n) })).hash as Hex; } catch { return null; }
    },
    async getLogs(addresses, fromBlock, toBlock) {
      const logs = await client.getLogs({ address: addresses, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) });
      return logs.filter((l) => l.blockHash && l.transactionHash && l.logIndex !== null).map((l): RawLog => ({
        address: l.address, topics: l.topics as Hex[], data: l.data,
        blockNumber: Number(l.blockNumber), blockHash: l.blockHash!, transactionHash: l.transactionHash!, logIndex: l.logIndex!,
      }));
    },
  };
}
