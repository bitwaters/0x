import type { Chain, RuntimeConfig } from '../config.js';
import type { SqliteDatabase } from '../db/database.js';
import { withTransaction } from '../db/database.js';
import { normalizeAddress } from '../domain/address.js';
import type {
  CoinGeckoClient,
  CoinGeckoOhlcvBar,
  CoinGeckoPoolDetail,
  CoinGeckoTrade,
  FixedPoolBinding
} from '../providers/coingecko.js';
import type { GmgnClient, GmgnTokenSecurity } from '../providers/gmgn.js';
import {
  evaluateGmgnTokenSecurity,
  gmgnThresholds
} from '../providers/gmgn.js';
import { ProviderRequestError } from '../providers/http.js';
import { formatSafeError } from '../security/redaction.js';
import {
  EvaluationRepository,
  type ChainReleaseRecord,
  type DeliveredSignalSample,
  type EvaluationPointRecord,
  type StoredPathResult
} from './repository.js';
import {
  EVALUATION_POLICY,
  ohlcvRequestForHorizon
} from './policy.js';
import {
  evaluateOhlcvPath,
  evaluateTradePath,
  firstSellTradeAt,
  isEntryWindowCovered,
  mergePathMetrics,
  selectEntryTrade
} from './rules.js';

export interface EvaluationCoinGeckoSource {
  getPoolDetail(
    chain: Chain,
    poolAddress: string,
    candidateTokenAddress: string,
    signal?: AbortSignal
  ): Promise<CoinGeckoPoolDetail>;
  getPoolTrades(
    binding: FixedPoolBinding,
    signal?: AbortSignal
  ): Promise<readonly CoinGeckoTrade[]>;
  getPoolOhlcv(input: {
    readonly binding: FixedPoolBinding;
    readonly timeframe: 'second' | 'minute' | 'hour' | 'day';
    readonly aggregate: 1 | 4 | 5 | 12 | 15 | 30;
    readonly limit?: number;
    readonly beforeTimestampSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly CoinGeckoOhlcvBar[]>;
}

export interface EvaluationGmgnSource {
  getTokenSecurity(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<GmgnTokenSecurity>;
}

export class EvaluationService {
  private readonly repository: EvaluationRepository;
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly config: RuntimeConfig,
    private readonly coinGecko: EvaluationCoinGeckoSource | CoinGeckoClient,
    private readonly gmgn: EvaluationGmgnSource | GmgnClient,
    private readonly now: () => number = Date.now
  ) {
    this.repository = new EvaluationRepository(database);
  }

  signalRole(chain: Chain): 'validation' | 'formal' | undefined {
    const state = this.repository.chainState(chain).state;
    if (state === 'VALIDATING') return 'validation';
    if (state === 'BETA') return 'formal';
    return undefined;
  }

  async tick(signal?: AbortSignal): Promise<void> {
    for (const point of this.repository.listDue(this.now())) {
      await this.processOnce(point, signal);
    }
    for (const chain of ['sol', 'bsc'] as const) {
      withTransaction(this.database, () => {
        this.repository.maybePromoteBeta(chain, this.now());
      });
    }
  }

  suspendForCriticalError(chain: Chain, reason: string): void {
    withTransaction(this.database, () => {
      this.repository.suspend(chain, reason, this.now());
    });
  }

  resumeAfterFix(chain: Chain): ChainReleaseRecord {
    return withTransaction(this.database, () =>
      this.repository.resumeAfterFix(chain, this.now())
    );
  }

  report(chain: Chain): unknown {
    return this.repository.liveReport(chain, this.now());
  }

  progress(chain: Chain) {
    return this.repository.progress(chain, this.now());
  }

  private async processOnce(
    point: EvaluationPointRecord,
    signal?: AbortSignal
  ): Promise<void> {
    const existing = this.inFlight.get(point.id);
    if (existing !== undefined) return existing;
    const work = this.processPoint(point, signal).finally(() => {
      if (this.inFlight.get(point.id) === work) this.inFlight.delete(point.id);
    });
    this.inFlight.set(point.id, work);
    return work;
  }

  private async processPoint(
    point: EvaluationPointRecord,
    signal?: AbortSignal
  ): Promise<void> {
    const sample = this.repository.findSample(point.sampleId);
    if (sample === undefined) throw new Error('evaluation sample not found');
    if (point.horizonSeconds === 10) {
      const entryTradeMaxDelayMs =
        point.entryTradeMaxDelayMs ?? EVALUATION_POLICY.entryTradeMaxDelayMs;
      const entryWindowEndAtMs = point.scheduledAtMs + entryTradeMaxDelayMs;
      if (this.now() < entryWindowEndAtMs) {
        withTransaction(this.database, () => {
          this.repository.deferEntryUntil(point, entryWindowEndAtMs, this.now());
        });
        return;
      }
      if (
        point.entryPolicyVersion !== EVALUATION_POLICY.entryPolicyVersion ||
        point.entryTradeMaxDelayMs === null ||
        sample.decisionRuleVersion !== this.config.ruleVersion
      ) {
        withTransaction(this.database, () => {
          this.repository.markEntryProviderMissing(
            point,
            'ENTRY_POLICY_UNAVAILABLE',
            this.now()
          );
        });
        return;
      }
    }
    if (point.horizonSeconds !== 10 && sample.entryStatus !== 'COMPLETE') return;
    const prefix =
      point.horizonSeconds > EVALUATION_POLICY.tradesPathCutoffSeconds
        ? this.repository.pathResult(
            sample.id,
            EVALUATION_POLICY.tradesPathCutoffSeconds
          )
        : undefined;
    if (
      point.horizonSeconds > EVALUATION_POLICY.tradesPathCutoffSeconds &&
      prefix === undefined
    ) {
      withTransaction(this.database, () => {
        this.repository.markFailure(point, '90-second trades prefix unavailable', this.now());
      });
      return;
    }
    const snapshot = sample.snapshot.eligibility;
    try {
      const [detail, security] = await Promise.all([
        this.coinGecko.getPoolDetail(
          sample.chain,
          snapshot.pool.poolAddress,
          sample.tokenAddress,
          signal
        ),
        this.gmgn.getTokenSecurity(sample.chain, sample.tokenAddress, signal)
      ]);
      if (!this.samePool(snapshot.pool, detail)) {
        this.suspendForCriticalError(sample.chain, 'EVALUATION_POOL_COMPOSITION_MISMATCH');
        this.markTerminal(sample, 'POOL_COMPOSITION_CHANGED');
        return;
      }
      if (detail.reserveUsd <= 0) {
        this.markTerminal(sample, 'POOL_LIQUIDITY_ZERO');
        return;
      }
      if (
        security.chain !== sample.chain ||
        normalizeAddress(sample.chain, security.tokenAddress) !== sample.tokenAddress
      ) {
        this.suspendForCriticalError(sample.chain, 'EVALUATION_SECURITY_IDENTITY_MISMATCH');
        this.markTerminal(sample, 'SECURITY_IDENTITY_CHANGED');
        return;
      }
      const securityDecision = evaluateGmgnTokenSecurity({
        chain: sample.chain,
        security,
        thresholds: gmgnThresholds(this.config),
        nowMs: this.now()
      });
      if (!securityDecision.passed) {
        this.markTerminal(sample, securityDecision.reasons[0]!);
        return;
      }
      if (point.horizonSeconds <= EVALUATION_POLICY.tradesPathCutoffSeconds) {
        await this.evaluateTrades(point, sample, detail, securityDecision.normalized, signal);
      } else {
        await this.evaluateOhlcv(
          point,
          sample,
          detail,
          securityDecision.normalized,
          prefix!,
          signal
        );
      }
    } catch (error) {
      if (
        error instanceof ProviderRequestError &&
        error.provider === 'coingecko' &&
        error.operation === 'pool_detail' &&
        error.status === 404
      ) {
        this.markTerminal(sample, 'FIXED_POOL_MISSING');
        return;
      }
      withTransaction(this.database, () => {
        this.repository.markFailure(point, this.safeError(error), this.now());
      });
    }
  }

  private async evaluateTrades(
    point: EvaluationPointRecord,
    sample: DeliveredSignalSample,
    detail: CoinGeckoPoolDetail,
    security: Readonly<Record<string, number | boolean>>,
    signal?: AbortSignal
  ): Promise<void> {
    const trades = await this.coinGecko.getPoolTrades(detail, signal);
    const targetAtMs = point.scheduledAtMs;
    const sellAtMs = firstSellTradeAt(trades, sample.receiptAtMs, targetAtMs);
    if (point.horizonSeconds === 10) {
      const entryWindowCovered = isEntryWindowCovered(
        trades,
        targetAtMs,
        EVALUATION_POLICY.poolTradesPageSize
      );
      if (!entryWindowCovered) {
        withTransaction(this.database, () => {
          this.repository.markEntryProviderMissing(
            point,
            'ENTRY_WINDOW_NOT_COVERED',
            this.now()
          );
        });
        return;
      }
      const entry = selectEntryTrade(
        trades,
        targetAtMs,
        point.entryTradeMaxDelayMs!
      );
      withTransaction(this.database, () => {
        if (entry === undefined) {
          this.repository.markEntryUnavailable(point, this.now());
        } else {
          this.repository.completeEntry({
            point,
            priceUsd: entry.candidatePriceUsd,
            tradeAtMs: entry.blockTimestampMs,
            ...(sellAtMs === undefined ? {} : { sellAtMs }),
            observedAtMs: this.now(),
            facts: {
              entryTargetAtMs: targetAtMs,
              entryTradeAtMs: entry.blockTimestampMs,
              entryDelayMs: entry.blockTimestampMs - targetAtMs,
              reserveUsd: detail.reserveUsd,
              security,
              sellTradeObserved: sellAtMs !== undefined
            }
          });
        }
        this.repository.maybePromoteBeta(sample.chain, this.now());
      });
      return;
    }
    const result = evaluateTradePath(
      trades,
      sample.entryPriceUsd!,
      sample.entryTradeAtMs!,
      targetAtMs
    );
    if (result === undefined) throw new Error('CoinGecko trades path is empty');
    withTransaction(this.database, () => {
      if (sellAtMs !== undefined) this.repository.recordSell(sample.id, sellAtMs, this.now());
      this.repository.completePoint(point, result, 'TRADES', 'trade', this.now(), {
        reserveUsd: detail.reserveUsd,
        security,
        sellTradeObserved: sellAtMs !== undefined
      });
      this.repository.maybePromoteBeta(sample.chain, this.now());
    });
  }

  private async evaluateOhlcv(
    point: EvaluationPointRecord,
    sample: DeliveredSignalSample,
    detail: CoinGeckoPoolDetail,
    security: Readonly<Record<string, number | boolean>>,
    prefix: StoredPathResult,
    signal?: AbortSignal
  ): Promise<void> {
    const request = ohlcvRequestForHorizon(point.horizonSeconds);
    const unitMs = request.timeframe === 'second' ? 1_000 : 60_000;
    const granularityMs = unitMs * request.aggregate;
    const closedBoundaryMs = Math.floor(point.scheduledAtMs / granularityMs) * granularityMs;
    const bars = await this.coinGecko.getPoolOhlcv({
      binding: detail,
      ...request,
      beforeTimestampSeconds: Math.floor(closedBoundaryMs / 1_000),
      ...(signal === undefined ? {} : { signal })
    });
    const suffix = evaluateOhlcvPath(
      bars,
      sample.entryPriceUsd!,
      sample.receiptAtMs + EVALUATION_POLICY.tradesPathCutoffSeconds * 1_000,
      point.scheduledAtMs,
      granularityMs
    );
    if (suffix === undefined) throw new Error('CoinGecko OHLCV path is empty');
    const result = mergePathMetrics(prefix, suffix);
    withTransaction(this.database, () => {
      this.repository.completePoint(
        point,
        result,
        'OHLCV',
        `${request.aggregate}-${request.timeframe}`,
        this.now(),
        { reserveUsd: detail.reserveUsd, security }
      );
      this.repository.maybePromoteBeta(sample.chain, this.now());
    });
  }

  private markTerminal(sample: DeliveredSignalSample, reason: string): void {
    withTransaction(this.database, () => {
      this.repository.markTerminalNegative(sample.id, reason, this.now());
      this.repository.maybePromoteBeta(sample.chain, this.now());
    });
  }

  private samePool(expected: CoinGeckoPoolDetail, actual: CoinGeckoPoolDetail): boolean {
    return (
      expected.chain === actual.chain &&
      expected.poolAddress === actual.poolAddress &&
      expected.candidateTokenAddress === actual.candidateTokenAddress &&
      expected.candidateSide === actual.candidateSide &&
      expected.counterTokenAddress === actual.counterTokenAddress &&
      expected.baseTokenAddress === actual.baseTokenAddress &&
      expected.quoteTokenAddress === actual.quoteTokenAddress
    );
  }

  private safeError(error: unknown): string {
    return formatSafeError(error, [
      this.config.providers.gmgnApiKey,
      this.config.providers.coinGeckoApiKey
    ]);
  }
}
