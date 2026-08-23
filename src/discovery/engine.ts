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

interface DualState {
  readonly evaluatedAtMs: number;
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
  private readonly dual = new Map<string, DualState>();
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
      publicReady: boolean;
    }> = [];

    const previousDual = new Map(this.dual);
    try {
      if (snapshot.interval === '1m') {
        this.clearMissingDualCandidates(snapshot.chain, currentItems);
      }
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

          const dualCount = this.dualRankCount(
            normalizedSnapshot,
            item.tokenAddress,
            nowMs
          );
          const risingReady = risingUpdate.activated.has(item.tokenAddress);
          const radarOpened =
            item.openAtMs !== null &&
            this.events.has({
              chain: snapshot.chain,
              tokenAddress: item.tokenAddress,
              stage: 'bonding_shortcut_readiness',
              reasonCode: 'BONDING_POOL_OPEN_SHORTCUT_READY',
              ...(candidate.legacyReopenedAtMs === null
                ? {}
                : { observedAfterMs: candidate.legacyReopenedAtMs })
            });
          const reason =
            radarOpened
              ? 'RADAR_OPENED'
              : dualCount >= DISCOVERY_POLICY.consecutiveDualSnapshotCount
                ? 'DUAL_RANK'
                : risingReady
                  ? 'THREE_RISING_1M'
                  : dualCount >= 1
                    ? 'DUAL_RANK'
                  : undefined;
          const sustainedHeat =
            dualCount >= DISCOVERY_POLICY.consecutiveDualSnapshotCount || risingReady;
          if (reason !== undefined && this.canResolve(snapshot.chain, item.tokenAddress, nowMs)) {
            activationWork.push({ item, reason, publicReady: sustainedHeat });
          }
        }
      });
    } catch (error) {
      this.dual.clear();
      for (const [key, value] of previousDual) this.dual.set(key, value);
      throw error;
    }
    if (snapshot.interval === '1m') this.commitRising(snapshot.chain, risingUpdate.next);
    this.latest.set(latestKey, normalizedSnapshot);
    for (const { item } of activationWork) {
      this.lastResolutionAt.set(`${snapshot.chain}:${item.tokenAddress}`, nowMs);
    }

    const outcomes = await Promise.all(
      activationWork.map(async ({ item, reason, publicReady }) => {
        await this.resolveActivation(
          snapshot.chain,
          item,
          reason,
          publicReady,
          nowMs,
          signal
        );
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

  private clearMissingDualCandidates(
    chain: Chain,
    currentItems: ReadonlyMap<string, GmgnTrendingItem>
  ): void {
    const prefix = `${chain}:`;
    for (const key of this.dual.keys()) {
      if (key.startsWith(prefix) && !currentItems.has(key.slice(prefix.length))) {
        this.dual.delete(key);
      }
    }
  }

  private dualRankCount(
    snapshot: GmgnTrendingSnapshot,
    tokenAddress: string,
    nowMs: number
  ): number {
    const otherInterval = snapshot.interval === '1m' ? '5m' : '1m';
    const other = this.latest.get(`${snapshot.chain}:${otherInterval}`);
    if (other === undefined) return 0;
    const oneMinute = snapshot.interval === '1m' ? snapshot : other;
    const fiveMinute = snapshot.interval === '5m' ? snapshot : other;
    const qualifies = (
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
    const key = `${snapshot.chain}:${tokenAddress}`;
    if (!qualifies) {
      this.dual.delete(key);
      return 0;
    }
    const evaluatedAtMs = oneMinute.fetchedAtMs;
    const previous = this.dual.get(key);
    if (previous?.evaluatedAtMs === evaluatedAtMs) return previous.count;
    const next = {
      evaluatedAtMs,
      count: previous === undefined ? 1 : previous.count + 1
    };
    this.dual.set(key, next);
    return next.count;
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
    publicReady: boolean,
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

    const latestOneMinute = this.snapshots.findLatest(chain, item.tokenAddress, '1m');
    if (
      latestOneMinute === undefined ||
      observedAtMs - latestOneMinute.fetchedAtMs > DISCOVERY_POLICY.snapshotMaxAgeMs['1m']
    ) return;

    if (info.openAtMs === null || info.biggestPoolAddress === null) {
      const publicPolicy = DISCOVERY_POLICY.publicRadar[chain];
      const bondingMarketCap =
        latestOneMinute.marketCapUsd >= DISCOVERY_POLICY.bondingRadarMarketCapUsd.min &&
        latestOneMinute.marketCapUsd <= DISCOVERY_POLICY.bondingRadarMarketCapUsd.max;
      const shortcutReady =
        publicReady &&
        latestOneMinute.rank <= DISCOVERY_POLICY.bondingShortcutRankMax &&
        bondingMarketCap;
      if (shortcutReady) {
        this.events.recordOnce({
          chain,
          tokenAddress: item.tokenAddress,
          stage: 'bonding_shortcut_readiness',
          outcome: 'PASS',
          reasonCode: 'BONDING_POOL_OPEN_SHORTCUT_READY',
          source: 'gmgn',
          observedAtMs,
          raw: info.raw,
          normalized: {
            rank: latestOneMinute.rank,
            marketCapUsd: latestOneMinute.marketCapUsd
          },
          thresholds: {
            rankMax: DISCOVERY_POLICY.bondingShortcutRankMax,
            marketCapUsd: DISCOVERY_POLICY.bondingRadarMarketCapUsd
          },
          decisionRuleVersion: this.config.ruleVersion
        }, false, eligible.legacyReopenedAtMs ?? undefined);
      }
      const bondingPublic =
        publicReady &&
        reason !== 'RADAR_OPENED' &&
        publicPolicy.bondingTriggers.some((trigger) => trigger === reason) &&
        latestOneMinute.rank >= publicPolicy.bondingRank.min &&
        latestOneMinute.rank <= publicPolicy.bondingRank.max &&
        bondingMarketCap;
      if (bondingPublic) {
        this.events.recordOnce({
          chain,
          tokenAddress: item.tokenAddress,
          stage: 'radar_public_readiness',
          outcome: 'PASS',
          reasonCode: `${chain.toUpperCase()}_RADAR_PUBLIC_READY`,
          source: 'gmgn',
          observedAtMs,
          raw: info.raw,
          normalized: {
            stage: 'bonding',
            rank: latestOneMinute.rank,
            marketCapUsd: latestOneMinute.marketCapUsd
          },
          thresholds: {
            rank: publicPolicy.bondingRank,
            marketCapUsd: DISCOVERY_POLICY.bondingRadarMarketCapUsd
          },
          decisionRuleVersion: this.config.ruleVersion
        });
      }
      if (eligible.status === 'DISCOVERED' && bondingPublic) {
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
    const rejection = poolAgeMs === null || poolAgeMs < 0
      ? 'POOL_TIME_INVALID'
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
          liquidityMinUsd: this.config.thresholds.liquidityMinUsd
        }
      });
      return;
    }
    if (
      info.liquidityUsd === null ||
      info.liquidityUsd < this.config.thresholds.liquidityMinUsd
    ) {
      this.events.record({
        chain,
        tokenAddress: item.tokenAddress,
        stage: 'real_pool_range',
        outcome: 'WAIT',
        reasonCode: 'LIQUIDITY_TOO_LOW',
        source: 'gmgn',
        observedAtMs,
        raw: info.raw,
        normalized: { liquidityUsd: info.liquidityUsd, poolAgeMs },
        thresholds: { liquidityMinUsd: this.config.thresholds.liquidityMinUsd },
        decisionRuleVersion: this.config.ruleVersion
      });
      return;
    }

    if (
      latestOneMinute.rank > DISCOVERY_POLICY.realPoolRankMax ||
      latestOneMinute.marketCapUsd < DISCOVERY_POLICY.realPoolMarketCapUsd.min ||
      latestOneMinute.marketCapUsd > DISCOVERY_POLICY.realPoolMarketCapUsd.max
    ) return;

    const opportunityType = poolAgeMs! <= DISCOVERY_POLICY.newPoolMaxAgeMs
      ? 'new_pool'
      : 'revival';
    if (opportunityType === 'revival' && !publicReady) return;
    withTransaction(this.database, () => {
      const activated = this.candidates.activate({
        chain,
        tokenAddress: item.tokenAddress,
        opportunityType,
        priceUsd: latestOneMinute.priceUsd,
        ruleVersion: this.config.ruleVersion,
        atMs: observedAtMs
      });
      if (!['DISCOVERED', 'RADAR'].includes(activated.status)) return;
      this.candidates.transition(chain, item.tokenAddress, 'PREHEAT', { atMs: observedAtMs });
      this.events.record({
        chain,
        tokenAddress: item.tokenAddress,
        stage: 'activation',
        outcome: 'PASS',
        reasonCode: `${reason}_${opportunityType === 'new_pool' ? 'REAL_POOL' : 'REVIVAL_POOL'}`,
        source: 'gmgn',
        observedAtMs,
        raw: info.raw,
        normalized: {
          biggestPoolAddress: info.biggestPoolAddress,
          liquidityUsd: info.liquidityUsd,
          poolAgeMs,
          opportunityType
        },
        thresholds: {
          realPoolMarketCapUsd: DISCOVERY_POLICY.realPoolMarketCapUsd,
          realPoolRankMax: DISCOVERY_POLICY.realPoolRankMax,
          newPoolMaxAgeMs: DISCOVERY_POLICY.newPoolMaxAgeMs,
          liquidityMinUsd: this.config.thresholds.liquidityMinUsd
        },
        decisionRuleVersion: this.config.ruleVersion
      });
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
