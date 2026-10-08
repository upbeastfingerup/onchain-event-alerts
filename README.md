# onchain-event-alerts

> **Personal portfolio demo.** This is not client work and has no real users, deployments, or production metrics. It is a self-contained example of how I would build an on-chain monitoring and alerting service. All addresses in the examples are public or placeholder values; no secrets are included.

A small TypeScript service that watches EVM contract events by polling `eth_getLogs`, evaluates declarative rules, and sends alerts to Telegram, Discord, or any webhook.

## What it does

- **Events decoded** (via viem): ERC-20 `Transfer`, Uniswap-V2-style `Swap` / `Sync`, `OwnershipTransferred`, `Paused` / `Unpaused`, Aave-style `LiquidationCall`.
- **Rules** in YAML or JSON, validated with zod: thresholds, address lists, optional from/to filters, per-rule cooldown, severity, per-rule sink routing.
- **Reorg safety**: only blocks `confirmations` deep are processed; the cursor stores recent block hashes and rewinds if the chain disagrees with what was processed.
- **Persistence**: JSON state file (cursor, dedup keys, cooldowns, price baselines) written atomically (temp file + rename). A restart resumes exactly where it stopped.
- **Dedup + cooldown**: the same `rule:txHash:logIndex` never alerts twice; an optional cooldown (per rule or per rule+contract) prevents floods.
- **Sinks** behind a small interface, each wrapped with rate limiting and retry (exponential backoff with jitter, honours `Retry-After` on 429, no retry for other 4xx).

## Architecture

```
            +-------------+  getBlockNumber / getBlockHash / getLogs
 EVM RPC -->| ChainClient |-----------------------------------------+
            +-------------+                                         |
                  (viem in prod, MockChain in tests/demo)           v
                                                              +-----------+
 config.yaml --zod--> rules --------------------------------> |  Monitor  |
                                                              |  .tick()  |
   +----------- cursor + block hashes, seen keys, cooldowns   +-----+-----+
   |            (FileStore / MemoryStore)                           |
   v                                                                v
+-------+   reorg check -> chunked getLogs -> decodeLog -> evaluateRule(rule, event)
| State |                                                            |
+-------+                                           Alert            v
   ^                                   +--------- AlertGate --------+
   |  dedup (tx:logIndex), cooldown    |
   +-----------------------------------+
                                       v
                                SinkDispatcher --> ReliableSink(rate limit + retry) --> Telegram
                                  (fan-out, one                                    \--> Discord
                                   failure never                                    \-> Webhook (HMAC-signed)
                                   blocks others)
```

Source layout:

| File | Responsibility |
|---|---|
| `src/monitor.ts` | poll loop, confirmation depth, chunking, reorg detection and rewind |
| `src/rules.ts` | pure rule evaluation (event -> alert or null) |
| `src/gate.ts` | dedup and cooldown decisions |
| `src/decode.ts`, `src/abi.ts` | log decoding |
| `src/store.ts` | cursor/state persistence |
| `src/config.ts` | zod schema, YAML/JSON loading |
| `src/sinks/*` | sink interface implementations, retry/rate-limit wrapper, factory |
| `src/testing/mockChain.ts` | in-memory chain with real ABI encoding and `reorg()` |

### Reorg model

1. A block is processed only when `head - confirmations >= block`. A reorg shallower than that depth never produces an alert (demo step 5).
2. After each scanned chunk the block hash at the chunk end is stored (last `reorgWindow` hashes kept). On every tick the stored hashes are re-checked against the node, newest first. The cursor rewinds to the newest block whose hash still matches, and a missing block counts as a mismatch.
3. When hashes are sparse (a tick scanned many blocks at once) and none match, the rewind is conservative: at most one `maxBlockRange` before the oldest remembered hash, never before the origin.
4. Re-scanned logs that survive in the new chain have the same `txHash:logIndex` and are suppressed by dedup.

**Known limitation (by design):** if a reorg is deeper than `confirmations`, an alert already sent for an orphaned log cannot be recalled. The new chain's logs are alerted, but the earlier message stays sent (demo step 6 shows this). Choose `confirmations` for your chain's finality profile.

Delivery is best effort: a sink that still fails after all retries is logged and the alert is not re-queued (no outbox). A durable outbox would be the natural next step.

## Rule examples

Full file: [`examples/rules.example.yaml`](examples/rules.example.yaml). Check it with `npm run validate`.

```yaml
rules:
  - id: usdc-whales
    type: erc20_transfer
    addresses: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"]
    minAmount: 1000000        # human units, compared exactly as bigint
    decimals: 6
    symbol: USDC
    cooldownSeconds: 30
    cooldownScope: contract   # or "rule"
    sinks: [ops-discord]      # omit = all sinks

  - id: pool-price
    type: v2_price_move       # on Sync: alert when price moved >= 3% since last alert/baseline
    addresses: ["0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc"]
    thresholdPercent: 3
    decimals0: 6
    decimals1: 18

  - { id: owner, type: ownership_transferred, addresses: ["0x..."], severity: critical }
  - { id: pause, type: paused_state,          addresses: ["0x..."], severity: critical }
  - { id: liq,   type: aave_liquidation,      addresses: ["0x..."], minDebtToCover: 50000, debtDecimals: 6 }
```

Rule types: `erc20_transfer`, `v2_price_move`, `v2_large_swap`, `ownership_transferred`, `paused_state`, `aave_liquidation`.

Sinks never contain secrets in the file; they name environment variables (`botTokenEnv`, `webhookUrlEnv`, `urlEnv`, `secretEnv`). The generic webhook POSTs `{version, alert}` and, if a secret is set, adds `x-signature-sha256` (HMAC of the exact body).

## Run it

Requires Node 22+ (developed on Node 24).

```bash
npm install
npm test            # vitest, fully offline
npm run typecheck
npm run demo        # scripted scenario on an in-memory chain (no network, no secrets)
npm run validate    # validate examples/rules.example.yaml
```

Against a real chain:

```bash
cp examples/rules.example.yaml config.yaml    # edit addresses / sinks
cp .env.example .env                          # fill RPC_URL and sink secrets
export $(grep -v '^#' .env | xargs)
npm run build && npm start
```

Docker:

```bash
cp examples/rules.example.yaml config.yaml   # set statePath: /data/state.json
cp .env.example .env
docker compose up --build
```

## Extending

**Add a sink.** Implement `Sink` (`name`, `send(alert)`), use `postJson` from `src/sinks/http.ts` so errors map to retry behaviour, add a variant to `SinkSchema` in `src/config.ts`, and a branch in `buildSinks` (`src/sinks/factory.ts`). Rate limiting and retry come from `ReliableSink` automatically.

**Add a rule.** (1) add the event to `src/abi.ts` and `EventName`; (2) add a zod variant to `RuleSchema`; (3) map it in `RULE_EVENTS` and add a `case` in `evaluateRule` (`src/rules.ts`); (4) add tests, using `MockChain.mine({ name, args })` to produce real encoded logs.

## Tests

`npm test` runs vitest with no network and no secrets. Coverage: log decoding, rule evaluation for every rule type, dedup and cooldown, cursor persistence and restart, chunking, confirmation depth, reorg handling (including head moving backwards and sparse hashes), sink retry/backoff/rate-limit with a mocked `fetch`, payload shapes, and config validation.

## Not verified / not included

- Not run against a live RPC node or live Telegram/Discord endpoints (HTTP is covered with mocked `fetch`; payload shapes follow the public API docs).
- No anvil-based demo; the demo and tests use the in-memory `MockChain`.
- State is a single JSON file (single process only; no locking). SQLite would suit larger dedup sets.
- `v2_price_move` uses reserve ratio (spot price), which is manipulable within a block; it is a monitoring signal, not an oracle.
