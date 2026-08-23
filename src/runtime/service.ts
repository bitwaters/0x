import type { Chain, RuntimeConfig } from '../config.js';
import { getConfiguredSecrets } from '../config.js';
import type { SqliteDatabase } from '../db/database.js';
import {
  CandidateRepository,
  OutboxRepository,
  PoolBindingRepository,
  QualificationEventRepository,
  RankSnapshotRepository,
  type CandidateRecord
} from '../db/repositories.js';
import { CandidateDiscoveryEngine } from '../discovery/engine.js';
import { DiscoveryPoller } from '../discovery/poller.js';
import { DISCOVERY_POLICY } from '../discovery/policy.js';
import { EvaluationService, type EvaluationCoinGeckoSource, type EvaluationGmgnSource } from '../evaluation/service.js';
import { CoinGeckoClient } from '../providers/coingecko.js';
import {
  G2SocketManager,
  PoolRefreshCoordinator,
  type G2SocketFactory
} from '../providers/g2.js';
import { GmgnClient } from '../providers/gmgn.js';
import type { TrendingSource } from '../discovery/poller.js';
import type {
  QualificationCoinGeckoSource,
  QualificationGmgnSource
} from '../qualification/service.js';
import { FixedPoolQualificationService } from '../qualification/service.js';
import { activationReasonFromCode } from '../qualification/snapshot.js';
import { formatSafeError } from '../security/redaction.js';
import {
  renderRadarMessage,
  renderSignalMessage,
  type RadarMessageSnapshot
} from '../telegram/messages.js';
import type {
  DeliveryResult,
  DeliveryCoinGeckoSource,
  DeliveryGmgnSource
} from '../telegram/service.js';
import { TelegramDeliveryService } from '../telegram/service.js';
import {
  TelegramTransport,
  type TelegramTransportLike
} from '../telegram/transport.js';

const CANDIDATE_TICK_MS = 500;
const QUALIFICATION_REFRESH_MS = 3_000;
const FOLLOWUP_TICK_MS = 1_000;
const EVALUATION_TICK_MS = 1_000;
const PROGRESS_TICK_MS = 60_000;
const RADAR_DELIVERY_MIN_INTERVAL_MS = 1_200;

type RuntimeGmgnSource = TrendingSource & QualificationGmgnSource & DeliveryGmgnSource & EvaluationGmgnSource;
type RuntimeCoinGeckoSource = QualificationCoinGeckoSource & DeliveryCoinGeckoSource & EvaluationCoinGeckoSource;

export type RuntimeEvent = Readonly<Record<string, unknown>> & { readonly event: string };
export type RuntimeLogSink = (entry: RuntimeEvent, error: boolean) => void;

export interface RuntimeOptions {
  readonly gmgn?: RuntimeGmgnSource;
  readonly coinGecko?: RuntimeCoinGeckoSource;
  readonly telegram?: TelegramTransportLike;
  readonly socketFactory?: G2SocketFactory;
  readonly now?: () => number;
  readonly log?: RuntimeLogSink;
}

const disabledTelegram: TelegramTransportLike = {
  async sendMessage() {
    throw new Error('Telegram transport is disabled');
  },
  async editMessage() {
    throw new Error('Telegram transport is disabled');
  }
};

export class BotRuntime {
  private readonly candidates: CandidateRepository;
  private readonly pools: PoolBindingRepository;
  private readonly outbox: OutboxRepository;
  private readonly rankSnapshots: RankSnapshotRepository;
  private readonly qualificationEvents: QualificationEventRepository;
  private readonly qualification: FixedPoolQualificationService;
  private readonly delivery: TelegramDeliveryService;
  private readonly evaluation: EvaluationService;
  private readonly discovery: DiscoveryPoller;
  private readonly sockets: G2SocketManager;
  private readonly abortController = new AbortController();
  private readonly qualificationLastAt = new Map<string, number>();
  private readonly radarLastAt = new Map<string, number>();
  private radarNextDeliveryAtMs = 0;
  private readonly signalPreviewed = new Set<string>();
  private readonly dirtyPools = new Map<string, { chain: Chain; poolAddress: string }>();
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly secrets: readonly string[];
  private readonly now: () => number;
  private readonly log: RuntimeLogSink;
  private running = false;
  private candidateWork: Promise<void> | undefined;
  private followupWork: Promise<void> | undefined;
  private evaluationWork: Promise<void> | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly config: RuntimeConfig,
    options: RuntimeOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.secrets = getConfiguredSecrets(config);
    this.log = options.log ?? ((entry, error) => {
      (error ? process.stderr : process.stdout).write(`${JSON.stringify(entry)}\n`);
    });
    const gmgn = options.gmgn ?? new GmgnClient(config.providers.gmgnApiKey, {
      requestsPerMinute: config.limits.gmgnRestRpm
    });
    const coinGecko = options.coinGecko ?? new CoinGeckoClient(
      config.providers.coinGeckoApiKey,
      { restRequestsPerMinute: config.limits.coinGeckoRestRpm }
    );
    this.candidates = new CandidateRepository(database);
    this.pools = new PoolBindingRepository(database);
    this.outbox = new OutboxRepository(database);
    this.rankSnapshots = new RankSnapshotRepository(database);
    this.qualificationEvents = new QualificationEventRepository(database);
    this.evaluation = new EvaluationService(database, config, coinGecko, gmgn, this.now);

    const coordinator = new PoolRefreshCoordinator(
      async (chain, poolAddress) => {
        this.dirtyPools.set(`${chain}:${poolAddress}`, { chain, poolAddress });
      },
      1_000,
      this.now,
      (error) => this.emitError('g2_refresh_failed', error)
    );
    this.sockets = new G2SocketManager(
      config.providers.coinGeckoApiKey,
      coordinator,
      options.socketFactory
    );
    this.qualification = new FixedPoolQualificationService(
      database,
      config,
      gmgn,
      coinGecko,
      this.now,
      (chain, poolAddress) => this.sockets.forChain(chain).subscribe(poolAddress),
      (chain, poolAddress) => this.sockets.forChain(chain).release(poolAddress)
    );
    const telegram = options.telegram ?? (
      config.telegram.enabled
        ? new TelegramTransport(config.telegram.botToken)
        : disabledTelegram
    );
    this.delivery = new TelegramDeliveryService(
      database,
      config,
      coinGecko,
      gmgn,
      telegram,
      this.now,
      (chain, tokenAddress, poolAddress) =>
        this.qualification.retainSignalSubscription(chain, tokenAddress, poolAddress),
      (chain, tokenAddress) =>
        this.qualification.releaseCandidateSubscription(chain, tokenAddress)
    );
    const engine = new CandidateDiscoveryEngine(
      database,
      config,
      (chain, tokenAddress, signal) => gmgn.getTokenInfo(chain, tokenAddress, signal),
      this.now,
      (chain) => this.evaluation.signalRole(chain) !== undefined
    );
    this.discovery = new DiscoveryPoller(
      gmgn,
      engine,
      config,
      (error, chain, interval) =>
        this.emitError('discovery_poll_failed', error, { chain, interval }),
      (error) => this.emitError('discovery_maintenance_failed', error),
      (expired) => this.qualification.releaseExpiredCandidates(expired)
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.qualification.start();
    if (this.config.telegram.enabled) this.delivery.start();
    for (const chain of ['sol', 'bsc'] as const) {
      if (this.config.chains[chain]) this.sockets.forChain(chain).start();
    }
    this.launchCandidateCycle();
    this.launchFollowupCycle();
    this.launchEvaluationCycle();
    this.emitProgress();
    this.timers.push(
      setInterval(() => this.launchCandidateCycle(), CANDIDATE_TICK_MS),
      setInterval(() => this.launchFollowupCycle(), FOLLOWUP_TICK_MS),
      setInterval(() => this.launchEvaluationCycle(), EVALUATION_TICK_MS),
      setInterval(() => this.emitProgress(), PROGRESS_TICK_MS)
    );
    this.discovery.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.discovery.stop();
    this.sockets.stop();
    this.abortController.abort('runtime_stopped');
    await Promise.allSettled([
      this.discovery.drain(),
      this.candidateWork,
      this.followupWork,
      this.evaluationWork
    ].filter((work): work is Promise<void> => work !== undefined));
  }

  progress(): readonly RuntimeEvent[] {
    return (['sol', 'bsc'] as const)
      .filter((chain) => this.config.chains[chain])
      .map((chain) => ({ event: 'validation_progress', ...this.evaluation.progress(chain) }));
  }

  private launchCandidateCycle(): void {
    if (!this.running || this.candidateWork !== undefined) return;
    const work = this.runCandidateCycle()
      .catch((error) => this.emitError('candidate_cycle_failed', error))
      .finally(() => {
        if (this.candidateWork === work) this.candidateWork = undefined;
      });
    this.candidateWork = work;
  }

  private launchFollowupCycle(): void {
    if (!this.running || !this.config.telegram.enabled || this.followupWork !== undefined) {
      return;
    }
    const work = this.delivery.tick(this.abortController.signal)
      .catch((error) => this.emitError('telegram_followup_failed', error))
      .finally(() => {
        if (this.followupWork === work) this.followupWork = undefined;
      });
    this.followupWork = work;
  }

  private launchEvaluationCycle(): void {
    if (!this.running || this.evaluationWork !== undefined) return;
    const work = this.evaluation.tick(this.abortController.signal)
      .catch((error) => this.emitError('evaluation_tick_failed', error))
      .finally(() => {
        if (this.evaluationWork === work) this.evaluationWork = undefined;
      });
    this.evaluationWork = work;
  }

  private async runCandidateCycle(): Promise<void> {
    this.qualification.releaseTerminalSubscriptions();
    await this.consumeDirtyPool();
    const actionable = this.candidates
      .listActionable()
      .filter((candidate) => this.config.chains[candidate.chain]);
    await Promise.all([
      this.processRadar(
        this.candidates
          .listRadarCandidates()
          .filter((candidate) => this.config.chains[candidate.chain])
      ),
      this.processQualification(actionable)
    ]);
  }

  private async consumeDirtyPool(): Promise<void> {
    const item = this.dirtyPools.entries().next().value as
      | [string, { chain: Chain; poolAddress: string }]
      | undefined;
    if (item === undefined) return;
    const [key, dirty] = item;
    this.dirtyPools.delete(key);
    for (const binding of this.pools.findByPool(dirty.chain, dirty.poolAddress)) {
      const candidate = this.candidates.find(binding.chain, binding.tokenAddress);
      if (candidate === undefined) continue;
      if (['POOL_BOUND', 'MONITORING'].includes(candidate.status)) {
        this.qualificationLastAt.delete(`${binding.chain}:${binding.tokenAddress}`);
      } else if (candidate.status === 'SIGNAL_SENT' && this.config.telegram.enabled) {
        await this.delivery.refreshPrice(
          binding.chain,
          binding.tokenAddress,
          this.abortController.signal
        );
      }
    }
  }

  private async processRadar(actionable: readonly CandidateRecord[]): Promise<void> {
    const nowMs = this.now();
    if (this.config.telegram.enabled && nowMs < this.radarNextDeliveryAtMs) return;
    const ordered = [...actionable].sort((left, right) => {
      const leftAt = this.radarLastAt.get(`${left.chain}:${left.tokenAddress}`);
      const rightAt = this.radarLastAt.get(`${right.chain}:${right.tokenAddress}`);
      const checkedOrder =
        leftAt === undefined
          ? rightAt === undefined ? 0 : -1
          : rightAt === undefined ? 1 : leftAt - rightAt;
      return (
        checkedOrder ||
        left.firstSeenAtMs - right.firstSeenAtMs ||
        left.tokenAddress.localeCompare(right.tokenAddress)
      );
    });
    for (const candidate of ordered) {
      const key = `${candidate.chain}:${candidate.tokenAddress}`;
      const lastAt = this.radarLastAt.get(key);
      if (lastAt !== undefined && nowMs - lastAt < QUALIFICATION_REFRESH_MS) continue;
      this.radarLastAt.set(key, nowMs);
      const existing = this.outbox.find(candidate.chain, candidate.tokenAddress, 'radar');
      const latest = this.rankSnapshots.findLatest(candidate.chain, candidate.tokenAddress);
      const currentFetchAt = this.rankSnapshots.findLatestSuccessfulFetchAt(candidate.chain, '1m');
      const latestFresh =
        latest !== undefined &&
        latest.fetchedAtMs === currentFetchAt &&
        nowMs >= latest.fetchedAtMs &&
        nowMs - latest.fetchedAtMs <= DISCOVERY_POLICY.snapshotMaxAgeMs['1m'];
      const publicPolicy = DISCOVERY_POLICY.publicRadar[candidate.chain];
      const readinessReason = `${candidate.chain.toUpperCase()}_RADAR_PUBLIC_READY`;
      const initialSnapshot = existing?.initialPayload?.payload.snapshot;
      const initialStage =
        initialSnapshot !== null &&
        typeof initialSnapshot === 'object' &&
        !Array.isArray(initialSnapshot) &&
        typeof (initialSnapshot as { readonly stage?: unknown }).stage === 'string'
          ? (initialSnapshot as { readonly stage: string }).stage
          : undefined;
      const sentBonding = existing?.status === 'SENT' && initialStage === 'bonding';
      const bondingPublic =
        candidate.status === 'RADAR' &&
        latestFresh &&
        latest.rank >= publicPolicy.bondingRank.min &&
        latest.rank <= publicPolicy.bondingRank.max &&
          latest.marketCapUsd >= DISCOVERY_POLICY.bondingRadarMarketCapUsd.min &&
          latest.marketCapUsd <= DISCOVERY_POLICY.bondingRadarMarketCapUsd.max;
      const opportunityPublic =
        candidate.opportunityType === 'new_pool' ||
        (candidate.opportunityType === 'revival' && publicPolicy.revivalPublic);
      const activationEvidence =
        candidate.activationAtMs !== null &&
        this.qualificationEvents.hasRealPoolActivationEvidence(
          candidate.chain,
          candidate.tokenAddress
        );
      const realPoolEligible =
        ['PREHEAT', 'POOL_BOUND', 'MONITORING'].includes(candidate.status) &&
        activationEvidence &&
        opportunityPublic &&
        latestFresh &&
        latest.rank >= publicPolicy.realPoolRank.min &&
        latest.rank <= publicPolicy.realPoolRank.max &&
        latest.marketCapUsd >= DISCOVERY_POLICY.realPoolMarketCapUsd.min &&
        latest.marketCapUsd <= DISCOVERY_POLICY.realPoolMarketCapUsd.max &&
        latest.liquidityUsd !== null &&
        latest.liquidityUsd >= this.config.thresholds.liquidityMinUsd;
      const realPoolPublic =
        realPoolEligible &&
        (existing?.status === 'SENT'
          ? candidate.chain === 'bsc' || sentBonding
          : publicPolicy.directRealPool);
      if (
        realPoolEligible &&
        publicPolicy.directRealPool &&
        existing?.status !== 'SENT'
      ) {
        this.qualificationEvents.recordOnce({
          chain: candidate.chain,
          tokenAddress: candidate.tokenAddress,
          stage: 'radar_public_readiness',
          outcome: 'PASS',
          reasonCode: readinessReason,
          source: 'gmgn',
          observedAtMs: latest!.fetchedAtMs,
          raw: latest!.raw,
          normalized: {
            stage: 'real_pool',
            opportunityType: candidate.opportunityType,
            rank: latest!.rank,
            marketCapUsd: latest!.marketCapUsd,
            liquidityUsd: latest!.liquidityUsd,
            activationAtMs: candidate.activationAtMs
          },
          thresholds: {
            rank: publicPolicy.realPoolRank,
            marketCapUsd: DISCOVERY_POLICY.realPoolMarketCapUsd,
            liquidityMinUsd: this.config.thresholds.liquidityMinUsd,
            revivalPublic: publicPolicy.revivalPublic
          },
          decisionRuleVersion: this.config.ruleVersion
        });
      }
      const terminalStage: RadarMessageSnapshot['stage'] | undefined =
        candidate.status === 'SIGNAL_SENT'
          ? 'qualified'
          : candidate.status === 'EXPIRED'
            ? 'expired'
            : candidate.status === 'REJECTED'
              ? 'rejected'
              : undefined;
      const revivalSuppressed =
        candidate.opportunityType === 'revival' && !publicPolicy.revivalPublic;
      let stage: RadarMessageSnapshot['stage'] | undefined;
      if (terminalStage !== undefined) {
        stage = existing?.status === 'SENT' ? terminalStage : undefined;
      } else if (existing?.status === 'SENT') {
        const nonTerminalEditAllowed = candidate.chain === 'bsc' || sentBonding;
        stage = !nonTerminalEditAllowed || revivalSuppressed
          ? undefined
          : realPoolPublic
            ? 'real_pool'
            : bondingPublic
              ? 'bonding'
              : 'heat_wait';
      } else {
        stage = revivalSuppressed
          ? undefined
          : realPoolPublic
            ? 'real_pool'
            : bondingPublic
              ? 'bonding'
              : undefined;
      }
      if (existing?.status !== 'SENT') {
        const initialPublic = stage === 'bonding' || stage === 'real_pool';
        const ready = this.qualificationEvents.has({
          chain: candidate.chain,
          tokenAddress: candidate.tokenAddress,
          stage: 'radar_public_readiness',
          reasonCode: readinessReason,
          decisionRuleVersion: this.config.ruleVersion
        });
        const triggerEvidence = candidate.chain !== 'sol' || stage !== 'bonding' ||
          this.rankSnapshots.hasCurrentTriggerEvidence(
            candidate.chain,
            candidate.tokenAddress,
            publicPolicy.bondingTriggers,
            nowMs
          );
        if (!initialPublic || !ready || !triggerEvidence) stage = undefined;
      }
      if (stage === undefined) continue;
      const waitReason =
        stage === 'heat_wait' &&
        candidate.chain === 'bsc' &&
        latestFresh &&
        (candidate.status === 'RADAR'
          ? latest!.rank < publicPolicy.bondingRank.min ||
            latest!.rank > publicPolicy.bondingRank.max
          : latest!.rank < publicPolicy.realPoolRank.min ||
            latest!.rank > publicPolicy.realPoolRank.max)
          ? 'outside_public_range' as const
          : undefined;
      const result = await this.deliverRadar(
        candidate,
        latestFresh ? latest : undefined,
        existing?.payload,
        stage,
        waitReason
      );
      if (
        result === undefined ||
        result.outcome === 'DUPLICATE' ||
        result.reason === 'radar edit retry limit reached'
      ) continue;
      const retryAfterSeconds = result.reason?.match(/retry after (\d+)/i)?.[1];
      const retryAfterMs = retryAfterSeconds === undefined
        ? 0
        : Number.parseInt(retryAfterSeconds, 10) * 1_000;
      this.radarNextDeliveryAtMs = this.now() + Math.max(
        RADAR_DELIVERY_MIN_INTERVAL_MS,
        retryAfterMs
      );
      return;
    }
  }

  private async deliverRadar(
    candidate: CandidateRecord,
    latestRank: ReturnType<RankSnapshotRepository['findLatest']>,
    existingPayload: unknown,
    stage: RadarMessageSnapshot['stage'],
    waitReason?: RadarMessageSnapshot['waitReason']
  ): Promise<DeliveryResult | undefined> {
    const raw =
      latestRank?.raw !== null && typeof latestRank?.raw === 'object' && !Array.isArray(latestRank.raw)
        ? (latestRank.raw as Readonly<Record<string, unknown>>)
        : undefined;
    const activationReason = activationReasonFromCode(
      this.qualificationEvents.findFirstActivationReasonCode(
        candidate.chain,
        candidate.tokenAddress
      )
    );
    const name = raw?.name;
    const symbol = raw?.symbol;
    const previous =
      existingPayload !== null && typeof existingPayload === 'object' && !Array.isArray(existingPayload)
        ? (existingPayload as { readonly snapshot?: RadarMessageSnapshot }).snapshot
        : undefined;
    const snapshot: RadarMessageSnapshot = {
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      firstSeenAtMs: candidate.firstSeenAtMs,
      marketCapUsd: candidate.firstSeenMarketCapUsd,
      sampledMaxGain: candidate.sampledMaxGain,
      stage,
      ...(waitReason === undefined ? {} : { waitReason }),
      ...(latestRank !== undefined &&
      typeof name === 'string' &&
      typeof symbol === 'string' &&
      activationReason !== undefined
        ? {
            presentation: {
              name,
              symbol,
              marketCapUsd: latestRank.marketCapUsd,
              rank: latestRank.rank,
              currentGain: latestRank.priceUsd / candidate.firstSeenPriceUsd - 1,
              activationReason
            }
          }
        : previous?.presentation === undefined
          ? {}
          : { presentation: previous.presentation })
    };
    if (!this.config.telegram.enabled) {
      this.emit({ event: 'radar_preview_rendered', chain: candidate.chain, text: renderRadarMessage(snapshot) });
      return;
    }
    const result = await this.delivery.sendRadar(snapshot, this.abortController.signal);
    if (
      result.outcome !== 'DUPLICATE' &&
      result.reason !== 'radar edit retry limit reached'
    ) {
      this.emit({
        event: 'radar_delivery',
        chain: candidate.chain,
        outcome: result.outcome,
        ...(result.reason === undefined ? {} : { reason: result.reason })
      });
    }
    return result;
  }

  private async processQualification(actionable: readonly CandidateRecord[]): Promise<void> {
    const nowMs = this.now();
    const candidate = actionable
      .filter((item) => {
        if (!['PREHEAT', 'POOL_BOUND', 'MONITORING'].includes(item.status)) return false;
        if (this.evaluation.signalRole(item.chain) === undefined) return false;
        const last = this.qualificationLastAt.get(`${item.chain}:${item.tokenAddress}`);
        return last === undefined || nowMs - last >= QUALIFICATION_REFRESH_MS;
      })
      .sort((left, right) => {
        const leftAt = this.qualificationLastAt.get(`${left.chain}:${left.tokenAddress}`);
        const rightAt = this.qualificationLastAt.get(`${right.chain}:${right.tokenAddress}`);
        return (leftAt ?? Number.NEGATIVE_INFINITY) - (rightAt ?? Number.NEGATIVE_INFINITY);
      })[0];
    if (candidate === undefined) return;
    if (!this.config.chains[candidate.chain]) return;
    const key = `${candidate.chain}:${candidate.tokenAddress}`;
    this.qualificationLastAt.set(key, nowMs);
    const result = await this.qualification.refresh(
      candidate.chain,
      candidate.tokenAddress,
      this.abortController.signal
    );
    if (result.outcome !== 'ELIGIBLE' || result.eligibility === undefined) {
      if (result.outcome === 'REJECTED' || result.outcome === 'EXPIRED') {
        this.qualificationLastAt.delete(key);
        this.signalPreviewed.delete(key);
      }
      return;
    }
    const role = this.evaluation.signalRole(candidate.chain);
    if (role === undefined) return;
    if (!this.config.telegram.enabled) {
      if (!this.signalPreviewed.has(key)) {
        const preview = renderSignalMessage({
          eligibility: result.eligibility,
          channelRole: role,
          sendRequestedAtMs: this.now(),
          preSendPriceUsd: result.eligibility.decisionPriceUsd,
          preSendTradeAtMs: result.eligibility.decisionTradeAtMs
        });
        this.emit({ event: 'signal_preview_rendered', chain: candidate.chain, role, text: preview });
        this.signalPreviewed.add(key);
      }
      return;
    }
    const delivery = await this.delivery.sendSignal(
      result.eligibility,
      role,
      this.abortController.signal
    );
    this.emit({
      event: 'signal_delivery',
      chain: candidate.chain,
      role,
      outcome: delivery.outcome,
      reason: delivery.reason
    });
  }

  private emitProgress(): void {
    for (const entry of this.progress()) this.emit(entry);
  }

  private emit(entry: RuntimeEvent): void {
    this.log(entry, false);
  }

  private emitError(
    event: string,
    error: unknown,
    fields: Readonly<Record<string, unknown>> = {}
  ): void {
    this.log(
      { ...fields, event, error: formatSafeError(error, this.secrets) },
      true
    );
  }
}
