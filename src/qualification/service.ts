import type { Chain, RuntimeConfig } from '../config.js';
import type { SqliteDatabase } from '../db/database.js';
import { withTransaction } from '../db/database.js';
import {
  CandidateRepository,
  PoolBindingRepository,
  QualificationEventRepository,
  type CandidateRecord
} from '../db/repositories.js';
import { normalizeAddress } from '../domain/address.js';
import type {
  CoinGeckoClient,
  CoinGeckoPoolDetail,
  CoinGeckoTrade
} from '../providers/coingecko.js';
import { ContractError } from '../providers/contracts.js';
import type {
  GmgnClient,
  GmgnSecurityDecision,
  GmgnTokenInfo,
  GmgnTokenSecurity,
  GmgnTrendingSnapshot
} from '../providers/gmgn.js';
import { evaluateGmgnSecurity, gmgnThresholds } from '../providers/gmgn.js';
import { ProviderRequestError } from '../providers/http.js';
import { QUALIFICATION_POLICY } from './policy.js';
import {
  activationReasonFromCode,
  type SendEligibilitySnapshot
} from './snapshot.js';
import {
  evaluateLiquiditySample,
  evaluateLiquidityStability,
  evaluateTradeWindow,
  type LiquidityDecision,
  type TradeWindowDecision
} from './rules.js';

export interface QualificationGmgnSource {
  getTrending(
    chain: Chain,
    interval: '1m' | '5m',
    limit?: number,
    signal?: AbortSignal
  ): Promise<GmgnTrendingSnapshot>;
  getTokenInfo(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<GmgnTokenInfo>;
  getTokenSecurity(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<GmgnTokenSecurity>;
}

export interface QualificationCoinGeckoSource {
  getPoolDetail(
    chain: Chain,
    poolAddress: string,
    candidateTokenAddress: string,
    signal?: AbortSignal
  ): Promise<CoinGeckoPoolDetail>;
  getPoolTrades(
    binding: CoinGeckoPoolDetail,
    signal?: AbortSignal
  ): Promise<readonly CoinGeckoTrade[]>;
}

export interface QualificationResult {
  readonly outcome: 'WAIT' | 'ELIGIBLE' | 'REJECTED' | 'EXPIRED';
  readonly reasons: readonly string[];
  readonly pool?: CoinGeckoPoolDetail;
  readonly trades?: TradeWindowDecision;
  readonly liquidity?: LiquidityDecision;
  readonly eligibility?: SendEligibilitySnapshot;
}

interface QualificationState {
  firstDetail: CoinGeckoPoolDetail;
}

interface PoolSubscriptionReference {
  readonly chain: Chain;
  readonly poolAddress: string;
  count: number;
}

export class FixedPoolQualificationService {
  private readonly candidates: CandidateRepository;
  private readonly pools: PoolBindingRepository;
  private readonly events: QualificationEventRepository;
  private readonly states = new Map<string, QualificationState>();
  private readonly inFlight = new Map<string, Promise<QualificationResult>>();
  private readonly tokenPools = new Map<string, string>();
  private readonly poolSubscriptions = new Map<string, PoolSubscriptionReference>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly config: RuntimeConfig,
    private readonly gmgn: QualificationGmgnSource | GmgnClient,
    private readonly coinGecko: QualificationCoinGeckoSource | CoinGeckoClient,
    private readonly now: () => number = Date.now,
    private readonly subscribePool: (chain: Chain, poolAddress: string) => void = () => undefined,
    private readonly releasePool: (chain: Chain, poolAddress: string) => void = () => undefined
  ) {
    this.candidates = new CandidateRepository(database);
    this.pools = new PoolBindingRepository(database);
    this.events = new QualificationEventRepository(database);
  }

  start(nowMs = this.now()): void {
    this.expireWindows(nowMs);
    for (const binding of this.pools.findActive()) {
      if (!this.config.chains[binding.chain]) continue;
      this.ensurePoolSubscribed(binding.chain, binding.tokenAddress, binding.poolAddress);
    }
  }

  async refresh(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<QualificationResult> {
    const token = normalizeAddress(chain, tokenAddress);
    const key = `${chain}:${token}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const work = this.refreshOnce(chain, token, signal).finally(() => {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  private async refreshOnce(
    chain: Chain,
    token: string,
    signal?: AbortSignal
  ): Promise<QualificationResult> {
    if (!this.config.chains[chain]) {
      return { outcome: 'WAIT', reasons: ['CHAIN_DISABLED'] };
    }
    const nowMs = this.now();
    this.expireWindows(nowMs);
    const candidate = this.candidates.find(chain, token);
    if (candidate === undefined) throw new Error('candidate not found');
    const initialTerminal = this.terminalResult(candidate);
    if (initialTerminal !== undefined) return initialTerminal;
    if (!['PREHEAT', 'POOL_BOUND', 'MONITORING'].includes(candidate.status)) {
      return { outcome: 'WAIT', reasons: ['CANDIDATE_NOT_READY'] };
    }

    let trending: GmgnTrendingSnapshot;
    let info: GmgnTokenInfo;
    let security: GmgnTokenSecurity;
    try {
      [trending, info, security] = await Promise.all([
        this.gmgn.getTrending(chain, '1m', 100, signal),
        this.gmgn.getTokenInfo(chain, token, signal),
        this.gmgn.getTokenSecurity(chain, token, signal)
      ]);
    } catch (error) {
      if (error instanceof ContractError) {
        return this.reject(chain, token, 'GMGN_CONTRACT_ERROR', {
          operation: error.operation,
          field: error.field,
          error: error.message
        });
      }
      return this.providerFailure(error);
    }

    const factsAtMs = this.now();
    this.expireWindows(factsAtMs);
    const afterGmgn = this.candidates.find(chain, token)!;
    const afterGmgnTerminal = this.terminalResult(afterGmgn);
    if (afterGmgnTerminal !== undefined) return afterGmgnTerminal;
    if (trending.chain !== chain || trending.interval !== '1m') {
      return this.reject(chain, token, 'GMGN_CONTRACT_ERROR', {
        chain: trending.chain,
        interval: trending.interval
      });
    }
    const matchingItems = trending.items.filter(
      (item) => normalizeAddress(chain, item.tokenAddress) === token
    );
    if (matchingItems.length > 1) {
      return this.reject(chain, token, 'GMGN_CONTRACT_ERROR', {
        reason: 'duplicate candidate in qualification rank',
        items: matchingItems.map((item) => item.raw)
      });
    }
    const latest = matchingItems[0];
    if (latest === undefined) return { outcome: 'WAIT', reasons: ['NOT_ON_LATEST_RANK'] };
    if (
      info.chain !== chain ||
      info.tokenAddress !== token ||
      info.fetchedAtMs > factsAtMs + QUALIFICATION_POLICY.allowedClockSkewMs
    ) {
      return this.reject(chain, token, 'TOKEN_INFO_CONTRACT_ERROR', {
        info: info.raw
      });
    }
    if (factsAtMs - info.fetchedAtMs > QUALIFICATION_POLICY.tokenInfoMaxAgeMs) {
      return { outcome: 'WAIT', reasons: ['TOKEN_INFO_STALE'] };
    }
    if (
      trending.fetchedAtMs > factsAtMs + QUALIFICATION_POLICY.allowedClockSkewMs ||
      factsAtMs - trending.fetchedAtMs > QUALIFICATION_POLICY.trendingMaxAgeMs ||
      security.fetchedAtMs > factsAtMs + QUALIFICATION_POLICY.allowedClockSkewMs ||
      factsAtMs - security.fetchedAtMs > QUALIFICATION_POLICY.securityMaxAgeMs
    ) {
      return { outcome: 'WAIT', reasons: ['GMGN_FACTS_STALE'] };
    }
    if (
      latest.marketCapUsd < this.config.thresholds.marketCapMinUsd ||
      latest.marketCapUsd > this.config.thresholds.marketCapMaxUsd
    ) {
      return this.reject(chain, token, 'MARKET_CAP_OUT_OF_RANGE', {
        marketCapUsd: latest.marketCapUsd
      });
    }
    const observed = this.candidates.updateHighWater({
      chain,
      tokenAddress: token,
      observedPriceUsd: latest.priceUsd,
      maxGainRatio: this.config.thresholds.maxObservedGainRatio,
      decisionRuleVersion: this.config.ruleVersion,
      observedAtMs: trending.fetchedAtMs,
      raw: latest.raw
    });
    const observedTerminal = this.terminalResult(observed);
    if (observedTerminal !== undefined) return observedTerminal;

    let securityDecision: GmgnSecurityDecision;
    try {
      securityDecision = evaluateGmgnSecurity({
        chain,
        trending: latest,
        trendingFetchedAtMs: trending.fetchedAtMs,
        security,
        thresholds: gmgnThresholds(this.config),
        nowMs: factsAtMs
      });
      if (!securityDecision.passed) {
        return this.reject(chain, token, securityDecision.reasons[0]!, {
          raw: securityDecision.raw,
          normalized: securityDecision.normalized
        });
      }
    } catch (error) {
      if (error instanceof ContractError) {
        if (error.field.endsWith('fetched_at')) {
          return { outcome: 'WAIT', reasons: ['GMGN_FACTS_STALE'] };
        }
        return this.reject(chain, token, 'SECURITY_CONTRACT_ERROR', {
          error: error.message
        });
      }
      throw error;
    }

    if (info.biggestPoolAddress === null) {
      return this.reject(chain, token, 'MAIN_POOL_MISSING', { info: info.raw });
    }
    if (info.openAtMs === null) {
      return this.reject(chain, token, 'MAIN_POOL_NOT_OPEN', { info: info.raw });
    }
    if (
      info.poolCreatedAtMs === null ||
      info.poolCreatedAtMs > factsAtMs ||
      factsAtMs - info.poolCreatedAtMs > this.config.thresholds.poolAgeMaxSeconds * 1_000
    ) {
      return this.reject(chain, token, 'POOL_AGE_OUT_OF_RANGE', { info: info.raw });
    }
    if (
      info.liquidityUsd === null ||
      info.liquidityUsd < this.config.thresholds.liquidityMinUsd
    ) {
      return this.reject(chain, token, 'GMGN_LIQUIDITY_LOW', { info: info.raw });
    }
    let persisted = this.pools.find(chain, token);
    if (persisted !== undefined && persisted.poolAddress !== info.biggestPoolAddress) {
      return this.reject(chain, token, 'MAIN_POOL_CHANGED', {
        expected: persisted.poolAddress,
        received: info.biggestPoolAddress
      });
    }

    let detail: CoinGeckoPoolDetail;
    try {
      detail = await this.coinGecko.getPoolDetail(
        chain,
        info.biggestPoolAddress,
        token,
        signal
      );
    } catch (error) {
      if (error instanceof ContractError || (error instanceof ProviderRequestError && error.status === 404)) {
        return this.reject(chain, token, 'FIXED_POOL_INVALID', {
          error: error instanceof Error ? error.message : 'unknown'
        });
      }
      return this.providerFailure(error);
    }

    this.expireWindows(this.now());
    const afterDetail = this.candidates.find(chain, token)!;
    const afterDetailTerminal = this.terminalResult(afterDetail);
    if (afterDetailTerminal !== undefined) return afterDetailTerminal;

    if (
      persisted !== undefined &&
      (persisted.candidateSide !== detail.candidateSide ||
        persisted.counterTokenAddress !== detail.counterTokenAddress)
    ) {
      return this.reject(chain, token, 'POOL_COMPOSITION_CHANGED', { detail: detail.raw });
    }

    const sample = evaluateLiquiditySample(detail, this.config.thresholds.liquidityMinUsd);
    if (!sample.passed) {
      return this.reject(chain, token, sample.reasons[0]!, {
        detail: detail.raw,
        sample
      });
    }

    const key = `${chain}:${token}`;
    let state = this.states.get(key);
    if (persisted === undefined) {
      const created = this.pools.bind({
        chain,
        tokenAddress: token,
        poolAddress: detail.poolAddress,
        candidateSide: detail.candidateSide,
        counterTokenAddress: detail.counterTokenAddress,
        boundAtMs: detail.fetchedAtMs,
        evidence: {
          raw: { gmgn: info.raw, coingecko: detail.raw },
          normalized: {
            poolAddress: detail.poolAddress,
            candidateSide: detail.candidateSide,
            counterTokenAddress: detail.counterTokenAddress
          },
          thresholds: {
            liquidityMinUsd: this.config.thresholds.liquidityMinUsd,
            qualificationPolicy: QUALIFICATION_POLICY
          },
          decisionRuleVersion: this.config.ruleVersion
        }
      });
      persisted = this.pools.find(chain, token)!;
      if (created) {
        this.ensurePoolSubscribed(chain, token, detail.poolAddress);
        state = { firstDetail: detail };
        this.states.set(key, state);
        return { outcome: 'WAIT', reasons: ['SECOND_DETAIL_REQUIRED'], pool: detail };
      }
    }
    this.ensurePoolSubscribed(chain, token, persisted.poolAddress);
    if (state === undefined) {
      state = { firstDetail: detail };
      this.states.set(key, state);
      return { outcome: 'WAIT', reasons: ['SECOND_DETAIL_REQUIRED_AFTER_RESTART'], pool: detail };
    }

    const liquidity = evaluateLiquidityStability({
      first: state.firstDetail,
      second: detail,
      liquidityMinUsd: this.config.thresholds.liquidityMinUsd
    });
    if (liquidity.outcome === 'WAIT') {
      return { outcome: 'WAIT', reasons: liquidity.reasons, pool: detail, liquidity };
    }
    if (liquidity.outcome === 'REJECT') {
      return this.reject(chain, token, liquidity.reasons[0]!, {
        liquidity,
        first: state.firstDetail.raw,
        second: detail.raw
      });
    }

    let trades: TradeWindowDecision;
    try {
      const rawTrades = await this.coinGecko.getPoolTrades(detail, signal);
      trades = evaluateTradeWindow(rawTrades, this.now());
    } catch (error) {
      if (error instanceof ContractError) {
        return this.reject(chain, token, 'TRADES_CONTRACT_ERROR', {
          error: error.message
        });
      }
      return this.providerFailure(error);
    }
    if (!trades.passed) {
      if (trades.reasons.includes('TRADE_ID_CONFLICT')) {
        return this.reject(chain, token, 'TRADE_ID_CONFLICT', {
          trades: trades.trades.map((trade) => trade.raw)
        });
      }
      return { outcome: 'WAIT', reasons: trades.reasons, pool: detail, trades, liquidity };
    }

    const finalAtMs = this.now();
    this.expireWindows(finalAtMs);
    const current = this.candidates.find(chain, token)!;
    const finalTerminal = this.terminalResult(current);
    if (finalTerminal !== undefined) return { ...finalTerminal, pool: detail, trades, liquidity };
    if (
      finalAtMs - trending.fetchedAtMs > QUALIFICATION_POLICY.trendingMaxAgeMs ||
      trending.fetchedAtMs > finalAtMs + QUALIFICATION_POLICY.allowedClockSkewMs ||
      finalAtMs - info.fetchedAtMs > QUALIFICATION_POLICY.tokenInfoMaxAgeMs ||
      info.fetchedAtMs > finalAtMs + QUALIFICATION_POLICY.allowedClockSkewMs ||
      finalAtMs - security.fetchedAtMs > QUALIFICATION_POLICY.securityMaxAgeMs ||
      security.fetchedAtMs > finalAtMs + QUALIFICATION_POLICY.allowedClockSkewMs
    ) {
      return { outcome: 'WAIT', reasons: ['GMGN_FACTS_STALE'], pool: detail, trades, liquidity };
    }
    if (
      info.poolCreatedAtMs === null ||
      info.poolCreatedAtMs > finalAtMs ||
      finalAtMs - info.poolCreatedAtMs > this.config.thresholds.poolAgeMaxSeconds * 1_000
    ) {
      return this.reject(chain, token, 'POOL_AGE_OUT_OF_RANGE', { info: info.raw });
    }
    const activationReason = activationReasonFromCode(
      this.events.findFirstActivationReasonCode(chain, token)
    );
    const eligibility: SendEligibilitySnapshot = Object.freeze({
      chain,
      tokenAddress: token,
      pool: detail,
      decisionPriceUsd: trades.decisionPriceUsd!,
      decisionTradeAtMs: trades.latestTradeAtMs!,
      firstSeenAtMs: current.firstSeenAtMs,
      sampledMaxGain: current.sampledMaxGain,
      security: securityDecision.normalized,
      trades,
      liquidity,
      ruleVersion: this.config.ruleVersion,
      qualifiedAtMs: finalAtMs,
      validUntilMs: Math.min(
        trending.fetchedAtMs + QUALIFICATION_POLICY.trendingMaxAgeMs,
        info.fetchedAtMs + QUALIFICATION_POLICY.tokenInfoMaxAgeMs,
        security.fetchedAtMs + QUALIFICATION_POLICY.securityMaxAgeMs
      ),
      ...(activationReason === undefined
        ? {}
        : {
            presentation: {
              name: latest.name,
              symbol: latest.symbol,
              marketCapUsd: latest.marketCapUsd,
              rank: latest.rank,
              currentGain: latest.priceUsd / current.firstSeenPriceUsd - 1,
              activationReason
            }
          })
    });
    if (
      current.status === 'POOL_BOUND' ||
      current.decisionRuleVersion !== this.config.ruleVersion
    ) {
      withTransaction(this.database, () => {
        this.candidates.setDecisionRuleVersion(
          chain,
          token,
          this.config.ruleVersion,
          finalAtMs
        );
        if (current.status === 'POOL_BOUND') {
          this.candidates.transition(chain, token, 'MONITORING', { atMs: finalAtMs });
        }
        this.events.record({
          chain,
          tokenAddress: token,
          stage: 'fixed_pool_qualification',
          outcome: 'PASS',
          reasonCode: 'ELIGIBLE_FOR_SEND_CHECK',
          source: 'coingecko',
          observedAtMs: finalAtMs,
          raw: {
            gmgn: {
              trending: latest.raw,
              tokenInfo: info.raw,
              security: security.raw
            },
            poolDetails: [state.firstDetail.raw, detail.raw],
            trades: trades.trades.map((trade) => trade.raw)
          },
          normalized: {
            marketCapUsd: latest.marketCapUsd,
            gmgnLiquidityUsd: info.liquidityUsd,
            security: securityDecision.normalized,
            trades,
            liquidity
          },
          thresholds: {
            marketCapMinUsd: this.config.thresholds.marketCapMinUsd,
            marketCapMaxUsd: this.config.thresholds.marketCapMaxUsd,
            liquidityMinUsd: this.config.thresholds.liquidityMinUsd,
            poolAgeMaxSeconds: this.config.thresholds.poolAgeMaxSeconds,
            security: gmgnThresholds(this.config),
            qualification: QUALIFICATION_POLICY
          },
          decisionRuleVersion: this.config.ruleVersion
        });
      });
    }
    return { outcome: 'ELIGIBLE', reasons: [], pool: detail, trades, liquidity, eligibility };
  }

  private providerFailure(error: unknown): QualificationResult {
    return {
      outcome: 'WAIT',
      reasons: [error instanceof Error ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_UNKNOWN_ERROR']
    };
  }

  expireWindows(nowMs = this.now()): readonly CandidateRecord[] {
    const expired = this.candidates.expireQualificationWindows({
      nowMs,
      windowSeconds: this.config.thresholds.qualificationWindowSeconds,
      decisionRuleVersion: this.config.ruleVersion
    });
    this.releaseExpiredCandidates(expired);
    return expired;
  }

  releaseExpiredCandidates(candidates: readonly CandidateRecord[]): void {
    for (const candidate of candidates) {
      if (candidate.status === 'EXPIRED') {
        this.releaseBoundPool(candidate.chain, candidate.tokenAddress);
      }
    }
  }

  retainSignalSubscription(chain: Chain, tokenAddress: string, poolAddress: string): void {
    this.ensurePoolSubscribed(chain, normalizeAddress(chain, tokenAddress), poolAddress);
  }

  releaseCandidateSubscription(chain: Chain, tokenAddress: string): void {
    this.releaseBoundPool(chain, normalizeAddress(chain, tokenAddress));
  }

  releaseTerminalSubscriptions(): void {
    for (const tokenKey of [...this.tokenPools.keys()]) {
      const separator = tokenKey.indexOf(':');
      const chain = tokenKey.slice(0, separator) as Chain;
      const tokenAddress = tokenKey.slice(separator + 1);
      const candidate = this.candidates.find(chain, tokenAddress);
      if (
        candidate === undefined ||
        candidate.status === 'REJECTED' ||
        candidate.status === 'EXPIRED'
      ) {
        this.releaseBoundPool(chain, tokenAddress);
      }
    }
  }

  private terminalResult(candidate: CandidateRecord): QualificationResult | undefined {
    if (candidate.status === 'EXPIRED') {
      this.releaseBoundPool(candidate.chain, candidate.tokenAddress);
      return { outcome: 'EXPIRED', reasons: ['WINDOW_EXPIRED'] };
    }
    if (candidate.status === 'REJECTED' || candidate.status === 'SIGNAL_SENT') {
      if (candidate.status === 'REJECTED') {
        this.releaseBoundPool(candidate.chain, candidate.tokenAddress);
      }
      return { outcome: 'REJECTED', reasons: [candidate.terminalReason ?? candidate.status] };
    }
    return undefined;
  }

  private releaseBoundPool(chain: Chain, tokenAddress: string): void {
    const tokenKey = `${chain}:${tokenAddress}`;
    const poolKey = this.tokenPools.get(tokenKey);
    if (poolKey === undefined) return;
    this.tokenPools.delete(tokenKey);
    this.states.delete(tokenKey);
    const reference = this.poolSubscriptions.get(poolKey)!;
    reference.count -= 1;
    if (reference.count === 0) {
      this.poolSubscriptions.delete(poolKey);
      this.releasePool(reference.chain, reference.poolAddress);
    }
  }

  private ensurePoolSubscribed(
    chain: Chain,
    tokenAddress: string,
    poolAddress: string
  ): void {
    const tokenKey = `${chain}:${tokenAddress}`;
    const normalizedPool = normalizeAddress(chain, poolAddress);
    const poolKey = `${chain}:${normalizedPool}`;
    const existingPool = this.tokenPools.get(tokenKey);
    if (existingPool !== undefined) {
      if (existingPool !== poolKey) throw new Error('candidate subscription pool changed');
      return;
    }
    const reference = this.poolSubscriptions.get(poolKey);
    if (reference === undefined) {
      this.subscribePool(chain, normalizedPool);
      this.poolSubscriptions.set(poolKey, { chain, poolAddress: normalizedPool, count: 1 });
    } else {
      reference.count += 1;
    }
    this.tokenPools.set(tokenKey, poolKey);
  }

  private reject(
    chain: Chain,
    tokenAddress: string,
    reason: string,
    evidence: unknown
  ): QualificationResult {
    const current = this.candidates.find(chain, tokenAddress);
    if (current === undefined) throw new Error('candidate not found');
    const terminal = this.terminalResult(current);
    if (terminal !== undefined) return terminal;
    {
      const rejectedAtMs = this.now();
      withTransaction(this.database, () => {
        this.candidates.setDecisionRuleVersion(
          chain,
          tokenAddress,
          this.config.ruleVersion,
          rejectedAtMs
        );
        this.candidates.transition(chain, tokenAddress, 'REJECTED', {
          atMs: rejectedAtMs,
          terminalReason: reason
        });
        this.events.record({
          chain,
          tokenAddress,
          stage: 'fixed_pool_qualification',
          outcome: 'REJECT',
          reasonCode: reason,
          source: 'system',
          observedAtMs: rejectedAtMs,
          raw: evidence,
          normalized: {},
          thresholds: this.config.thresholds,
          decisionRuleVersion: this.config.ruleVersion
        });
      });
    }
    this.releaseBoundPool(chain, tokenAddress);
    return { outcome: 'REJECTED', reasons: [reason] };
  }
}
