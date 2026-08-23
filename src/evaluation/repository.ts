import type { Chain } from '../config.js';
import type { SqliteDatabase } from '../db/database.js';
import { normalizeAddress } from '../domain/address.js';
import { stableJsonStringify } from '../domain/json.js';
import type { DeliveredSignalSnapshot } from '../telegram/messages.js';
import { EVALUATION_POLICY, type EvaluationHorizon } from './policy.js';
import type { PathMetrics } from './rules.js';

export type ChainReleaseStatus = 'VALIDATING' | 'BETA' | 'SUSPENDED';
export type EvaluationStatus =
  | 'PENDING'
  | 'COMPLETE'
  | 'PROVIDER_MISSING'
  | 'TERMINAL_NEGATIVE'
  | 'ENTRY_UNAVAILABLE'
  | 'AMBIGUOUS';

export interface ChainReleaseRecord {
  readonly chain: Chain;
  readonly state: ChainReleaseStatus;
  readonly validationEpoch: number;
  readonly nextValidationSeq: number;
  readonly suspensionReason: string | null;
}

export interface ValidationProgress {
  readonly chain: Chain;
  readonly state: ChainReleaseStatus;
  readonly validationEpoch: number;
  readonly validationDelivered: number;
  readonly validationMatured15m: number;
  readonly betaRequiredMatured15m: number;
  readonly totalDelivered: number;
  readonly remainingTo: Readonly<Record<'beta' | 'nextReport', number>>;
}

export interface DeliveredSignalSample {
  readonly id: number;
  readonly outboxId: number;
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly deliveryStage: 'validation' | 'formal';
  readonly receiptAtMs: number;
  readonly preSendPriceUsd: number;
  readonly preSendTradeAtMs: number;
  readonly entryStatus: Exclude<EvaluationStatus, 'AMBIGUOUS'>;
  readonly entryPriceUsd: number | null;
  readonly entryTradeAtMs: number | null;
  readonly discoveryRuleVersion: string;
  readonly decisionRuleVersion: string;
  readonly validationEpoch: number | null;
  readonly validationSeq: number | null;
  readonly sellTradeObserved: boolean;
  readonly firstSellTradeAtMs: number | null;
  readonly snapshot: DeliveredSignalSnapshot;
}

export interface EvaluationPointRecord {
  readonly id: number;
  readonly sampleId: number;
  readonly horizonSeconds: EvaluationHorizon;
  readonly scheduledAtMs: number;
  readonly nextAttemptAtMs: number;
  readonly status: EvaluationStatus;
  readonly retryCount: number;
  readonly entryPolicyVersion: string | null;
  readonly entryTradeMaxDelayMs: number | null;
}

export interface StoredPathResult extends PathMetrics {
  readonly status: Extract<EvaluationStatus, 'COMPLETE' | 'AMBIGUOUS'>;
}

interface SampleRow {
  id: number;
  outbox_id: number;
  chain: Chain;
  token_address: string;
  delivery_stage: 'validation' | 'formal';
  receipt_at_ms: number;
  pre_send_price_usd: number;
  pre_send_trade_at_ms: number;
  entry_status: Exclude<EvaluationStatus, 'AMBIGUOUS'>;
  entry_price_usd: number | null;
  entry_trade_at_ms: number | null;
  discovery_rule_version: string;
  decision_rule_version: string;
  validation_epoch: number | null;
  validation_seq: number | null;
  sell_trade_observed: number;
  first_sell_trade_at_ms: number | null;
  snapshot_json: string;
}

interface PointRow {
  id: number;
  sample_id: number;
  horizon_seconds: EvaluationHorizon;
  scheduled_at_ms: number;
  next_attempt_at_ms: number;
  status: EvaluationStatus;
  retry_count: number;
  details_json: string;
}

function toSample(row: SampleRow): DeliveredSignalSample {
  return {
    id: row.id,
    outboxId: row.outbox_id,
    chain: row.chain,
    tokenAddress: row.token_address,
    deliveryStage: row.delivery_stage,
    receiptAtMs: row.receipt_at_ms,
    preSendPriceUsd: row.pre_send_price_usd,
    preSendTradeAtMs: row.pre_send_trade_at_ms,
    entryStatus: row.entry_status,
    entryPriceUsd: row.entry_price_usd,
    entryTradeAtMs: row.entry_trade_at_ms,
    discoveryRuleVersion: row.discovery_rule_version,
    decisionRuleVersion: row.decision_rule_version,
    validationEpoch: row.validation_epoch,
    validationSeq: row.validation_seq,
    sellTradeObserved: row.sell_trade_observed === 1,
    firstSellTradeAtMs: row.first_sell_trade_at_ms,
    snapshot: JSON.parse(row.snapshot_json) as DeliveredSignalSnapshot
  };
}

function toPoint(row: PointRow): EvaluationPointRecord {
  const details = JSON.parse(row.details_json) as Record<string, unknown>;
  return {
    id: row.id,
    sampleId: row.sample_id,
    horizonSeconds: row.horizon_seconds,
    scheduledAtMs: row.scheduled_at_ms,
    nextAttemptAtMs: row.next_attempt_at_ms,
    status: row.status,
    retryCount: row.retry_count,
    entryPolicyVersion:
      typeof details.entryPolicyVersion === 'string'
        ? details.entryPolicyVersion
        : null,
    entryTradeMaxDelayMs:
      typeof details.entryTradeMaxDelayMs === 'number' &&
      Number.isFinite(details.entryTradeMaxDelayMs) &&
      details.entryTradeMaxDelayMs >= 0
        ? details.entryTradeMaxDelayMs
        : null
  };
}

export class EvaluationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  chainState(chain: Chain): ChainReleaseRecord {
    const row = this.database
      .prepare('SELECT * FROM chain_release_state WHERE chain = ?')
      .get(chain) as {
        chain: Chain;
        state: ChainReleaseStatus;
        validation_epoch: number;
        next_validation_seq: number;
        suspension_reason: string | null;
      };
    return {
      chain: row.chain,
      state: row.state,
      validationEpoch: row.validation_epoch,
      nextValidationSeq: row.next_validation_seq,
      suspensionReason: row.suspension_reason
    };
  }

  progress(chain: Chain, nowMs: number): ValidationProgress {
    const state = this.chainState(chain);
    const validationDelivered = (this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM delivered_signal_samples
        WHERE chain = ? AND delivery_stage = 'validation' AND validation_epoch = ?
      `)
      .get(chain, state.validationEpoch) as { count: number }).count;
    const validationMatured15m = this.matureEvaluationCount(
      chain,
      state.validationEpoch,
      nowMs
    );
    const totalDelivered = (this.database
      .prepare('SELECT COUNT(*) AS count FROM delivered_signal_samples WHERE chain = ?')
      .get(chain) as { count: number }).count;
    const nextReport = validationMatured15m < EVALUATION_POLICY.reportFirstCount
      ? EVALUATION_POLICY.reportFirstCount
      : EVALUATION_POLICY.reportFirstCount +
        (Math.floor((validationMatured15m - EVALUATION_POLICY.reportFirstCount) /
          EVALUATION_POLICY.reportStep) + 1) * EVALUATION_POLICY.reportStep;
    return {
      chain,
      state: state.state,
      validationEpoch: state.validationEpoch,
      validationDelivered,
      validationMatured15m,
      betaRequiredMatured15m: EVALUATION_POLICY.betaMatureSamples,
      totalDelivered,
      remainingTo: {
        beta: Math.max(0, EVALUATION_POLICY.betaMatureSamples - validationMatured15m),
        nextReport: Math.max(0, nextReport - validationMatured15m)
      }
    };
  }

  recordDelivered(input: {
    readonly outboxId: number;
    readonly snapshot: DeliveredSignalSnapshot;
    readonly receiptAtMs: number;
  }): DeliveredSignalSample {
    const { eligibility } = input.snapshot;
    const chainState = this.chainState(eligibility.chain);
    const stage = input.snapshot.channelRole;
    const confirmedOutbox = this.database
      .prepare(`
        SELECT status, receipt_at_ms FROM message_outbox
        WHERE id = ? AND chain = ? AND token_address = ?
          AND message_kind = 'signal' AND channel_role = ?
      `)
      .get(
        input.outboxId,
        eligibility.chain,
        normalizeAddress(eligibility.chain, eligibility.tokenAddress),
        stage
      ) as { status: string; receipt_at_ms: number | null } | undefined;
    if (
      confirmedOutbox?.status !== 'SENT' ||
      confirmedOutbox.receipt_at_ms !== input.receiptAtMs
    ) {
      throw new Error('delivered sample requires a matching Telegram SENT receipt');
    }
    const candidate = this.database
      .prepare(`
        SELECT discovery_rule_version FROM candidates
        WHERE chain = ? AND token_address = ?
      `)
      .get(eligibility.chain, normalizeAddress(eligibility.chain, eligibility.tokenAddress)) as
      | { discovery_rule_version: string }
      | undefined;
    if (candidate === undefined) throw new Error('candidate not found for delivered sample');
    const validationEpoch = stage === 'validation' ? chainState.validationEpoch : null;
    const validationSeq = stage === 'validation' ? chainState.nextValidationSeq : null;
    const result = this.database
      .prepare(`
        INSERT INTO delivered_signal_samples(
          outbox_id, chain, token_address, delivery_stage, receipt_at_ms,
          pre_send_price_usd, pre_send_trade_at_ms, entry_status,
          discovery_rule_version, decision_rule_version,
          validation_epoch, validation_seq, snapshot_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.outboxId,
        eligibility.chain,
        normalizeAddress(eligibility.chain, eligibility.tokenAddress),
        stage,
        input.receiptAtMs,
        input.snapshot.preSendPriceUsd,
        input.snapshot.preSendTradeAtMs,
        candidate.discovery_rule_version,
        eligibility.ruleVersion,
        validationEpoch,
        validationSeq,
        stableJsonStringify(input.snapshot),
        input.receiptAtMs,
        input.receiptAtMs
      );
    const sampleId = Number(result.lastInsertRowid);
    for (const horizonSeconds of EVALUATION_POLICY.horizonsSeconds) {
      const scheduledAtMs = input.receiptAtMs + horizonSeconds * 1_000;
      const nextAttemptAtMs =
        horizonSeconds === 10
          ? scheduledAtMs
          : scheduledAtMs;
      const details =
        horizonSeconds === 10
          ? stableJsonStringify({
              entryPolicyVersion: EVALUATION_POLICY.entryPolicyVersion,
              entryTradeMaxDelayMs: EVALUATION_POLICY.entryTradeMaxDelayMs
            })
          : '{}';
      this.database
        .prepare(`
          INSERT INTO signal_evaluation_points(
            sample_id, horizon_seconds, scheduled_at_ms, next_attempt_at_ms,
            status, details_json, updated_at_ms
          ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?)
        `)
        .run(
          sampleId,
          horizonSeconds,
          scheduledAtMs,
          nextAttemptAtMs,
          details,
          input.receiptAtMs
        );
    }
    if (stage === 'validation') {
      this.database
        .prepare(`
          UPDATE chain_release_state
          SET next_validation_seq = next_validation_seq + 1, updated_at_ms = ?
          WHERE chain = ?
        `)
        .run(input.receiptAtMs, eligibility.chain);
    }
    return this.findSample(sampleId)!;
  }

  findSample(id: number): DeliveredSignalSample | undefined {
    const row = this.database
      .prepare('SELECT * FROM delivered_signal_samples WHERE id = ?')
      .get(id) as SampleRow | undefined;
    return row === undefined ? undefined : toSample(row);
  }

  findSampleByOutbox(outboxId: number): DeliveredSignalSample | undefined {
    const row = this.database
      .prepare('SELECT * FROM delivered_signal_samples WHERE outbox_id = ?')
      .get(outboxId) as SampleRow | undefined;
    return row === undefined ? undefined : toSample(row);
  }

  listDue(nowMs: number, limit = 100): readonly EvaluationPointRecord[] {
    return (this.database
      .prepare(`
        SELECT id, sample_id, horizon_seconds, scheduled_at_ms,
               next_attempt_at_ms, status, retry_count, details_json
        FROM signal_evaluation_points
        WHERE status = 'PENDING' AND next_attempt_at_ms <= ?
        ORDER BY next_attempt_at_ms, id
        LIMIT ?
      `)
      .all(nowMs, limit) as unknown as PointRow[]).map(toPoint);
  }

  pathResult(sampleId: number, horizonSeconds: EvaluationHorizon): StoredPathResult | undefined {
    const row = this.database
      .prepare(`
        SELECT status, price_usd, gross_return, mfe, mae, path_30_15, path_2x_30
        FROM signal_evaluation_points
        WHERE sample_id = ? AND horizon_seconds = ?
          AND status IN ('COMPLETE', 'AMBIGUOUS')
      `)
      .get(sampleId, horizonSeconds) as
      | {
          status: StoredPathResult['status'];
          price_usd: number;
          gross_return: number;
          mfe: number;
          mae: number;
          path_30_15: StoredPathResult['path30_15'];
          path_2x_30: StoredPathResult['path2x_30'];
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          status: row.status,
          priceUsd: row.price_usd,
          grossReturn: row.gross_return,
          mfe: row.mfe,
          mae: row.mae,
          path30_15: row.path_30_15,
          path2x_30: row.path_2x_30,
          ambiguous: row.status === 'AMBIGUOUS'
        };
  }

  completeEntry(input: {
    readonly point: EvaluationPointRecord;
    readonly priceUsd: number;
    readonly tradeAtMs: number;
    readonly sellAtMs?: number;
    readonly observedAtMs: number;
    readonly facts?: unknown;
    readonly result?: PathMetrics;
  }): void {
    this.database
      .prepare(`
        UPDATE delivered_signal_samples
        SET entry_status = 'COMPLETE', entry_price_usd = ?, entry_trade_at_ms = ?,
            sell_trade_observed = CASE WHEN ? IS NULL THEN sell_trade_observed ELSE 1 END,
            first_sell_trade_at_ms = COALESCE(first_sell_trade_at_ms, ?), updated_at_ms = ?
        WHERE id = ? AND entry_status = 'PENDING'
      `)
      .run(
        input.priceUsd,
        input.tradeAtMs,
        input.sellAtMs ?? null,
        input.sellAtMs ?? null,
        input.observedAtMs,
        input.point.sampleId
      );
    this.completePoint(input.point, input.result ?? {
      priceUsd: input.priceUsd,
      grossReturn: 0,
      mfe: 0,
      mae: 0,
      path30_15: 'NONE',
      path2x_30: 'NONE',
      ambiguous: false
    }, 'TRADES', 'trade', input.observedAtMs, input.facts);
  }

  markEntryUnavailable(point: EvaluationPointRecord, observedAtMs: number): void {
    this.database
      .prepare(`
        UPDATE delivered_signal_samples
        SET entry_status = 'ENTRY_UNAVAILABLE', updated_at_ms = ?
        WHERE id = ? AND entry_status = 'PENDING'
      `)
      .run(observedAtMs, point.sampleId);
    this.database
      .prepare(`
        UPDATE signal_evaluation_points
        SET status = 'ENTRY_UNAVAILABLE', observed_at_ms = ?,
            details_json = '{"reason":"no_trade_within_entry_window"}', updated_at_ms = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(observedAtMs, observedAtMs, point.id);
    this.database
      .prepare(`
        UPDATE signal_evaluation_points
        SET status = 'ENTRY_UNAVAILABLE', observed_at_ms = ?,
            details_json = '{"reason":"entry_unavailable"}', updated_at_ms = ?
        WHERE sample_id = ? AND status = 'PENDING'
      `)
      .run(observedAtMs, observedAtMs, point.sampleId);
  }

  deferEntryUntil(point: EvaluationPointRecord, nextAttemptAtMs: number, observedAtMs: number): void {
    this.database
      .prepare(`
        UPDATE signal_evaluation_points
        SET next_attempt_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'PENDING' AND next_attempt_at_ms < ?
      `)
      .run(nextAttemptAtMs, observedAtMs, point.id, nextAttemptAtMs);
  }

  markEntryProviderMissing(
    point: EvaluationPointRecord,
    providerError: string,
    observedAtMs: number
  ): void {
    const details = stableJsonStringify({
      providerError,
      reason: 'entry_provider_missing'
    });
    this.database
      .prepare(`
        UPDATE delivered_signal_samples
        SET entry_status = 'PROVIDER_MISSING', updated_at_ms = ?
        WHERE id = ? AND entry_status = 'PENDING'
      `)
      .run(observedAtMs, point.sampleId);
    this.database
      .prepare(`
        UPDATE signal_evaluation_points
        SET status = 'PROVIDER_MISSING', observed_at_ms = ?, details_json = ?, updated_at_ms = ?
        WHERE sample_id = ? AND status = 'PENDING'
      `)
      .run(observedAtMs, details, observedAtMs, point.sampleId);
  }

  completePoint(
    point: EvaluationPointRecord,
    result: PathMetrics,
    source: 'TRADES' | 'OHLCV',
    granularity: string,
    observedAtMs: number,
    facts: unknown = {}
  ): void {
    this.database
      .prepare(`
        UPDATE signal_evaluation_points
        SET status = ?, observed_at_ms = ?, price_usd = ?, gross_return = ?,
            mfe = ?, mae = ?, path_30_15 = ?, path_2x_30 = ?, source = ?,
            granularity = ?, details_json = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(
        result.ambiguous ? 'AMBIGUOUS' : 'COMPLETE',
        observedAtMs,
        result.priceUsd,
        result.grossReturn,
        result.mfe,
        result.mae,
        result.path30_15,
        result.path2x_30,
        source,
        granularity,
        stableJsonStringify({
          simulatedEntryUsd: EVALUATION_POLICY.simulatedEntryUsd,
          grossPriceOnly: true,
          executableSaleClaimed: false,
          ...((facts !== null && typeof facts === 'object' && !Array.isArray(facts))
            ? facts as Record<string, unknown>
            : { facts })
        }),
        observedAtMs,
        point.id
      );
  }

  recordSell(sampleId: number, firstSellAtMs: number, observedAtMs: number): void {
    this.database
      .prepare(`
        UPDATE delivered_signal_samples
        SET sell_trade_observed = 1,
            first_sell_trade_at_ms = COALESCE(first_sell_trade_at_ms, ?), updated_at_ms = ?
        WHERE id = ?
      `)
      .run(firstSellAtMs, observedAtMs, sampleId);
  }

  markFailure(point: EvaluationPointRecord, safeError: string, observedAtMs: number): boolean {
    const current = this.database
      .prepare('SELECT retry_count FROM signal_evaluation_points WHERE id = ?')
      .get(point.id) as { retry_count: number };
    if (current.retry_count === 0) {
      this.database
        .prepare(`
          UPDATE signal_evaluation_points
          SET retry_count = 1, next_attempt_at_ms = ?, details_json = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'PENDING'
        `)
        .run(
          observedAtMs + EVALUATION_POLICY.retryDelayMs,
          stableJsonStringify({ providerError: safeError }),
          observedAtMs,
          point.id
        );
      return false;
    }
    this.database
      .prepare(`
        UPDATE signal_evaluation_points
        SET status = 'PROVIDER_MISSING', observed_at_ms = ?, details_json = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(
        observedAtMs,
        stableJsonStringify({ providerError: safeError }),
        observedAtMs,
        point.id
      );
    if (point.horizonSeconds === 10) {
      this.database
        .prepare(`
          UPDATE delivered_signal_samples
          SET entry_status = 'PROVIDER_MISSING', updated_at_ms = ?
          WHERE id = ? AND entry_status = 'PENDING'
        `)
        .run(observedAtMs, point.sampleId);
      this.database
        .prepare(`
          UPDATE signal_evaluation_points
          SET status = 'PROVIDER_MISSING', observed_at_ms = ?, details_json = ?, updated_at_ms = ?
          WHERE sample_id = ? AND status = 'PENDING'
        `)
        .run(
          observedAtMs,
          stableJsonStringify({ providerError: safeError, reason: 'entry_provider_missing' }),
          observedAtMs,
          point.sampleId
        );
    }
    return true;
  }

  markTerminalNegative(sampleId: number, reason: string, observedAtMs: number): void {
    const details = stableJsonStringify({ reason });
    this.database
      .prepare(`
        UPDATE delivered_signal_samples
        SET entry_status = CASE WHEN entry_status = 'PENDING' THEN 'TERMINAL_NEGATIVE' ELSE entry_status END,
            updated_at_ms = ? WHERE id = ?
      `)
      .run(observedAtMs, sampleId);
    this.database
      .prepare(`
        UPDATE signal_evaluation_points
        SET status = 'TERMINAL_NEGATIVE', observed_at_ms = ?, details_json = ?, updated_at_ms = ?
        WHERE sample_id = ? AND status = 'PENDING'
      `)
      .run(observedAtMs, details, observedAtMs, sampleId);
  }

  maybePromoteBeta(chain: Chain, observedAtMs: number): boolean {
    const state = this.chainState(chain);
    if (state.state !== 'VALIDATING') return false;
    if (
      this.matureEvaluationCount(chain, state.validationEpoch, observedAtMs) <
      EVALUATION_POLICY.betaMatureSamples
    ) return false;
    this.database
      .prepare(`
        UPDATE chain_release_state
        SET state = 'BETA', suspension_reason = NULL, updated_at_ms = ?
        WHERE chain = ? AND state = 'VALIDATING' AND validation_epoch = ?
      `)
      .run(observedAtMs, chain, state.validationEpoch);
    return this.chainState(chain).state === 'BETA';
  }

  suspend(chain: Chain, reason: string, observedAtMs: number): void {
    this.database
      .prepare(`
        UPDATE chain_release_state
        SET state = 'SUSPENDED', suspension_reason = ?, updated_at_ms = ?
        WHERE chain = ?
      `)
      .run(reason, observedAtMs, chain);
    this.database
      .prepare(`
        UPDATE candidates
        SET status = 'REJECTED', terminal_reason = 'CHAIN_SUSPENDED', updated_at_ms = ?
        WHERE chain = ? AND status NOT IN ('SIGNAL_SENT', 'REJECTED', 'EXPIRED')
      `)
      .run(observedAtMs, chain);
  }

  resumeAfterFix(chain: Chain, observedAtMs: number): ChainReleaseRecord {
    const result = this.database
      .prepare(`
        UPDATE chain_release_state
        SET state = 'VALIDATING', validation_epoch = validation_epoch + 1,
            next_validation_seq = 1, suspension_reason = NULL, updated_at_ms = ?
        WHERE chain = ? AND state = 'SUSPENDED'
      `)
      .run(observedAtMs, chain);
    if (result.changes !== 1) throw new Error('only a suspended chain can resume');
    return this.chainState(chain);
  }

  liveReport(chain: Chain, nowMs: number, decisionRuleVersion?: string): unknown {
    const total = (this.database
      .prepare(`
        SELECT COUNT(*) AS count FROM delivered_signal_samples
        WHERE chain = ? AND (? IS NULL OR decision_rule_version = ?)
      `)
      .get(
        chain,
        decisionRuleVersion ?? null,
        decisionRuleVersion ?? null
      ) as { count: number }).count;
    const bySegment = this.database
      .prepare(`
        SELECT s.decision_rule_version AS ruleVersion,
               COALESCE(json_extract(s.snapshot_json, '$.eligibility.opportunityType'), 'legacy') AS opportunityType,
               s.delivery_stage AS deliveryStage,
               p.horizon_seconds AS horizonSeconds,
               COUNT(*) AS total,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 THEN 1 ELSE 0 END) AS due,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.status IN ('COMPLETE', 'AMBIGUOUS') THEN 1 ELSE 0 END) AS complete,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.status = 'TERMINAL_NEGATIVE' THEN 1 ELSE 0 END) AS terminalNegative,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.status = 'PROVIDER_MISSING' THEN 1 ELSE 0 END) AS providerMissing,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.status = 'ENTRY_UNAVAILABLE' THEN 1 ELSE 0 END) AS entryUnavailable,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.status = 'PENDING' THEN 1 ELSE 0 END) AS pendingDue,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND s.first_sell_trade_at_ms <= p.scheduled_at_ms THEN 1 ELSE 0 END) AS sellTradeObserved,
               AVG(CASE WHEN p.scheduled_at_ms <= ?1 THEN p.gross_return END) AS averageGrossReturn,
               AVG(CASE WHEN p.scheduled_at_ms <= ?1 THEN p.mfe END) AS averageMfe,
               AVG(CASE WHEN p.scheduled_at_ms <= ?1 THEN p.mae END) AS averageMae,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.path_30_15 = 'UP_FIRST' THEN 1 ELSE 0 END) AS path30_15UpFirst,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.path_30_15 = 'DOWN_FIRST' THEN 1 ELSE 0 END) AS path30_15DownFirst,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.path_30_15 = 'AMBIGUOUS' THEN 1 ELSE 0 END) AS path30_15Ambiguous,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.path_2x_30 = 'UP_FIRST' THEN 1 ELSE 0 END) AS path2x_30UpFirst,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.path_2x_30 = 'DOWN_FIRST' THEN 1 ELSE 0 END) AS path2x_30DownFirst,
               SUM(CASE WHEN p.scheduled_at_ms <= ?1 AND p.path_2x_30 = 'AMBIGUOUS' THEN 1 ELSE 0 END) AS path2x_30Ambiguous,
               AVG(CASE WHEN p.scheduled_at_ms <= ?1 THEN json_extract(p.details_json, '$.entryDelayMs') END) AS averageEntryDelayMs,
               AVG(CASE WHEN p.scheduled_at_ms <= ?1 THEN json_extract(p.details_json, '$.reserveUsd') END) AS averageReserveUsd,
               AVG(CASE WHEN p.scheduled_at_ms <= ?1 THEN json_extract(p.details_json, '$.security.buyTaxRatio') END) AS averageBuyTaxRatio,
               AVG(CASE WHEN p.scheduled_at_ms <= ?1 THEN json_extract(p.details_json, '$.security.sellTaxRatio') END) AS averageSellTaxRatio
        FROM delivered_signal_samples s
        JOIN signal_evaluation_points p ON p.sample_id = s.id
        WHERE s.chain = ?2 AND p.horizon_seconds IN (300, 900)
          AND (?3 IS NULL OR s.decision_rule_version = ?3)
        GROUP BY s.decision_rule_version, opportunityType, s.delivery_stage, p.horizon_seconds
        ORDER BY s.decision_rule_version, opportunityType, s.delivery_stage, p.horizon_seconds
      `)
      .all(nowMs, chain, decisionRuleVersion ?? null) as unknown as Array<Record<string, number | string>>;
    return {
      chain,
      totalDelivered: total,
      statement: '5条仅验证技术链路；毛价格变化不代表可执行净利润。',
      segments: bySegment.map((segment) => {
        const due = Number(segment.due);
        const covered = Number(segment.complete) + Number(segment.terminalNegative);
        return {
          ...segment,
          coverage: due === 0 ? null : covered / due,
          executionClaim: 'sell_trade_observed仅代表同池卖出成交；指标为毛价格，不是净利润。'
        };
      })
    };
  }

  createDueReports(chain: Chain, observedAtMs: number): void {
    const versions = this.database.prepare(`
      SELECT DISTINCT decision_rule_version AS version
      FROM delivered_signal_samples WHERE chain = ?
    `).all(chain) as Array<{ version: string }>;
    for (const { version } of versions) {
      const count = this.matureEvaluationCount(chain, null, observedAtMs, version);
      const latest = this.database.prepare(`
        SELECT MAX(boundary_count) AS boundary
        FROM evaluation_reports
        WHERE chain = ? AND decision_rule_version = ? AND kind = 'PARAMETER_REVIEW'
      `).get(chain, version) as { boundary: number | null };
      for (
        let boundary = latest.boundary === null
          ? EVALUATION_POLICY.reportFirstCount
          : latest.boundary + EVALUATION_POLICY.reportStep;
        boundary <= count;
        boundary += EVALUATION_POLICY.reportStep
      ) {
        this.insertReport(chain, version, 'PARAMETER_REVIEW', boundary, observedAtMs);
      }
    }
  }

  private insertReport(
    chain: Chain,
    decisionRuleVersion: string,
    kind: 'MILESTONE' | 'PARAMETER_REVIEW',
    count: number,
    observedAtMs: number
  ): void {
    this.database
      .prepare(`
        INSERT INTO evaluation_reports(
          chain, decision_rule_version, kind, boundary_count, generated_at_ms, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chain, decision_rule_version, kind, boundary_count) DO NOTHING
      `)
      .run(
        chain,
        decisionRuleVersion,
        kind,
        count,
        observedAtMs,
        stableJsonStringify({
          report: this.liveReport(chain, observedAtMs, decisionRuleVersion),
          ...(kind === 'PARAMETER_REVIEW'
            ? { reviewPolicy: { maximumParameterFamiliesPerChange: 1 } }
            : {})
        })
      );
  }

  private matureEvaluationCount(
    chain: Chain,
    validationEpoch: number | null,
    observedAtMs: number,
    decisionRuleVersion?: string
  ): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM delivered_signal_samples s
      JOIN signal_evaluation_points p
        ON p.sample_id = s.id AND p.horizon_seconds = ?1
      WHERE s.chain = ?2
        AND s.entry_price_usd IS NOT NULL AND s.entry_trade_at_ms IS NOT NULL
        AND p.scheduled_at_ms <= ?3
        AND p.status IN ('COMPLETE', 'AMBIGUOUS', 'TERMINAL_NEGATIVE')
        AND (?4 IS NULL OR (
          s.delivery_stage = 'validation' AND s.validation_epoch = ?4
        ))
        AND (?5 IS NULL OR s.decision_rule_version = ?5)
    `).get(
      EVALUATION_POLICY.betaMaturityHorizonSeconds,
      chain,
      observedAtMs,
      validationEpoch,
      decisionRuleVersion ?? null
    ) as { count: number };
    return row.count;
  }
}
