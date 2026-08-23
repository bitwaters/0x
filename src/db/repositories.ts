import type { Chain } from '../config.js';
import { normalizeAddress } from '../domain/address.js';
import { stableJsonStringify } from '../domain/json.js';
import type { SqliteDatabase } from './database.js';
import { withTransaction } from './database.js';

export const CANDIDATE_STATUSES = [
  'DISCOVERED',
  'RADAR',
  'PREHEAT',
  'POOL_BOUND',
  'MONITORING',
  'SIGNAL_SENT',
  'REJECTED',
  'EXPIRED'
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export type TerminalCandidateStatus = Extract<
  CandidateStatus,
  'SIGNAL_SENT' | 'REJECTED' | 'EXPIRED'
>;

const TERMINAL_STATUSES = new Set<CandidateStatus>([
  'SIGNAL_SENT',
  'REJECTED',
  'EXPIRED'
]);

const ALLOWED_TRANSITIONS: Readonly<Record<CandidateStatus, ReadonlySet<CandidateStatus>>> = {
  DISCOVERED: new Set(['RADAR', 'PREHEAT', 'REJECTED', 'EXPIRED']),
  RADAR: new Set(['PREHEAT', 'REJECTED', 'EXPIRED']),
  PREHEAT: new Set(['POOL_BOUND', 'REJECTED', 'EXPIRED']),
  POOL_BOUND: new Set(['MONITORING', 'REJECTED', 'EXPIRED']),
  MONITORING: new Set(['SIGNAL_SENT', 'REJECTED', 'EXPIRED']),
  SIGNAL_SENT: new Set(),
  REJECTED: new Set(),
  EXPIRED: new Set()
};

export interface CandidateRecord {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly status: CandidateStatus;
  readonly firstSeenAtMs: number;
  readonly firstSeenPriceUsd: number;
  readonly highPriceUsd: number;
  readonly sampledMaxGain: number;
  readonly opportunityType: 'new_pool' | 'revival' | null;
  readonly activationAtMs: number | null;
  readonly activationPriceUsd: number | null;
  readonly activationHighPriceUsd: number | null;
  readonly activationSampledMaxGain: number | null;
  readonly activationRuleVersion: string | null;
  readonly legacyReopenedAtMs: number | null;
  readonly firstSeenRank: number;
  readonly firstSeenMarketCapUsd: number;
  readonly firstSeenLiquidityUsd: number | null;
  readonly discoveryRuleVersion: string;
  readonly decisionRuleVersion: string | null;
  readonly qualificationStartedAtMs: number | null;
  readonly terminalReason: string | null;
}

interface CandidateRow {
  chain: Chain;
  token_address: string;
  status: CandidateStatus;
  first_seen_at_ms: number;
  first_seen_price_usd: number;
  high_price_usd: number;
  sampled_max_gain: number;
  opportunity_type: 'new_pool' | 'revival' | null;
  activation_at_ms: number | null;
  activation_price_usd: number | null;
  activation_high_price_usd: number | null;
  activation_sampled_max_gain: number | null;
  activation_rule_version: string | null;
  legacy_reopened_at_ms: number | null;
  first_seen_rank: number;
  first_seen_market_cap_usd: number;
  first_seen_liquidity_usd: number | null;
  discovery_rule_version: string;
  decision_rule_version: string | null;
  qualification_started_at_ms: number | null;
  terminal_reason: string | null;
}

function toCandidate(row: CandidateRow): CandidateRecord {
  return {
    chain: row.chain,
    tokenAddress: row.token_address,
    status: row.status,
    firstSeenAtMs: row.first_seen_at_ms,
    firstSeenPriceUsd: row.first_seen_price_usd,
    highPriceUsd: row.high_price_usd,
    sampledMaxGain: row.sampled_max_gain,
    opportunityType: row.opportunity_type,
    activationAtMs: row.activation_at_ms,
    activationPriceUsd: row.activation_price_usd,
    activationHighPriceUsd: row.activation_high_price_usd,
    activationSampledMaxGain: row.activation_sampled_max_gain,
    activationRuleVersion: row.activation_rule_version,
    legacyReopenedAtMs: row.legacy_reopened_at_ms,
    firstSeenRank: row.first_seen_rank,
    firstSeenMarketCapUsd: row.first_seen_market_cap_usd,
    firstSeenLiquidityUsd: row.first_seen_liquidity_usd,
    discoveryRuleVersion: row.discovery_rule_version,
    decisionRuleVersion: row.decision_rule_version,
    qualificationStartedAtMs: row.qualification_started_at_ms,
    terminalReason: row.terminal_reason
  };
}

function requireFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a finite positive number`);
  }
}

export class RuleVersionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  save(version: string, config: unknown, createdAtMs = Date.now()): void {
    const configJson = stableJsonStringify(config);
    const existing = this.database
      .prepare('SELECT config_json FROM rule_versions WHERE version = ?')
      .get(version) as { config_json: string } | undefined;

    if (existing !== undefined) {
      if (existing.config_json !== configJson) {
        throw new Error(`rule version ${version} already exists with different config`);
      }
      return;
    }

    this.database
      .prepare(
        'INSERT INTO rule_versions(version, config_json, created_at_ms) VALUES (?, ?, ?)'
      )
      .run(version, configJson, createdAtMs);
  }
}

export interface CreateCandidateInput {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly firstSeenAtMs: number;
  readonly firstSeenPriceUsd: number;
  readonly firstSeenRank: number;
  readonly firstSeenMarketCapUsd: number;
  readonly firstSeenLiquidityUsd: number | null;
  readonly discoveryRuleVersion: string;
}

export interface HighWaterObservation {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly observedPriceUsd: number;
  readonly maxGainRatio: number;
  readonly decisionRuleVersion: string;
  readonly observedAtMs: number;
  readonly raw: unknown;
}

export class CandidateRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listActionable(): readonly CandidateRecord[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM candidates
        WHERE status IN ('RADAR', 'PREHEAT', 'POOL_BOUND', 'MONITORING')
        ORDER BY
          CASE status
            WHEN 'PREHEAT' THEN 0
            WHEN 'POOL_BOUND' THEN 1
            WHEN 'MONITORING' THEN 2
            ELSE 3
          END,
          first_seen_at_ms,
          chain,
          token_address
      `)
      .all() as unknown as CandidateRow[];
    return rows.map(toCandidate);
  }

  listRadarCandidates(): readonly CandidateRecord[] {
    const rows = this.database
      .prepare(`
        SELECT c.* FROM candidates c
        WHERE c.status IN ('RADAR', 'PREHEAT', 'POOL_BOUND', 'MONITORING')
          OR EXISTS (
            SELECT 1 FROM message_outbox o
            WHERE o.chain = c.chain AND o.token_address = c.token_address
              AND o.message_kind = 'radar'
          )
        ORDER BY c.first_seen_at_ms, c.chain, c.token_address
      `)
      .all() as unknown as CandidateRow[];
    return rows.map(toCandidate);
  }

  find(chain: Chain, tokenAddress: string): CandidateRecord | undefined {
    const normalizedAddress = normalizeAddress(chain, tokenAddress);
    const row = this.database
      .prepare('SELECT * FROM candidates WHERE chain = ? AND token_address = ?')
      .get(chain, normalizedAddress) as CandidateRow | undefined;
    return row === undefined ? undefined : toCandidate(row);
  }

  findOrCreate(input: CreateCandidateInput): {
    readonly candidate: CandidateRecord;
    readonly created: boolean;
  } {
    requireFinitePositive(input.firstSeenPriceUsd, 'firstSeenPriceUsd');
    const normalizedAddress = normalizeAddress(input.chain, input.tokenAddress);
    const existing = this.find(input.chain, normalizedAddress);
    if (existing !== undefined) return { candidate: existing, created: false };

    if (!Number.isInteger(input.firstSeenRank) || input.firstSeenRank <= 0) {
      throw new RangeError('firstSeenRank must be a positive integer');
    }
    if (!Number.isFinite(input.firstSeenMarketCapUsd) || input.firstSeenMarketCapUsd < 0) {
      throw new RangeError('firstSeenMarketCapUsd must be finite and non-negative');
    }
    if (
      input.firstSeenLiquidityUsd !== null &&
      (!Number.isFinite(input.firstSeenLiquidityUsd) || input.firstSeenLiquidityUsd < 0)
    ) {
      throw new RangeError('firstSeenLiquidityUsd must be null or finite and non-negative');
    }

    const now = input.firstSeenAtMs;
    this.database
      .prepare(`
        INSERT INTO candidates(
          chain, token_address, status, first_seen_at_ms, first_seen_price_usd,
          high_price_usd, sampled_max_gain, first_seen_rank,
          first_seen_market_cap_usd, first_seen_liquidity_usd,
          discovery_rule_version, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'DISCOVERED', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.chain,
        normalizedAddress,
        input.firstSeenAtMs,
        input.firstSeenPriceUsd,
        input.firstSeenPriceUsd,
        input.firstSeenRank,
        input.firstSeenMarketCapUsd,
        input.firstSeenLiquidityUsd,
        input.discoveryRuleVersion,
        now,
        now
      );

    return { candidate: this.find(input.chain, normalizedAddress)!, created: true };
  }

  updateHighWater(input: HighWaterObservation): CandidateRecord {
    return withTransaction(this.database, () => this.updateHighWaterInTransaction(input));
  }

  updateHighWaterInTransaction(input: HighWaterObservation): CandidateRecord {
    requireFinitePositive(input.observedPriceUsd, 'observedPriceUsd');
    if (!Number.isFinite(input.maxGainRatio) || input.maxGainRatio < 0) {
      throw new RangeError('maxGainRatio must be finite and non-negative');
    }

    const candidate = this.find(input.chain, input.tokenAddress);
    if (candidate === undefined) throw new Error('candidate not found');
    const highPrice = Math.max(candidate.highPriceUsd, input.observedPriceUsd);
    const sampledMaxGain = highPrice / candidate.firstSeenPriceUsd - 1;
    const activationHighPrice = candidate.activationPriceUsd === null
      ? null
      : Math.max(candidate.activationHighPriceUsd ?? candidate.activationPriceUsd, input.observedPriceUsd);
    const activationSampledMaxGain = activationHighPrice === null || candidate.activationPriceUsd === null
      ? null
      : activationHighPrice / candidate.activationPriceUsd - 1;
    const shouldReject =
      !TERMINAL_STATUSES.has(candidate.status) &&
      candidate.activationPriceUsd !== null &&
      activationHighPrice! > candidate.activationPriceUsd * (1 + input.maxGainRatio);
    const normalizedAddress = normalizeAddress(input.chain, input.tokenAddress);

    this.database
      .prepare(`
          UPDATE candidates
          SET high_price_usd = ?, sampled_max_gain = ?,
              activation_high_price_usd = ?, activation_sampled_max_gain = ?,
              status = CASE WHEN ? THEN 'REJECTED' ELSE status END,
              terminal_reason = CASE WHEN ? THEN 'CHASE_LIMIT_EXCEEDED' ELSE terminal_reason END,
              decision_rule_version = CASE WHEN ? THEN ? ELSE decision_rule_version END,
              updated_at_ms = ?
          WHERE chain = ? AND token_address = ?
        `)
      .run(
          highPrice,
          sampledMaxGain,
          activationHighPrice,
          activationSampledMaxGain,
          shouldReject ? 1 : 0,
          shouldReject ? 1 : 0,
          shouldReject ? 1 : 0,
          input.decisionRuleVersion,
          input.observedAtMs,
          input.chain,
          normalizedAddress
      );

    if (shouldReject) {
      new QualificationEventRepository(this.database).record({
          chain: input.chain,
          tokenAddress: normalizedAddress,
          stage: 'discovery_high_water',
          outcome: 'REJECT',
          reasonCode: 'CHASE_LIMIT_EXCEEDED',
          source: 'gmgn',
          observedAtMs: input.observedAtMs,
          raw: input.raw,
          normalized: {
            activationPriceUsd: candidate.activationPriceUsd,
            observedPriceUsd: input.observedPriceUsd,
            highPriceUsd: highPrice,
            activationSampledMaxGain
          },
          thresholds: { maxGainRatio: input.maxGainRatio },
          decisionRuleVersion: input.decisionRuleVersion
      });
    }
    return this.find(input.chain, normalizedAddress)!;
  }

  activate(input: {
    readonly chain: Chain;
    readonly tokenAddress: string;
    readonly opportunityType: 'new_pool' | 'revival';
    readonly priceUsd: number;
    readonly ruleVersion: string;
    readonly atMs: number;
  }): CandidateRecord {
    requireFinitePositive(input.priceUsd, 'priceUsd');
    const token = normalizeAddress(input.chain, input.tokenAddress);
    const result = this.database.prepare(`
      UPDATE candidates
      SET opportunity_type = ?, activation_at_ms = ?, activation_price_usd = ?,
          activation_high_price_usd = ?, activation_sampled_max_gain = 0,
          activation_rule_version = ?, decision_rule_version = ?, updated_at_ms = ?
      WHERE chain = ? AND token_address = ? AND activation_at_ms IS NULL
        AND status IN ('DISCOVERED', 'RADAR')
    `).run(
      input.opportunityType,
      input.atMs,
      input.priceUsd,
      input.priceUsd,
      input.ruleVersion,
      input.ruleVersion,
      input.atMs,
      input.chain,
      token
    );
    if (result.changes !== 1) {
      const existing = this.find(input.chain, token);
      if (existing?.activationAtMs === null || existing === undefined) {
        throw new Error('candidate is not activatable');
      }
    }
    return this.find(input.chain, token)!;
  }

  reopenEligibleLegacy(ruleVersion: string, atMs = Date.now()): number {
    return withTransaction(this.database, () => {
      const activeRows = this.database.prepare(`
        SELECT chain, token_address, status
        FROM candidates
        WHERE activation_at_ms IS NULL AND legacy_reopened_at_ms IS NULL
          AND status IN ('PREHEAT', 'POOL_BOUND', 'MONITORING')
          AND NOT EXISTS (
            SELECT 1 FROM message_outbox o
            WHERE o.chain = candidates.chain AND o.token_address = candidates.token_address
              AND o.message_kind = 'signal'
              AND o.status IN ('SENDING', 'SENT', 'UNCERTAIN')
          )
      `).all() as Array<{
        chain: Chain;
        token_address: string;
        status: CandidateStatus;
      }>;
      const rows = this.database.prepare(`
        SELECT chain, token_address, terminal_reason
        FROM candidates c
        WHERE c.status = 'REJECTED' AND c.legacy_reopened_at_ms IS NULL
          AND c.activation_at_ms IS NULL
          AND (
            c.terminal_reason IN ('POOL_TOO_OLD', 'POOL_AGE_OUT_OF_RANGE')
            OR c.terminal_reason = 'CHASE_LIMIT_EXCEEDED'
          )
          AND NOT EXISTS (
            SELECT 1 FROM message_outbox o
            WHERE o.chain = c.chain AND o.token_address = c.token_address
              AND o.message_kind = 'signal'
              AND o.status IN ('SENDING', 'SENT', 'UNCERTAIN')
          )
      `).all() as Array<{
        chain: Chain;
        token_address: string;
        terminal_reason: string;
      }>;
      const events = new QualificationEventRepository(this.database);
      for (const row of activeRows) {
        this.database.prepare(`
          DELETE FROM pool_bindings WHERE chain = ? AND token_address = ?
        `).run(row.chain, row.token_address);
        this.database.prepare(`
          UPDATE candidates
          SET status = 'DISCOVERED', terminal_reason = NULL,
              decision_rule_version = NULL, qualification_started_at_ms = NULL,
              legacy_reopened_at_ms = ?, updated_at_ms = ?
          WHERE chain = ? AND token_address = ?
        `).run(atMs, atMs, row.chain, row.token_address);
        events.record({
          chain: row.chain,
          tokenAddress: row.token_address,
          stage: 'legacy_reopen',
          outcome: 'PASS',
          reasonCode: 'LEGACY_ACTIVE_RESET',
          source: 'system',
          observedAtMs: atMs,
          raw: { originalStatus: row.status },
          normalized: { reopenedStatus: 'DISCOVERED' },
          thresholds: { requiresFreshActivation: true },
          decisionRuleVersion: ruleVersion
        });
      }
      for (const row of rows) {
        this.database.prepare(`
          DELETE FROM pool_bindings WHERE chain = ? AND token_address = ?
        `).run(row.chain, row.token_address);
        this.database.prepare(`
          UPDATE candidates
          SET status = 'DISCOVERED', terminal_reason = NULL,
              decision_rule_version = NULL, qualification_started_at_ms = NULL,
              opportunity_type = NULL, activation_at_ms = NULL,
              activation_price_usd = NULL, activation_high_price_usd = NULL,
              activation_sampled_max_gain = NULL, activation_rule_version = NULL,
              legacy_reopened_at_ms = ?, updated_at_ms = ?
          WHERE chain = ? AND token_address = ?
        `).run(atMs, atMs, row.chain, row.token_address);
        events.record({
          chain: row.chain,
          tokenAddress: row.token_address,
          stage: 'legacy_reopen',
          outcome: 'PASS',
          reasonCode: 'LEGACY_TERMINAL_REOPENED',
          source: 'system',
          observedAtMs: atMs,
          raw: { originalReason: row.terminal_reason },
          normalized: { reopenedStatus: 'DISCOVERED' },
          thresholds: { eligibleReasons: [
            'POOL_TOO_OLD', 'POOL_AGE_OUT_OF_RANGE', 'CHASE_LIMIT_EXCEEDED'
          ] },
          decisionRuleVersion: ruleVersion
        });
      }
      return activeRows.length + rows.length;
    });
  }

  transition(
    chain: Chain,
    tokenAddress: string,
    nextStatus: CandidateStatus,
    options: {
      readonly atMs?: number;
      readonly terminalReason?: string;
      readonly qualificationStartedAtMs?: number;
    } = {}
  ): CandidateRecord {
    const candidate = this.find(chain, tokenAddress);
    if (candidate === undefined) throw new Error('candidate not found');
    if (nextStatus === 'POOL_BOUND') {
      throw new Error('POOL_BOUND requires an atomic pool binding');
    }
    if (!ALLOWED_TRANSITIONS[candidate.status].has(nextStatus)) {
      throw new Error(`invalid candidate transition ${candidate.status} -> ${nextStatus}`);
    }
    const terminalReason = TERMINAL_STATUSES.has(nextStatus)
      ? options.terminalReason ?? nextStatus
      : null;

    this.database
      .prepare(`
        UPDATE candidates
        SET status = ?, terminal_reason = ?,
            qualification_started_at_ms = COALESCE(?, qualification_started_at_ms),
            updated_at_ms = ?
        WHERE chain = ? AND token_address = ?
      `)
      .run(
        nextStatus,
        terminalReason,
        options.qualificationStartedAtMs ?? null,
        options.atMs ?? Date.now(),
        chain,
        normalizeAddress(chain, tokenAddress)
      );
    return this.find(chain, tokenAddress)!;
  }

  setDecisionRuleVersion(
    chain: Chain,
    tokenAddress: string,
    version: string,
    updatedAtMs = Date.now()
  ): CandidateRecord {
    const candidate = this.find(chain, tokenAddress);
    if (candidate === undefined) throw new Error('candidate not found');
    if (TERMINAL_STATUSES.has(candidate.status)) {
      throw new Error('terminal candidate cannot be requalified');
    }
    this.database
      .prepare(`
        UPDATE candidates SET decision_rule_version = ?, updated_at_ms = ?
        WHERE chain = ? AND token_address = ?
      `)
      .run(version, updatedAtMs, chain, normalizeAddress(chain, tokenAddress));
    return this.find(chain, tokenAddress)!;
  }

  expireQualificationWindows(input: {
    readonly nowMs: number;
    readonly windowSeconds: number;
    readonly decisionRuleVersion: string;
  }): readonly CandidateRecord[] {
    if (!Number.isInteger(input.windowSeconds) || input.windowSeconds <= 0) {
      throw new RangeError('windowSeconds must be a positive integer');
    }
    const cutoffMs = input.nowMs - input.windowSeconds * 1_000;
    return withTransaction(this.database, () => {
      const rows = this.database
        .prepare(`
          SELECT * FROM candidates
          WHERE status IN ('POOL_BOUND', 'MONITORING')
            AND qualification_started_at_ms IS NOT NULL
            AND qualification_started_at_ms <= ?
          ORDER BY chain, token_address
        `)
        .all(cutoffMs) as unknown as CandidateRow[];
      const events = new QualificationEventRepository(this.database);
      for (const row of rows) {
        this.database
          .prepare(`
            UPDATE candidates
            SET status = 'EXPIRED', terminal_reason = 'QUALIFICATION_WINDOW_EXPIRED',
                decision_rule_version = ?, updated_at_ms = ?
            WHERE chain = ? AND token_address = ?
          `)
          .run(
            input.decisionRuleVersion,
            input.nowMs,
            row.chain,
            row.token_address
          );
        events.record({
          chain: row.chain,
          tokenAddress: row.token_address,
          stage: 'qualification_window',
          outcome: 'REJECT',
          reasonCode: 'QUALIFICATION_WINDOW_EXPIRED',
          source: 'system',
          observedAtMs: input.nowMs,
          raw: { qualificationStartedAtMs: row.qualification_started_at_ms },
          normalized: { elapsedMs: input.nowMs - row.qualification_started_at_ms! },
          thresholds: { windowSeconds: input.windowSeconds },
          decisionRuleVersion: input.decisionRuleVersion
        });
      }
      return rows.map((row) => this.find(row.chain, row.token_address)!);
    });
  }
}

export interface RankSnapshotInput {
  readonly chain: Chain;
  readonly interval: '1m' | '5m';
  readonly fetchedAtMs: number;
  readonly tokenAddress: string;
  readonly rank: number;
  readonly priceUsd: number;
  readonly marketCapUsd: number;
  readonly liquidityUsd: number | null;
  readonly raw: unknown;
}

export type RankSnapshotRecord = RankSnapshotInput;

export class RankSnapshotRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(input: RankSnapshotInput): void {
    requireFinitePositive(input.priceUsd, 'priceUsd');
    this.database
      .prepare(`
        INSERT INTO rank_snapshots(
          chain, interval, fetched_at_ms, token_address, rank, price_usd,
          market_cap_usd, liquidity_usd, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chain, interval, fetched_at_ms, token_address) DO NOTHING
      `)
      .run(
        input.chain,
        input.interval,
        input.fetchedAtMs,
        normalizeAddress(input.chain, input.tokenAddress),
        input.rank,
        input.priceUsd,
        input.marketCapUsd,
        input.liquidityUsd,
        stableJsonStringify(input.raw)
      );
  }

  findLatest(
    chain: Chain,
    tokenAddress: string,
    interval: '1m' | '5m' = '1m'
  ): RankSnapshotRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT chain, interval, fetched_at_ms, token_address, rank, price_usd,
               market_cap_usd, liquidity_usd, raw_json
        FROM rank_snapshots
        WHERE chain = ? AND token_address = ? AND interval = ?
        ORDER BY fetched_at_ms DESC, id DESC
        LIMIT 1
      `)
      .get(chain, normalizeAddress(chain, tokenAddress), interval) as
      | {
          chain: Chain;
          interval: '1m' | '5m';
          fetched_at_ms: number;
          token_address: string;
          rank: number;
          price_usd: number;
          market_cap_usd: number;
          liquidity_usd: number | null;
          raw_json: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          chain: row.chain,
          interval: row.interval,
          fetchedAtMs: row.fetched_at_ms,
          tokenAddress: row.token_address,
          rank: row.rank,
          priceUsd: row.price_usd,
          marketCapUsd: row.market_cap_usd,
          liquidityUsd: row.liquidity_usd,
          raw: JSON.parse(row.raw_json) as unknown
        };
  }

  findLatestSuccessfulFetchAt(chain: Chain, interval: '1m' | '5m'): number | undefined {
    const row = this.database.prepare(`
      SELECT fetched_at_ms
      FROM rank_snapshot_fetches
      WHERE chain = ? AND interval = ?
      ORDER BY fetched_at_ms DESC
      LIMIT 1
    `).get(chain, interval) as { fetched_at_ms: number } | undefined;
    return row?.fetched_at_ms;
  }
}

export class RankSnapshotFetchRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(input: {
    readonly chain: Chain;
    readonly interval: '1m' | '5m';
    readonly fetchedAtMs: number;
    readonly itemCount: number;
    readonly discoveryRuleVersion: string;
  }): void {
    if (!Number.isInteger(input.itemCount) || input.itemCount < 0 || input.itemCount > 100) {
      throw new RangeError('rank snapshot item count must be between 0 and 100');
    }
    this.database
      .prepare(`
        INSERT INTO rank_snapshot_fetches(
          chain, interval, fetched_at_ms, item_count, discovery_rule_version
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        input.chain,
        input.interval,
        input.fetchedAtMs,
        input.itemCount,
        input.discoveryRuleVersion
      );
  }
}

export interface PoolBindingRecord {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly poolAddress: string;
  readonly candidateSide: 'base' | 'quote';
  readonly counterTokenAddress: string;
  readonly boundAtMs: number;
  readonly qualificationReferencePriceUsd: number | null;
  readonly qualificationReferenceAtMs: number | null;
}

export class PoolBindingRepository {
  constructor(private readonly database: SqliteDatabase) {}

  find(chain: Chain, tokenAddress: string): PoolBindingRecord | undefined {
    const normalizedToken = normalizeAddress(chain, tokenAddress);
    const row = this.database
      .prepare(`
        SELECT chain, token_address, pool_address, candidate_side,
               counter_token_address, bound_at_ms,
               qualification_reference_price_usd, qualification_reference_at_ms
        FROM pool_bindings WHERE chain = ? AND token_address = ?
      `)
      .get(chain, normalizedToken) as
      | {
          chain: Chain;
          token_address: string;
          pool_address: string;
          candidate_side: 'base' | 'quote';
          counter_token_address: string;
          bound_at_ms: number;
          qualification_reference_price_usd: number | null;
          qualification_reference_at_ms: number | null;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          chain: row.chain,
          tokenAddress: row.token_address,
          poolAddress: row.pool_address,
          candidateSide: row.candidate_side,
          counterTokenAddress: row.counter_token_address,
          boundAtMs: row.bound_at_ms,
          qualificationReferencePriceUsd: row.qualification_reference_price_usd,
          qualificationReferenceAtMs: row.qualification_reference_at_ms
        };
  }

  setQualificationReference(input: {
    readonly chain: Chain;
    readonly tokenAddress: string;
    readonly priceUsd: number;
    readonly atMs: number;
  }): PoolBindingRecord {
    requireFinitePositive(input.priceUsd, 'priceUsd');
    const token = normalizeAddress(input.chain, input.tokenAddress);
    this.database.prepare(`
      UPDATE pool_bindings
      SET qualification_reference_price_usd = ?, qualification_reference_at_ms = ?
      WHERE chain = ? AND token_address = ?
        AND qualification_reference_price_usd IS NULL
    `).run(input.priceUsd, input.atMs, input.chain, token);
    const binding = this.find(input.chain, token);
    if (binding === undefined || binding.qualificationReferencePriceUsd === null) {
      throw new Error('pool binding reference price could not be persisted');
    }
    return binding;
  }

  findActive(): readonly PoolBindingRecord[] {
    const rows = this.database
      .prepare(`
        SELECT p.chain, p.token_address, p.pool_address, p.candidate_side,
               p.counter_token_address, p.bound_at_ms,
               p.qualification_reference_price_usd, p.qualification_reference_at_ms
        FROM pool_bindings p
        JOIN candidates c
          ON c.chain = p.chain AND c.token_address = p.token_address
        WHERE c.status IN ('POOL_BOUND', 'MONITORING')
        ORDER BY p.chain, p.token_address
      `)
      .all() as unknown as Array<{
        chain: Chain;
        token_address: string;
        pool_address: string;
        candidate_side: 'base' | 'quote';
        counter_token_address: string;
        bound_at_ms: number;
        qualification_reference_price_usd: number | null;
        qualification_reference_at_ms: number | null;
      }>;
    return rows.map((row) => ({
      chain: row.chain,
      tokenAddress: row.token_address,
      poolAddress: row.pool_address,
      candidateSide: row.candidate_side,
      counterTokenAddress: row.counter_token_address,
      boundAtMs: row.bound_at_ms,
      qualificationReferencePriceUsd: row.qualification_reference_price_usd,
      qualificationReferenceAtMs: row.qualification_reference_at_ms
    }));
  }

  findByPool(chain: Chain, poolAddress: string): readonly PoolBindingRecord[] {
    const normalizedPool = normalizeAddress(chain, poolAddress);
    const rows = this.database
      .prepare(`
        SELECT chain, token_address, pool_address, candidate_side,
               counter_token_address, bound_at_ms,
               qualification_reference_price_usd, qualification_reference_at_ms
        FROM pool_bindings
        WHERE chain = ? AND pool_address = ?
        ORDER BY token_address
      `)
      .all(chain, normalizedPool) as unknown as Array<{
        chain: Chain;
        token_address: string;
        pool_address: string;
        candidate_side: 'base' | 'quote';
        counter_token_address: string;
        bound_at_ms: number;
        qualification_reference_price_usd: number | null;
        qualification_reference_at_ms: number | null;
      }>;
    return rows.map((row) => ({
      chain: row.chain,
      tokenAddress: row.token_address,
      poolAddress: row.pool_address,
      candidateSide: row.candidate_side,
      counterTokenAddress: row.counter_token_address,
      boundAtMs: row.bound_at_ms,
      qualificationReferencePriceUsd: row.qualification_reference_price_usd,
      qualificationReferenceAtMs: row.qualification_reference_at_ms
    }));
  }

  bind(input: {
    readonly chain: Chain;
    readonly tokenAddress: string;
    readonly poolAddress: string;
    readonly candidateSide: 'base' | 'quote';
    readonly counterTokenAddress: string;
    readonly boundAtMs?: number;
    readonly evidence?: {
      readonly raw: unknown;
      readonly normalized: unknown;
      readonly thresholds: unknown;
      readonly decisionRuleVersion: string;
    };
  }): boolean {
    const tokenAddress = normalizeAddress(input.chain, input.tokenAddress);
    const poolAddress = normalizeAddress(input.chain, input.poolAddress);
    const counterTokenAddress = normalizeAddress(input.chain, input.counterTokenAddress);
    return withTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          'SELECT pool_address, candidate_side, counter_token_address FROM pool_bindings WHERE chain = ? AND token_address = ?'
        )
        .get(input.chain, tokenAddress) as
        | { pool_address: string; candidate_side: string; counter_token_address: string }
        | undefined;

      if (existing !== undefined) {
        if (
          existing.pool_address !== poolAddress ||
          existing.candidate_side !== input.candidateSide ||
          existing.counter_token_address !== counterTokenAddress
        ) {
          throw new Error('candidate pool binding is immutable');
        }
        return false;
      }

      const boundAtMs = input.boundAtMs ?? Date.now();
      this.database
        .prepare(`
          INSERT INTO pool_bindings(
            chain, token_address, pool_address, candidate_side,
            counter_token_address, bound_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.chain,
          tokenAddress,
          poolAddress,
          input.candidateSide,
          counterTokenAddress,
          boundAtMs
        );
      const changed = this.database
        .prepare(`
          UPDATE candidates
          SET status = 'POOL_BOUND', qualification_started_at_ms = ?, updated_at_ms = ?
          WHERE chain = ? AND token_address = ? AND status = 'PREHEAT'
        `)
        .run(boundAtMs, boundAtMs, input.chain, tokenAddress);
      if (changed.changes !== 1) {
        throw new Error('candidate must be PREHEAT before pool binding');
      }
      if (input.evidence !== undefined) {
        new QualificationEventRepository(this.database).record({
          chain: input.chain,
          tokenAddress,
          stage: 'fixed_pool_binding',
          outcome: 'PASS',
          reasonCode: 'FIXED_POOL_BOUND',
          source: 'coingecko',
          observedAtMs: boundAtMs,
          raw: input.evidence.raw,
          normalized: input.evidence.normalized,
          thresholds: input.evidence.thresholds,
          decisionRuleVersion: input.evidence.decisionRuleVersion
        });
      }
      return true;
    });
  }
}

export class QualificationEventRepository {
  constructor(private readonly database: SqliteDatabase) {}

  record(input: {
    readonly chain: Chain;
    readonly tokenAddress: string;
    readonly stage: string;
    readonly outcome: 'PASS' | 'WAIT' | 'REJECT' | 'ERROR';
    readonly reasonCode: string;
    readonly source: 'gmgn' | 'coingecko' | 'system';
    readonly observedAtMs: number;
    readonly raw: unknown;
    readonly normalized: unknown;
    readonly thresholds: unknown;
    readonly decisionRuleVersion: string;
  }): number {
    const result = this.database
      .prepare(`
        INSERT INTO qualification_events(
          chain, token_address, stage, outcome, reason_code, source,
          observed_at_ms, raw_json, normalized_json, thresholds_json,
          decision_rule_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.chain,
        normalizeAddress(input.chain, input.tokenAddress),
        input.stage,
        input.outcome,
        input.reasonCode,
        input.source,
        input.observedAtMs,
        stableJsonStringify(input.raw),
        stableJsonStringify(input.normalized),
        stableJsonStringify(input.thresholds),
        input.decisionRuleVersion
      );
    return Number(result.lastInsertRowid);
  }

  findFirstActivationReasonCode(chain: Chain, tokenAddress: string): string | undefined {
    const row = this.database
      .prepare(`
        SELECT reason_code
        FROM qualification_events
        WHERE chain = ? AND token_address = ? AND stage = 'activation'
        ORDER BY observed_at_ms, id
        LIMIT 1
      `)
      .get(chain, normalizeAddress(chain, tokenAddress)) as
      | { reason_code: string }
      | undefined;
    return row?.reason_code;
  }
}

export type OutboxStatus = 'PENDING' | 'SENDING' | 'SENT' | 'UNCERTAIN';

export interface OutboxRecord {
  readonly id: number;
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly messageKind: 'radar' | 'signal';
  readonly channelRole: 'radar' | 'validation' | 'formal';
  readonly status: OutboxStatus;
  readonly payload: unknown;
  readonly attemptCount: number;
  readonly sendRequestedAtMs: number | null;
  readonly receiptAtMs: number | null;
  readonly telegramMessageId: string | null;
  readonly lastError: string | null;
  readonly appliedPayloadHash: string | null;
}

interface OutboxRow {
  id: number;
  chain: Chain;
  token_address: string;
  message_kind: 'radar' | 'signal';
  channel_role: 'radar' | 'validation' | 'formal';
  status: OutboxStatus;
  payload_json: string;
  attempt_count: number;
  send_requested_at_ms: number | null;
  receipt_at_ms: number | null;
  telegram_message_id: string | null;
  last_error: string | null;
  applied_payload_hash: string | null;
}

function toOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    chain: row.chain,
    tokenAddress: row.token_address,
    messageKind: row.message_kind,
    channelRole: row.channel_role,
    status: row.status,
    payload: JSON.parse(row.payload_json) as unknown,
    attemptCount: row.attempt_count,
    sendRequestedAtMs: row.send_requested_at_ms,
    receiptAtMs: row.receipt_at_ms,
    telegramMessageId: row.telegram_message_id,
    lastError: row.last_error,
    appliedPayloadHash: row.applied_payload_hash
  };
}

export class OutboxRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(input: {
    readonly chain: Chain;
    readonly tokenAddress: string;
    readonly messageKind: 'radar' | 'signal';
    readonly channelRole: 'radar' | 'validation' | 'formal';
    readonly payload: unknown;
    readonly createdAtMs?: number;
  }): OutboxRecord {
    if (input.messageKind === 'radar' && input.channelRole !== 'radar') {
      throw new Error('radar messages must use the radar channel role');
    }
    if (input.messageKind === 'signal' && input.channelRole === 'radar') {
      throw new Error('signal messages cannot use the radar channel role');
    }
    const createdAtMs = input.createdAtMs ?? Date.now();
    const tokenAddress = normalizeAddress(input.chain, input.tokenAddress);
    this.database
      .prepare(`
        INSERT INTO message_outbox(
          chain, token_address, message_kind, channel_role, status,
          payload_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)
      `)
      .run(
        input.chain,
        tokenAddress,
        input.messageKind,
        input.channelRole,
        stableJsonStringify(input.payload),
        createdAtMs,
        createdAtMs
      );
    return this.find(input.chain, tokenAddress, input.messageKind)!;
  }

  createOrGet(input: {
    readonly chain: Chain;
    readonly tokenAddress: string;
    readonly messageKind: 'radar' | 'signal';
    readonly channelRole: 'radar' | 'validation' | 'formal';
    readonly payload: unknown;
    readonly createdAtMs?: number;
  }): { readonly record: OutboxRecord; readonly created: boolean } {
    const existing = this.find(input.chain, input.tokenAddress, input.messageKind);
    if (existing !== undefined) return { record: existing, created: false };
    try {
      return { record: this.create(input), created: true };
    } catch (error) {
      const concurrent = this.find(input.chain, input.tokenAddress, input.messageKind);
      if (concurrent !== undefined) return { record: concurrent, created: false };
      throw error;
    }
  }

  find(
    chain: Chain,
    tokenAddress: string,
    messageKind: 'radar' | 'signal'
  ): OutboxRecord | undefined {
    const row = this.database
      .prepare(
        'SELECT * FROM message_outbox WHERE chain = ? AND token_address = ? AND message_kind = ?'
      )
      .get(chain, normalizeAddress(chain, tokenAddress), messageKind) as OutboxRow | undefined;
    return row === undefined ? undefined : toOutbox(row);
  }

  claim(id: number, requestedAtMs = Date.now()): OutboxRecord {
    const result = this.database
      .prepare(`
        UPDATE message_outbox
        SET status = 'SENDING', attempt_count = attempt_count + 1,
            send_requested_at_ms = ?, last_error = NULL, updated_at_ms = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(requestedAtMs, requestedAtMs, id);
    if (result.changes !== 1) throw new Error('outbox record is not claimable');
    return this.findById(id)!;
  }

  markSent(
    id: number,
    telegramMessageId: string,
    receiptAtMs = Date.now()
  ): OutboxRecord {
    if (telegramMessageId.trim() === '') throw new Error('Telegram message ID is required');
    const result = this.database
      .prepare(`
        UPDATE message_outbox
        SET status = 'SENT', telegram_message_id = ?, receipt_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'SENDING'
      `)
      .run(telegramMessageId, receiptAtMs, receiptAtMs, id);
    if (result.changes !== 1) throw new Error('outbox record is not sending');
    return this.findById(id)!;
  }

  updatePendingPayload(id: number, payload: unknown, atMs = Date.now()): OutboxRecord {
    const result = this.database
      .prepare(`
        UPDATE message_outbox SET payload_json = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(stableJsonStringify(payload), atMs, id);
    if (result.changes !== 1) throw new Error('outbox record is not pending');
    return this.findById(id)!;
  }

  updateRadarPayload(id: number, payload: unknown, atMs = Date.now()): OutboxRecord {
    const payloadJson = stableJsonStringify(payload);
    const result = this.database.prepare(`
      UPDATE message_outbox
      SET attempt_count = CASE WHEN payload_json <> ? THEN 0 ELSE attempt_count END,
          last_error = CASE WHEN payload_json <> ? THEN NULL ELSE last_error END,
          payload_json = ?, updated_at_ms = ?
      WHERE id = ? AND message_kind = 'radar' AND status = 'SENT'
    `).run(payloadJson, payloadJson, payloadJson, atMs, id);
    if (result.changes !== 1) throw new Error('radar outbox is not editable');
    return this.findById(id)!;
  }

  claimRadarEdit(id: number, atMs = Date.now(), maximumAttempts = 3): boolean {
    const result = this.database.prepare(`
      UPDATE message_outbox
      SET attempt_count = attempt_count + 1, updated_at_ms = ?
      WHERE id = ? AND message_kind = 'radar' AND status = 'SENT'
        AND attempt_count < ?
    `).run(atMs, id, maximumAttempts);
    return result.changes === 1;
  }

  resetRadarRateLimitAttempts(id: number, atMs = Date.now()): void {
    this.database.prepare(`
      UPDATE message_outbox SET attempt_count = 0, updated_at_ms = ?
      WHERE id = ? AND message_kind = 'radar' AND status = 'SENT'
        AND last_error LIKE 'Telegram rejected request (429):%'
    `).run(atMs, id);
  }

  markRadarEditFailed(id: number, safeError: string, atMs = Date.now()): OutboxRecord {
    const result = this.database.prepare(`
      UPDATE message_outbox SET last_error = ?, updated_at_ms = ?
      WHERE id = ? AND message_kind = 'radar' AND status = 'SENT'
    `).run(safeError, atMs, id);
    if (result.changes !== 1) throw new Error('radar edit failure cannot be recorded');
    return this.findById(id)!;
  }

  markPayloadApplied(id: number, hash: string, atMs = Date.now()): OutboxRecord {
    const result = this.database.prepare(`
      UPDATE message_outbox
      SET applied_payload_hash = ?, last_error = NULL, updated_at_ms = ?
      WHERE id = ? AND message_kind = 'radar' AND status = 'SENT'
    `).run(hash, atMs, id);
    if (result.changes !== 1) throw new Error('radar payload cannot be marked applied');
    return this.findById(id)!;
  }

  updatePendingChannelRole(
    id: number,
    channelRole: 'validation' | 'formal',
    atMs = Date.now()
  ): OutboxRecord {
    const result = this.database
      .prepare(`
        UPDATE message_outbox
        SET channel_role = ?, updated_at_ms = ?
        WHERE id = ? AND message_kind = 'signal' AND status = 'PENDING'
      `)
      .run(channelRole, atMs, id);
    if (result.changes !== 1) throw new Error('signal outbox channel role is not updateable');
    return this.findById(id)!;
  }

  markUncertain(id: number, safeError: string, atMs = Date.now()): OutboxRecord {
    const result = this.database
      .prepare(`
        UPDATE message_outbox
        SET status = 'UNCERTAIN', last_error = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'SENDING'
      `)
      .run(safeError, atMs, id);
    if (result.changes !== 1) throw new Error('outbox record is not sending');
    return this.findById(id)!;
  }

  markExplicitFailure(id: number, safeError: string, atMs = Date.now()): OutboxRecord {
    const result = this.database
      .prepare(`
        UPDATE message_outbox
        SET status = 'PENDING', last_error = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'SENDING'
      `)
      .run(safeError, atMs, id);
    if (result.changes !== 1) throw new Error('outbox record is not sending');
    return this.findById(id)!;
  }

  recoverInterruptedSends(atMs = Date.now()): number {
    const result = this.database
      .prepare(`
        UPDATE message_outbox
        SET status = 'UNCERTAIN', last_error = 'process_interrupted_while_sending',
            updated_at_ms = ?
        WHERE status = 'SENDING'
      `)
      .run(atMs);
    return Number(result.changes);
  }

  private findById(id: number): OutboxRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM message_outbox WHERE id = ?')
      .get(id) as OutboxRow | undefined;
    return row === undefined ? undefined : toOutbox(row);
  }
}

export type SignalDisplayState = 'ACTIVE' | 'DONT_CHASE' | 'EXPIRED' | 'INVALID';

export interface SignalFollowupRecord {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly outboxId: number;
  readonly preSendPriceUsd: number;
  readonly preSendTradeAtMs: number;
  readonly receiptAtMs: number;
  readonly expiresAtMs: number;
  readonly desiredState: SignalDisplayState;
  readonly appliedState: SignalDisplayState;
  readonly desiredReason: string | null;
  readonly snapshot: unknown;
  readonly editAttemptCount: number;
  readonly lastEditError: string | null;
}

interface SignalFollowupRow {
  chain: Chain;
  token_address: string;
  outbox_id: number;
  pre_send_price_usd: number;
  pre_send_trade_at_ms: number;
  receipt_at_ms: number;
  expires_at_ms: number;
  desired_state: SignalDisplayState;
  applied_state: SignalDisplayState;
  desired_reason: string | null;
  snapshot_json: string;
  edit_attempt_count: number;
  last_edit_error: string | null;
}

function toSignalFollowup(row: SignalFollowupRow): SignalFollowupRecord {
  return {
    chain: row.chain,
    tokenAddress: row.token_address,
    outboxId: row.outbox_id,
    preSendPriceUsd: row.pre_send_price_usd,
    preSendTradeAtMs: row.pre_send_trade_at_ms,
    receiptAtMs: row.receipt_at_ms,
    expiresAtMs: row.expires_at_ms,
    desiredState: row.desired_state,
    appliedState: row.applied_state,
    desiredReason: row.desired_reason,
    snapshot: JSON.parse(row.snapshot_json) as unknown,
    editAttemptCount: row.edit_attempt_count,
    lastEditError: row.last_edit_error
  };
}

export class SignalFollowupRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(input: {
    readonly chain: Chain;
    readonly tokenAddress: string;
    readonly outboxId: number;
    readonly preSendPriceUsd: number;
    readonly preSendTradeAtMs: number;
    readonly receiptAtMs: number;
    readonly snapshot: unknown;
  }): SignalFollowupRecord {
    const token = normalizeAddress(input.chain, input.tokenAddress);
    this.database
      .prepare(`
        INSERT INTO signal_followups(
          chain, token_address, outbox_id, pre_send_price_usd,
          pre_send_trade_at_ms, receipt_at_ms, expires_at_ms,
          desired_state, applied_state, snapshot_json, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'ACTIVE', ?, ?)
      `)
      .run(
        input.chain,
        token,
        input.outboxId,
        input.preSendPriceUsd,
        input.preSendTradeAtMs,
        input.receiptAtMs,
        input.receiptAtMs + 90_000,
        stableJsonStringify(input.snapshot),
        input.receiptAtMs
      );
    for (const checkpoint of [30, 60] as const) {
      const dueAtMs = input.receiptAtMs + checkpoint * 1_000;
      this.database
        .prepare(`
          INSERT INTO signal_rechecks(
            chain, token_address, checkpoint_seconds, due_at_ms,
            next_attempt_at_ms, status, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
        `)
        .run(input.chain, token, checkpoint, dueAtMs, dueAtMs, input.receiptAtMs);
    }
    return this.find(input.chain, token)!;
  }

  find(chain: Chain, tokenAddress: string): SignalFollowupRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM signal_followups WHERE chain = ? AND token_address = ?')
      .get(chain, normalizeAddress(chain, tokenAddress)) as SignalFollowupRow | undefined;
    return row === undefined ? undefined : toSignalFollowup(row);
  }

  listOpen(): readonly SignalFollowupRecord[] {
    return (this.database
      .prepare("SELECT * FROM signal_followups WHERE desired_state IN ('ACTIVE', 'DONT_CHASE')")
      .all() as unknown as SignalFollowupRow[]).map(toSignalFollowup);
  }

  listPendingEdits(): readonly SignalFollowupRecord[] {
    return (this.database
      .prepare('SELECT * FROM signal_followups WHERE desired_state <> applied_state')
      .all() as unknown as SignalFollowupRow[]).map(toSignalFollowup);
  }

  setDesired(
    chain: Chain,
    tokenAddress: string,
    state: SignalDisplayState,
    reason: string,
    atMs = Date.now()
  ): SignalFollowupRecord {
    const priority: Readonly<Record<SignalDisplayState, number>> = {
      ACTIVE: 0,
      DONT_CHASE: 1,
      EXPIRED: 2,
      INVALID: 3
    };
    const result = this.database
      .prepare(`
        UPDATE signal_followups
        SET desired_state = ?, desired_reason = ?, updated_at_ms = ?
        WHERE chain = ? AND token_address = ?
          AND CASE desired_state
            WHEN 'ACTIVE' THEN 0
            WHEN 'DONT_CHASE' THEN 1
            WHEN 'EXPIRED' THEN 2
            WHEN 'INVALID' THEN 3
          END <= ?
      `)
      .run(
        state,
        reason,
        atMs,
        chain,
        normalizeAddress(chain, tokenAddress),
        priority[state]
      );
    const current = this.find(chain, tokenAddress);
    if (current === undefined) throw new Error('signal followup not found');
    if (result.changes === 0) return current;
    return current;
  }

  markApplied(
    chain: Chain,
    tokenAddress: string,
    appliedState: SignalDisplayState,
    atMs = Date.now()
  ): SignalFollowupRecord {
    this.database
      .prepare(`
        UPDATE signal_followups
        SET applied_state = ?, edit_attempt_count = edit_attempt_count + 1,
            last_edit_error = NULL, updated_at_ms = ?
        WHERE chain = ? AND token_address = ?
      `)
      .run(appliedState, atMs, chain, normalizeAddress(chain, tokenAddress));
    return this.find(chain, tokenAddress)!;
  }

  markEditFailure(
    chain: Chain,
    tokenAddress: string,
    safeError: string,
    atMs = Date.now()
  ): SignalFollowupRecord {
    this.database
      .prepare(`
        UPDATE signal_followups
        SET edit_attempt_count = edit_attempt_count + 1, last_edit_error = ?, updated_at_ms = ?
        WHERE chain = ? AND token_address = ?
      `)
      .run(safeError, atMs, chain, normalizeAddress(chain, tokenAddress));
    return this.find(chain, tokenAddress)!;
  }
}

export interface SignalRecheckRecord {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly checkpointSeconds: 30 | 60;
  readonly status: 'PENDING' | 'RETRY' | 'COMPLETE';
  readonly attemptCount: number;
  readonly nextAttemptAtMs: number;
  readonly lastError: string | null;
}

export class SignalRecheckRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listDue(nowMs: number): readonly SignalRecheckRecord[] {
    const rows = this.database
      .prepare(`
        SELECT chain, token_address, checkpoint_seconds, status,
               attempt_count, next_attempt_at_ms, last_error
        FROM signal_rechecks
        WHERE status IN ('PENDING', 'RETRY') AND next_attempt_at_ms <= ?
        ORDER BY next_attempt_at_ms, chain, token_address
      `)
      .all(nowMs) as unknown as Array<{
        chain: Chain;
        token_address: string;
        checkpoint_seconds: 30 | 60;
        status: 'PENDING' | 'RETRY';
        attempt_count: number;
        next_attempt_at_ms: number;
        last_error: string | null;
      }>;
    return rows.map((row) => ({
      chain: row.chain,
      tokenAddress: row.token_address,
      checkpointSeconds: row.checkpoint_seconds,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAtMs: row.next_attempt_at_ms,
      lastError: row.last_error
    }));
  }

  markComplete(input: SignalRecheckRecord, atMs = Date.now()): void {
    this.database
      .prepare(`
        UPDATE signal_rechecks SET status = 'COMPLETE', attempt_count = attempt_count + 1,
            last_error = NULL, updated_at_ms = ?
        WHERE chain = ? AND token_address = ? AND checkpoint_seconds = ?
          AND status IN ('PENDING', 'RETRY')
      `)
      .run(atMs, input.chain, input.tokenAddress, input.checkpointSeconds);
  }

  markFailure(input: SignalRecheckRecord, safeError: string, atMs = Date.now()): boolean {
    const finalFailure = input.status === 'RETRY';
    this.database
      .prepare(`
        UPDATE signal_rechecks
        SET status = ?, attempt_count = attempt_count + 1,
            next_attempt_at_ms = ?, last_error = ?, updated_at_ms = ?
        WHERE chain = ? AND token_address = ? AND checkpoint_seconds = ?
          AND status = ?
      `)
      .run(
        finalFailure ? 'COMPLETE' : 'RETRY',
        atMs + 3_000,
        safeError,
        atMs,
        input.chain,
        input.tokenAddress,
        input.checkpointSeconds,
        input.status
      );
    return finalFailure;
  }
}
