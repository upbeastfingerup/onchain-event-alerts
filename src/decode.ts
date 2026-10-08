import { decodeEventLog } from 'viem';
import { EVENT_ABI } from './abi.js';
import type { DecodedEvent, EventName, RawLog } from './types.js';

/**
 * Decode a raw log against the known event ABIs. Returns null for anything we do not
 * understand (unknown topic0, or e.g. an ERC-721 Transfer which shares topic0 with ERC-20
 * but has a different topic count) - unknown logs are skipped, never fatal.
 */
export function decodeLog(log: RawLog): DecodedEvent | null {
  if (log.topics.length === 0) return null;
  try {
    const d = decodeEventLog({
      abi: EVENT_ABI,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      strict: true,
    });
    return { name: d.eventName as EventName, args: (d.args ?? {}) as Record<string, unknown>, log };
  } catch {
    return null;
  }
}
