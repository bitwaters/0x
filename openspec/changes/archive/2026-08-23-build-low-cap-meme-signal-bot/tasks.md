## 1. Minimal Service Setup

- [x] 1.1 Initialize one Node.js/TypeScript service with lint, typecheck, test, build and start scripts.
- [x] 1.2 Add validated environment/config loading for both chains, three Telegram channel roles, thresholds and feature switches without logging secrets.
- [x] 1.3 Verify `.env.local` remains ignored with `600` permissions and add startup redaction tests.

## 2. SQLite State and Idempotency

- [x] 2.1 Create SQLite WAL migrations for rule versions, candidates, rank snapshots, pool bindings, qualification events, message outbox and evaluation points.
- [x] 2.2 Implement chain-aware SOL/BSC address normalization and permanent `chain + CA` candidate uniqueness.
- [x] 2.3 Implement immutable first-seen baselines, finite-positive GMGN sampled high-water, discovery/decision rule versions and structured raw/normalized decision evidence.
- [x] 2.4 Implement `PENDING/SENDING/SENT/UNCERTAIN` outbox persistence and restart tests, including timeout and crash-after-send uncertainty.

## 3. GMGN and CoinGecko Contracts

- [x] 3.1 Implement a bounded, rate-limited GMGN adapter for trending, token info and token security with timeout, retry, backoff and redacted errors.
- [x] 3.2 Implement the exact per-chain GMGN security matrix, strict type/range conversion, TTL checks and fail-closed contract errors.
- [x] 3.3 Implement CoinGecko network-scoped fixed-pool detail/trades/OHLCV REST calls, composition field mapping and exact normalized pool/token validation.
- [x] 3.4 Implement one G2 Trade socket per chain, per-pool dirty coalescing/1-second minimum refresh, a shared 450-RPM REST token bucket, reconnect and subscription release.
- [x] 3.5 Add sanitized contract fixtures for actual field types, base/quote candidate-directed REST trades, stale timestamps, missing composition, rate-budget exhaustion, 429/5xx and reconnects.
- [x] 3.6 Add a boundary test proving no market/security source other than GMGN and CoinGecko enters a decision and that G1/G3 are not used.

## 4. Candidate Discovery

- [x] 4.1 Implement staggered SOL/BSC polling for 1m every 3 seconds and 5m every 10 seconds with non-overlapping requests.
- [x] 4.2 Implement snapshot TTL/time-difference rules and three-rising-rank continuity/reset behavior.
- [x] 4.3 Implement configurable defaults for `$20k–$500k` GMGN market cap, real-pool liquidity≥`$10k` and pool age≤6 hours.
- [x] 4.4 Implement Bonding Curve radar/preheat, real-pool promotion, 120-second qualification window and permanent terminal states.
- [x] 4.5 Implement GMGN same-source sampled maximum gain with permanent rejection after high-water exceeds 80%.
- [x] 4.6 Add tests for partial Top100, failed/stale snapshots, EVM case normalization, duplicate CA, high-water pullback and no terminal-state reopening.

## 5. Fixed-Pool Qualification

- [x] 5.1 Bind GMGN biggest pool to CoinGecko and persist `candidate_side=base|quote` plus counter token; reject network/address/composition mismatch.
- [x] 5.2 Request REST trades with `token={candidate_side}`, use candidate-directed kind without second inversion, match candidate address to the correct USD price field and reject invalid values; keep G2 trigger-only.
- [x] 5.3 Build the 30-second REST-trades fact window, provider-event deduplication and G2-triggered refresh; require 5–10 trades and latest block timestamp≤15 seconds.
- [x] 5.4 Apply buy count≥60%, positive net buy USD and largest trade≤40% rules using normalized candidate direction.
- [x] 5.5 Apply two successful detail requests with local fetch times at least 10 seconds apart using `reserve_in_usd`, side-specific composition fields, liquidity≥`$10k`, decline≤10% and `$100` counter-side depth ratio≤3%.
- [x] 5.6 Re-fetch GMGN data to meet 15/30-second final TTLs and re-run every hard gate immediately before send eligibility.
- [x] 5.7 Add table-driven tests for every security boundary, quote-side candidate orientation without second inversion, stale/missing trades, fast liquidity loss, proxy calculation, main-pool changes and 120-second expiry.

## 6. Telegram Delivery

- [x] 6.1 Implement direct Telegram send/edit transport for radar, private validation and public formal channels with redacted errors.
- [x] 6.2 Implement radar and validation/formal messages containing only verifiable snapshots, request time and the clearly labelled `$100` depth proxy; persist receipt time separately.
- [x] 6.3 Implement the final same-pool REST price check; suppress first send when absolute drift exceeds 8%.
- [x] 6.4 Implement 90-second post-send edits plus 30/60-second security and pool-detail rechecks; retry a failed recheck once after 3 seconds, then invalidate as data-unconfirmed.
- [x] 6.5 Add delivery tests for private/public routing, explicit send failure retry, unknown-result no-retry, duplicate suppression, recheck timeout/malformed/recovery and edit failure recovery.

## 7. Evaluation and Chain Release

- [x] 7.1 Record only Telegram-confirmed validation/formal samples, with receipt time, pre-send price and 10-second `$100` simulated entry.
- [x] 7.2 Implement required time points and 10-second-entry-based metrics using the 90-second REST-trades path and later fixed-pool REST OHLCV, including `AMBIGUOUS` threshold ordering.
- [x] 7.3 Classify pool disappearance/liquidity zero as terminal negative and provider outages as visible `provider_missing`; report total count and coverage.
- [x] 7.4 Record `sell_trade_observed` and gross price/tax/liquidity facts without claiming executable sale or net profit.
- [x] 7.5 Implement independent `VALIDATING/BETA/SUSPENDED` state, transactional validation epoch/sequence, 20 ordered 15-minute-matured current-epoch samples, critical-error epoch reset and latest-rule requalification limited to nonterminal unsent candidates.
- [x] 7.6 Implement chain/version/stage-segmented reports at 50/100/200 and subsequent +100, plus one-parameter-family review snapshots every +20.
- [x] 7.7 Add tests for no day gate, out-of-order and prior-epoch late completion, restart-safe sequencing, independent chains, post-Beta suspension, terminal non-reopening, missing-data denominators and no profitability claim at 20.

## 8. End-to-End Verification

- [x] 8.1 Run lint, typecheck, unit, integration and build checks with Telegram disabled.
- [x] 8.2 Run a redacted live smoke test for `GMGN trending → security/info → biggest pool → CoinGecko pool side/trades` on both chains.
- [x] 8.3 Run preview dry-run through discovery, radar, qualification and message rendering; verify every decision is reproducible after restart.
- [x] 8.4 Send controlled messages to a private validation channel and verify acknowledgement, drift rejection, expiry edit, uncertain-send handling and subscription release.
- [x] 8.5 Start per-chain validation accumulation and expose progress toward 20/50/100/200 without waiting for a fixed number of days.
