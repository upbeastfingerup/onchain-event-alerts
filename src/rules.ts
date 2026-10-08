import { formatUnits } from 'viem';
import type { Rule } from './config.js';
import type { Alert, DecodedEvent, EventName } from './types.js';

/** Which decoded event names each rule type consumes. */
export const RULE_EVENTS: Record<Rule['type'], EventName[]> = {
  erc20_transfer: ['Transfer'],
  v2_price_move: ['Sync'],
  v2_large_swap: ['Swap'],
  ownership_transferred: ['OwnershipTransferred'],
  paused_state: ['Paused', 'Unpaused'],
  aave_liquidation: ['LiquidationCall'],
};

export interface RuleState {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const short = (a: unknown) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const eq = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();

/** Parse a human decimal ("1000000.5") into base units for exact bigint comparison. */
export function toUnits(amount: string, decimals: number): bigint {
  const [w = '0', f = ''] = amount.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

const fmt = (v: bigint, d: number) => {
  const s = formatUnits(v, d);
  const [w = '0', f] = s.split('.');
  return (f ? `${w}.${f.slice(0, 4)}` : w).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

function base(rule: Rule, ev: DecodedEvent) {
  return {
    ruleId: rule.id, ruleType: rule.type, severity: rule.severity,
    contract: ev.log.address, txHash: ev.log.transactionHash,
    blockNumber: ev.log.blockNumber, logIndex: ev.log.logIndex,
  };
}

/** Pure(ish) rule evaluation: returns an Alert when the event satisfies the rule. */
export function evaluateRule(rule: Rule, ev: DecodedEvent, state: RuleState): Alert | null {
  if (!rule.addresses.some((a) => eq(a, ev.log.address))) return null;
  if (!RULE_EVENTS[rule.type].includes(ev.name)) return null;
  const a = ev.args;

  switch (rule.type) {
    case 'erc20_transfer': {
      const value = a.value as bigint;
      if (value < toUnits(rule.minAmount, rule.decimals)) return null;
      if (rule.from && !eq(a.from, rule.from)) return null;
      if (rule.to && !eq(a.to, rule.to)) return null;
      const amt = fmt(value, rule.decimals);
      return {
        ...base(rule, ev),
        title: `Large ${rule.symbol} transfer`,
        message: `${amt} ${rule.symbol} moved from ${short(a.from)} to ${short(a.to)}`,
        fields: { amount: amt, symbol: rule.symbol, from: String(a.from), to: String(a.to) },
      };
    }
    case 'v2_large_swap': {
      const [inn, out] = rule.token === 0 ? [a.amount0In, a.amount0Out] : [a.amount1In, a.amount1Out];
      const size = (inn as bigint) > (out as bigint) ? (inn as bigint) : (out as bigint);
      if (size < toUnits(rule.minAmount, rule.decimals)) return null;
      const amt = fmt(size, rule.decimals);
      return {
        ...base(rule, ev),
        title: `Large swap on ${rule.pair}`,
        message: `Swap of ${amt} (token${rule.token}) on ${rule.pair} by ${short(a.sender)}`,
        fields: { amount: amt, pair: rule.pair, sender: String(a.sender), to: String(a.to) },
      };
    }
    case 'v2_price_move': {
      const r0 = a.reserve0 as bigint;
      const r1 = a.reserve1 as bigint;
      if (r0 === 0n || r1 === 0n) return null;
      // price of token0 in token1, decimal-adjusted, via scaled integer math (1e12 precision)
      const SCALE = 10n ** 12n;
      const scaled = (r1 * 10n ** BigInt(rule.decimals0) * SCALE) / (r0 * 10n ** BigInt(rule.decimals1));
      const price = Number(scaled) / 1e12;
      const key = `price:${rule.id}:${ev.log.address.toLowerCase()}`;
      const prevRaw = state.get(key);
      if (prevRaw === undefined) { state.set(key, String(price)); return null; } // first observation = baseline
      const prev = Number(prevRaw);
      if (prev === 0) { state.set(key, String(price)); return null; }
      const pct = ((price - prev) / prev) * 100;
      if (Math.abs(pct) < rule.thresholdPercent) return null;
      state.set(key, String(price)); // re-baseline at the alerting price
      return {
        ...base(rule, ev),
        title: `${rule.pair} price ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(2)}%`,
        message: `${rule.pair} moved from ${prev.toPrecision(6)} to ${price.toPrecision(6)} (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`,
        fields: { pair: rule.pair, previousPrice: prev.toPrecision(6), price: price.toPrecision(6), changePercent: pct.toFixed(2) },
      };
    }
    case 'ownership_transferred':
      return {
        ...base(rule, ev),
        title: 'Ownership transferred',
        message: `Owner changed from ${short(a.previousOwner)} to ${short(a.newOwner)}`,
        fields: { previousOwner: String(a.previousOwner), newOwner: String(a.newOwner) },
      };
    case 'paused_state': {
      const paused = ev.name === 'Paused';
      return {
        ...base(rule, ev),
        title: paused ? 'Contract PAUSED' : 'Contract unpaused',
        message: `${paused ? 'Paused' : 'Unpaused'} by ${short(a.account)}`,
        fields: { state: paused ? 'paused' : 'unpaused', account: String(a.account) },
      };
    }
    case 'aave_liquidation': {
      const debt = a.debtToCover as bigint;
      if (debt < toUnits(rule.minDebtToCover, rule.debtDecimals)) return null;
      const amt = fmt(debt, rule.debtDecimals);
      return {
        ...base(rule, ev),
        title: 'Liquidation',
        message: `${short(a.user)} liquidated by ${short(a.liquidator)}, debt covered ${amt} ${rule.debtSymbol}`,
        fields: { user: String(a.user), liquidator: String(a.liquidator), debtCovered: amt, collateralAsset: String(a.collateralAsset), debtAsset: String(a.debtAsset) },
      };
    }
  }
}
