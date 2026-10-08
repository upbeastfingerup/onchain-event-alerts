export type Hex = `0x${string}`;

/** Raw log as returned by an RPC node (normalised). */
export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

/** Minimal chain surface the monitor needs. Implemented by viem and by the mock chain. */
export interface ChainClient {
  getBlockNumber(): Promise<number>;
  /** Returns null when the block does not exist (e.g. head moved backwards in a reorg). */
  getBlockHash(blockNumber: number): Promise<Hex | null>;
  getLogs(addresses: Hex[], fromBlock: number, toBlock: number): Promise<RawLog[]>;
}

export type EventName =
  | 'Transfer'
  | 'Swap'
  | 'Sync'
  | 'OwnershipTransferred'
  | 'Paused'
  | 'Unpaused'
  | 'LiquidationCall';

export interface DecodedEvent {
  name: EventName;
  args: Record<string, unknown>;
  log: RawLog;
}

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  ruleId: string;
  ruleType: string;
  severity: Severity;
  title: string;
  message: string;
  contract: Hex;
  txHash: Hex;
  blockNumber: number;
  logIndex: number;
  fields: Record<string, string>;
}

export interface Sink {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}
