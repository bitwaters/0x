import type { Chain, RuntimeConfig } from '../config.js';
import type { SqliteDatabase } from '../db/database.js';
import { withTransaction } from '../db/database.js';
import {
  CandidateRepository,
  QualificationEventRepository,
  RankSnapshotFetchRepository,
  RankSnapshotRepository
} from '../db/repositories.js';
import { normalizeAddress } from '../domain/address.js';
import type {
  GmgnTokenInfo,
  GmgnTrendingItem,
  GmgnTrendingSnapshot
} from '../providers/gmgn.js';
import { DISCOVERY_POLICY } from './policy.js';

type ActivationReason = 'DUAL_RANK' | 'THREE_RISING_1M' | 'RADAR_OPENED';

interface RisingState {
  readonly fetchedAtMs: number;
  readonly rank: number;
  readonly count: number;
}

export interface DiscoveryResult {
  readonly observed: number;
  readonly created: number;
  readonly activated: number;
}

export type TokenInfoResolver = (
  chain: Chain,
  tokenAddress: string,
  signal?: AbortSignal
) => Promise<GmgnTokenInfo>;

export class CandidateDiscoveryEngine {
  private readonly candidates: CandidateRepository;
  private readonly snapshots: RankSnapshotRepository;
  private readonly snapshotFetches: RankSnapshotFetchRepository;
  private readonly events: QualificationEventRepository;
  private readonly latest = new Map<string, GmgnTrendingSnapshot>();
  private readonly rising = new Map<string, RisingState>();
  private readonly lastResolutionAt = new Map<string, number>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly config: Pick<RuntimeConfig, 'ruleVersion' | 'thresholds'>,
    private readonly resolveTokenInfo: TokenInfoResolver,
    private readonly now: () => number = Date.now,
    private readonly isChainActive: (chain: Chain) => boolean = () => true
  ) {
    this.candidates = new CandidateRepository(database);
    this.snapshots = new RankSnapshotRepository(database);
    this.snapshotFetches = new RankSnapshotFetchRepository(database);
    this.events = new QualificationEventRepository(database);
  }

  async acceptSnapshot(
    snapshot: GmgnTrendingSnapshot,
    signal?: AbortSignal
  ): Promise<DiscoveryResult> {
    const nowMs = this.now();
    this.validateSnapshotTime(snapshot, nowMs);
    if (!this.isChainActive(snapshot.chain)) {
      return { observed: 0, created: 0, activated: 0 };
    }
    const latestKey = `${snapshot.chain}:${snapshot.interval}`;
    const previous = this.latest.get(latestKey);
    if (previous !== undefined && snapshot.fetchedAtMs <= previous.fetchedAtMs) {
      throw new Error('GMGN snapshot time must move forward');
    }

    if (snapshot.items.length > DISCOVERY_POLICY.trendingLimit) {
      throw new Error('GMGN snapshot exceeds the configured Top100 limit');
    }
    const currentItems = new Map<string, GmgnTrendingItem>();
    for (const item of snapshot.items) {
      const tokenAddress = normalizeAddress(snapshot.chain, item.tokenAddress);
      if (currentItems.has(tokenAddress)) {
        throw new Error('GMGN snapshot contains a duplicate normalized token address');
      }
      currentItems.set(
        tokenAddress,
        tokenAddress === item.tokenAddress ? item : { ...item, tokenAddress }
      );
    }
    const normalizedSnapshot: GmgnTrendingSnapshot = {
      ...snapshot,
      items: [...currentItems.values()]
    };
    const risingUpdate =
      snapshot.interval === '1m'
        ? this.calculateRising(normalizedSnapshot, currentItems)
        : { activated: new Set<string>(), next: new Map<string, RisingState>() };

    let observed = 0;
    let created = 0;
    const activationWork: Array<{
      item: GmgnTrendingItem;
      reason: ActivationReason;
    }> = [];

    withTransaction(this.database, () => {
      this.snapshotFetches.insert({
        chain: snapshot.chain,
        interval: snapshot.interval,
        fetchedAtMs: snapshot.fetchedAtMs,
        itemCount: currentItems.size,
        discoveryRuleVersion: this.config.ruleVersion
      });
      for (const item of currentItems.values()) {
        const existing = this.candidates.find(snapshot.chain, item.tokenAddress);
        const withinMarketCap = this.isWithinMarketCap(item.marketCapUsd);
        if (existing === undefined && !withinMarketCap) continue;

        const result =
          existing === undefined
            ? this.candidates.findOrCreate({
                chain: snapshot.chain,
                tokenAddress: item.tokenAddress,
                firstSeenAtMs: snapshot.fetchedAtMs,
                firstSeenPriceUsd: item.priceUsd,
                firstSeenRank: item.rank,
                firstSeenMarketCapUsd: item.marketCapUsd,
                firstSeenLiquidityUsd: item.liquidityUsd,
                discoveryRuleVersion: this.config.ruleVersion
              })
            : { candidate: existing, created: false };
        if (result.created) created += 1;
        observed += 1;
        this.snapshots.insert({
          chain: snapshot.chain,
          interval: snapshot.interval,
          fetchedAtMs: snapshot.fetchedAtMs,
          tokenAddress: item.tokenAddress,
          rank: item.rank,
          priceUsd: item.priceUsd,
          marketCapUsd: item.marketCapUsd,
          liquidityUsd: item.liquidityUsd,
          raw: item.raw
        });
        const candidate = this.candidates.updateHighWaterInTransaction({
          chain: snapshot.chain,
          tokenAddress: item.tokenAddress,
          observedPriceUsd: item.priceUsd,
          maxGainRatio: this.config.thresholds.maxObservedGainRatio,
          decisionRuleVersion: this.config.ruleVersion,
          observedAtMs: snapshot.fetchedAtMs,
          raw: item.raw
        });
        if (!withinMarketCap || !['DISCOVERED', 'RADAR'].includes(candidate.status)) continue;

        const reason =
          candidate.status === 'RADAR' && item.openAtMs !== null
            ? 'RADAR_OPENED'
            : this.dualRankActivation(normalizedSnapshot, item.tokenAddress, nowMs)
              ? 'DUAL_RANK'
              : risingUpdate.activated.has(item.tokenAddress)
                ? 'THREE_RISING_1M'
                : undefined;
        if (reason !== undefined && this.canResolve(snapshot.chain, item.tokenAddress, nowMs)) {
          activationWork.push({ item, reason });
        }
      }
    });
    if (snapshot.interval === '1m') this.commitRising(snapshot.chain, risingUpdate.next);
    this.latest.set(latestKey, normalizedSnapshot);
    for (const { item } of activationWork) {
      this.lastResolutionAt.set(`${snapshot.chain}:${item.tokenAddress}`, nowMs);
    }

    const outcomes = await Promise.all(
      activationWork.map(async ({ item, reason }) => {
        await this.resolveActivation(snapshot.chain, item, reason, nowMs, signal);
        return 1;
      })
    );
    return { observed, created, activated: outcomes.length };
  }

  expireQualificationWindows(nowMs = this.now()) {
    return this.candidates.expireQualificationWindows({
      nowMs,
      windowSeconds: this.config.thresholds.qualificationWindowSeconds,
      decisionRuleVersion: this.config.ruleVersion
    });
  }

  private validateSnapshotTime(snapshot: GmgnTrendingSnapshot, nowMs: number): void {
    if (
      !Number.isInteger(snapshot.fetchedAtMs) ||
      snapshot.fetchedAtMs > nowMs ||
      nowMs - snapshot.fetchedAtMs > DISCOVERY_POLICY.snapshotMaxAgeMs[snapshot.interval]
    ) {
      throw new Error('GMGN snapshot timestamp is outside its freshness window');
    }
  }

  private isWithinMarketCap(marketCapUsd: number): boolean {
    return (
      marketCapUsd >= this.config.thresholds.marketCapMinUsd &&
      marketCapUsd <= this.config.thresholds.marketCapMaxUsd
    );
  }

  private calculateRising(
    snapshot: GmgnTrendingSnapshot,
    currentItems: ReadonlyMap<string, GmgnTrendingItem>
  ): { readonly activated: Set<string>; readonly next: Map<string, RisingState> } {
    const activated = new Set<string>();
    const next = new Map<string, RisingState>();
    for (const item of currentItems.values()) {
      const key = `${snapshot.chain}:${item.tokenAddress}`;
      const previous = this.rising.get(key);
      const continuous =
        previous !== undefined &&
        snapshot.fetchedAtMs - previous.fetchedAtMs <= DISCOVERY_POLICY.risingMaxGapMs &&
        snapshot.fetchedAtMs > previous.fetchedAtMs &&
        item.rank < previous.rank;
      const count = continuous ? previous.count + 1 : 1;
      next.set(key, { fetchedAtMs: snapshot.fetchedAtMs, rank: item.rank, count });
      if (count >= DISCOVERY_POLICY.risingSnapshotCount) activated.add(item.tokenAddress);
    }
    return { activated, next };
  }

  private commitRising(chain: Chain, next: ReadonlyMap<string, RisingState>): void {
    const prefix = `${chain}:`;
    for (const key of this.rising.keys()) {
      if (key.startsWith(prefix)) this.rising.delete(key);
    }
    for (const [key, value] of next) this.rising.set(key, value);
  }

  private dualRankActivation(
    snapshot: GmgnTrendingSnapshot,
    tokenAddress: string,
    nowMs: number
  ): boolean {
    const otherInterval = snapshot.interval === '1m' ? '5m' : '1m';
    const other = this.latest.get(`${snapshot.chain}:${otherInterval}`);
    if (other === undefined) return false;
    const oneMinute = snapshot.interval === '1m' ? snapshot : other;
    const fiveMinute = snapshot.interval === '5m' ? snapshot : other;
    return (
      nowMs >= oneMinute.fetchedAtMs &&
      nowMs >= fiveMinute.fetchedAtMs &&
      nowMs - oneMinute.fetchedAtMs <= DISCOVERY_POLICY.snapshotMaxAgeMs['1m'] &&
      nowMs - fiveMinute.fetchedAtMs <= DISCOVERY_POLICY.snapshotMaxAgeMs['5m'] &&
      Math.abs(oneMinute.fetchedAtMs - fiveMinute.fetchedAtMs) <=
        DISCOVERY_POLICY.dualSnapshotMaxDifferenceMs &&
      other.items.some(
        (item) =>
          item.tokenAddress === tokenAddress && this.isWithinMarketCap(item.marketCapUsd)
      )
    );
  }

  private canResolve(chain: Chain, tokenAddress: string, nowMs: number): boolean {
    const key = `${chain}:${tokenAddress}`;
    const last = this.lastResolutionAt.get(key);
    return last === undefined || nowMs - last >= DISCOVERY_POLICY.radarRefreshMs;
  }

  private async resolveActivation(
    chain: Chain,
    item: GmgnTrendingItem,
    reason: ActivationReason,
    observedAtMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    let info: GmgnTokenInfo;
    try {
      info = await this.resolveTokenInfo(chain, item.tokenAddress, signal);
    } catch (error) {
      this.events.record({
        chain,
        tokenAddress: item.tokenAddress,
        stage: 'pool_resolution',
        outcome: 'ERROR',
        reasonCode: 'TOKEN_INFO_UNAVAILABLE',
        source: 'gmgn',
        observedAtMs,
        raw: { error: error instanceof Error ? error.name : 'unknown' },
        normalized: {},
        thresholds: {},
        decisionRuleVersion: this.config.ruleVersion
      });
      return;
    }

    const eligible = this.candidates.find(chain, item.tokenAddress);
    if (eligible === undefined || !['DISCOVERED', 'RADAR'].includes(eligible.status)) return;
    if (info.chain !== chain || info.tokenAddress !== item.tokenAddress) {
      this.events.record({
        chain,
        tokenAddress: item.tokenAddress,
        stage: 'pool_resolution',
        outcome: 'ERROR',
        reasonCode: 'TOKEN_INFO_IDENTITY_MISMATCH',
        source: 'gmgn',
        observedAtMs,
        raw: info.raw,
        normalized: { returnedChain: info.chain, returnedTokenAddress: info.tokenAddress },
        thresholds: {},
        decisionRuleVersion: this.config.ruleVersion
      });
      return;
    }

    if (info.openAtMs === null || info.biggestPoolAddress === null) {
      if (eligible.status === 'DISCOVERED') {
        this.transitionWithEvent({
          chain,
          tokenAddress: item.tokenAddress,
          nextStatus: 'RADAR',
          stage: 'activation',
          outcome: 'WAIT',
          reasonCode: `${reason}_BONDING_CURVE`,
          observedAtMs,
          raw: info.raw,
          normalized: { openAtMs: info.openAtMs, biggestPoolAddress: info.biggestPoolAddress },
          thresholds: { marketCap: this.marketCapThresholds() }
        });
      }
      return;
    }

    const poolCreatedAtMs = info.poolCreatedAtMs;
    const poolAgeMs = poolCreatedAtMs === null ? null : observedAtMs - poolCreatedAtMs;
    const rejection =
      poolAgeMs === null || poolAgeMs < 0
        ? 'POOL_TIME_INVALID'
        : poolAgeMs > this.config.thresholds.poolAgeMaxSeconds * 1_000
          ? 'POOL_TOO_OLD'
          : info.liquidityUsd < this.config.thresholds.liquidityMinUsd
            ? 'LIQUIDITY_TOO_LOW'
            : undefined;
    if (rejection !== undefined) {
      this.transitionWithEvent({
        chain,
        tokenAddress: item.tokenAddress,
        nextStatus: 'REJECTED',
        stage: 'real_pool_range',
        outcome: 'REJECT',
        reasonCode: rejection,
        observedAtMs,
        raw: info.raw,
        normalized: { liquidityUsd: info.liquidityUsd, poolAgeMs },
        thresholds: {
          liquidityMinUsd: this.config.thresholds.liquidityMinUsd,
          poolAgeMaxSeconds: this.config.thresholds.poolAgeMaxSeconds
        }
      });
      return;
    }

    this.transitionWithEvent({
      chain,
      tokenAddress: item.tokenAddress,
      nextStatus: 'PREHEAT',
      stage: 'activation',
      outcome: 'PASS',
      reasonCode: `${reason}_REAL_POOL`,
      observedAtMs,
      raw: info.raw,
      normalized: {
        biggestPoolAddress: info.biggestPoolAddress,
        liquidityUsd: info.liquidityUsd,
        poolAgeMs
      },
      thresholds: {
        ...this.marketCapThresholds(),
        liquidityMinUsd: this.config.thresholds.liquidityMinUsd,
        poolAgeMaxSeconds: this.config.thresholds.poolAgeMaxSeconds
      }
    });
  }

  private marketCapThresholds() {
    return {
      marketCapMinUsd: this.config.thresholds.marketCapMinUsd,
      marketCapMaxUsd: this.config.thresholds.marketCapMaxUsd
    };
  }

  private transitionWithEvent(input: {
    readonly chain: Chain;
    readonly tokenAddress: string;
    readonly nextStatus: 'RADAR' | 'PREHEAT' | 'REJECTED';
    readonly stage: string;
    readonly outcome: 'PASS' | 'WAIT' | 'REJECT';
    readonly reasonCode: string;
    readonly observedAtMs: number;
    readonly raw: unknown;
    readonly normalized: unknown;
    readonly thresholds: unknown;
  }): void {
    withTransaction(this.database, () => {
      this.candidates.setDecisionRuleVersion(
        input.chain,
        input.tokenAddress,
        this.config.ruleVersion,
        input.observedAtMs
      );
      this.candidates.transition(input.chain, input.tokenAddress, input.nextStatus, {
        atMs: input.observedAtMs,
        ...(input.nextStatus === 'REJECTED'
          ? { terminalReason: input.reasonCode }
          : {})
      });
      this.events.record({
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        stage: input.stage,
        outcome: input.outcome,
        reasonCode: input.reasonCode,
        source: 'gmgn',
        observedAtMs: input.observedAtMs,
        raw: input.raw,
        normalized: input.normalized,
        thresholds: input.thresholds,
        decisionRuleVersion: this.config.ruleVersion
      });
    });
  }
}
