import type { Chain, RuntimeConfig } from '../config.js';
import type { SqliteDatabase } from '../db/database.js';
import { withTransaction } from '../db/database.js';
import {
  CandidateRepository,
  OutboxRepository,
  QualificationEventRepository,
  SignalFollowupRepository,
  SignalRecheckRepository,
  type SignalRecheckRecord
} from '../db/repositories.js';
import { normalizeAddress } from '../domain/address.js';
import { EvaluationRepository } from '../evaluation/repository.js';
import type { SendEligibilitySnapshot } from '../qualification/snapshot.js';
import { evaluateLiquiditySample, evaluateTradeWindow } from '../qualification/rules.js';
import { QUALIFICATION_POLICY } from '../qualification/policy.js';
import type { CoinGeckoClient, CoinGeckoPoolDetail, CoinGeckoTrade } from '../providers/coingecko.js';
import type {
  GmgnClient,
  GmgnTokenSecurity,
  GmgnTrendingSnapshot
} from '../providers/gmgn.js';
import {
  evaluateGmgnSecurity,
  evaluateGmgnTokenSecurity,
  gmgnThresholds
} from '../providers/gmgn.js';
import { ProviderRequestError } from '../providers/http.js';
import { formatSafeError } from '../security/redaction.js';
import {
  renderRadarCard,
  renderSignalCard,
  renderSignalEditCard,
  type DeliveredSignalSnapshot,
  type RadarMessageSnapshot
} from './messages.js';
import { TELEGRAM_DELIVERY_POLICY } from './policy.js';
import {
  TelegramExplicitError,
  type TelegramTransportLike
} from './transport.js';

export interface DeliveryCoinGeckoSource {
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

export interface DeliveryGmgnSource {
  getTrending(
    chain: Chain,
    interval: '1m' | '5m',
    limit?: number,
    signal?: AbortSignal
  ): Promise<GmgnTrendingSnapshot>;
  getTokenSecurity(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<GmgnTokenSecurity>;
}

export interface DeliveryResult {
  readonly outcome:
    | 'SENT'
    | 'RETRYABLE_FAILURE'
    | 'UNCERTAIN'
    | 'SUPPRESSED'
    | 'DUPLICATE';
  readonly reason?: string;
}

export class TelegramDeliveryService {
  private readonly candidates: CandidateRepository;
  private readonly outbox: OutboxRepository;
  private readonly events: QualificationEventRepository;
  private readonly followups: SignalFollowupRepository;
  private readonly rechecks: SignalRecheckRepository;
  private readonly evaluations: EvaluationRepository;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly serialTails = new Map<string, Promise<void>>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly config: RuntimeConfig,
    private readonly coinGecko: DeliveryCoinGeckoSource | CoinGeckoClient,
    private readonly gmgn: DeliveryGmgnSource | GmgnClient,
    private readonly telegram: TelegramTransportLike,
    private readonly now: () => number = Date.now,
    private readonly retainPool: (
      chain: Chain,
      tokenAddress: string,
      poolAddress: string
    ) => void = () => undefined,
    private readonly releasePool: (chain: Chain, tokenAddress: string) => void = () => undefined
  ) {
    this.candidates = new CandidateRepository(database);
    this.outbox = new OutboxRepository(database);
    this.events = new QualificationEventRepository(database);
    this.followups = new SignalFollowupRepository(database);
    this.rechecks = new SignalRecheckRepository(database);
    this.evaluations = new EvaluationRepository(database);
  }

  start(): void {
    for (const followup of this.followups.listOpen()) {
      const snapshot = followup.snapshot as DeliveredSignalSnapshot;
      this.retainPool(
        followup.chain,
        followup.tokenAddress,
        snapshot.eligibility.pool.poolAddress
      );
    }
  }

  async sendSignal(
    eligibility: SendEligibilitySnapshot,
    channelRole: 'validation' | 'formal',
    signal?: AbortSignal
  ): Promise<DeliveryResult> {
    const token = normalizeAddress(eligibility.chain, eligibility.tokenAddress);
    return this.singleFlight(`send:${eligibility.chain}:${token}`, () =>
      this.sendSignalOnce(eligibility, channelRole, signal)
    );
  }

  async sendRadar(
    snapshot: RadarMessageSnapshot,
    signal?: AbortSignal
  ): Promise<DeliveryResult> {
    const token = normalizeAddress(snapshot.chain, snapshot.tokenAddress);
    return this.singleFlight(`radar:${snapshot.chain}:${token}`, async () => {
      const existing = this.outbox.find(snapshot.chain, token, 'radar');
      if (existing !== undefined && existing.status !== 'PENDING') {
        return { outcome: 'DUPLICATE' };
      }
      const requestedAtMs = this.now();
      const card = renderRadarCard({ ...snapshot, tokenAddress: token });
      const { text } = card;
      const record =
        existing ??
        this.outbox.createOrGet({
          chain: snapshot.chain,
          tokenAddress: token,
          messageKind: 'radar',
          channelRole: 'radar',
          payload: { text, snapshot },
          createdAtMs: requestedAtMs
        }).record;
      if (record.status !== 'PENDING') return { outcome: 'DUPLICATE' };
      this.outbox.updatePendingPayload(record.id, { text, snapshot }, requestedAtMs);
      this.outbox.claim(record.id, requestedAtMs);
      try {
        const receipt = await this.telegram.sendMessage(
          this.chatId('radar'),
          text,
          signal,
          card.options
        );
        this.outbox.markSent(record.id, receipt.messageId, this.now());
        return { outcome: 'SENT' };
      } catch (error) {
        return this.handleSendFailure(record.id, error);
      }
    });
  }

  async refreshPrice(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<void> {
    const token = normalizeAddress(chain, tokenAddress);
    await this.runSerial(`followup:${chain}:${token}`, async () => {
      const followup = this.followups.find(chain, token);
      if (followup === undefined || !['ACTIVE', 'DONT_CHASE'].includes(followup.desiredState)) {
        return;
      }
      const snapshot = followup.snapshot as DeliveredSignalSnapshot;
      try {
        const detail = await this.coinGecko.getPoolDetail(
          chain,
          snapshot.eligibility.pool.poolAddress,
          token,
          signal
        );
        if (
          !this.samePoolComposition(
            (followup.snapshot as DeliveredSignalSnapshot).eligibility,
            detail
          )
        ) {
          this.invalidate(chain, token, 'POOL_COMPOSITION_CHANGED', this.now());
          await this.flushEdit(chain, token, signal);
          return;
        }
        const liquidity = evaluateLiquiditySample(
          detail,
          this.config.thresholds.liquidityMinUsd
        );
        const reserveDecline =
          ((followup.snapshot as DeliveredSignalSnapshot).eligibility.pool.reserveUsd -
            detail.reserveUsd) /
          (followup.snapshot as DeliveredSignalSnapshot).eligibility.pool.reserveUsd;
        if (
          !liquidity.passed ||
          reserveDecline > QUALIFICATION_POLICY.liquidityMaxDeclineRatio
        ) {
          this.invalidate(
            chain,
            token,
            liquidity.reasons[0] ?? 'POOL_LIQUIDITY_DECLINE',
            this.now()
          );
          await this.flushEdit(chain, token, signal);
          return;
        }
        const trades = evaluateTradeWindow(
          await this.coinGecko.getPoolTrades(detail, signal),
          this.now()
        );
        if (
          trades.decisionPriceUsd === null ||
          trades.reasons.includes('TRADE_ID_CONFLICT') ||
          trades.reasons.includes('LATEST_TRADE_STALE')
        ) {
          return;
        }
        const absoluteMove = Math.abs(trades.decisionPriceUsd - followup.preSendPriceUsd);
        if (
          absoluteMove >
          followup.preSendPriceUsd * TELEGRAM_DELIVERY_POLICY.expireDriftRatio
        ) {
          this.followups.setDesired(chain, token, 'EXPIRED', '价格绝对漂移超过15%', this.now());
        } else if (
          absoluteMove >
          followup.preSendPriceUsd * TELEGRAM_DELIVERY_POLICY.dontChaseDriftRatio
        ) {
          this.followups.setDesired(chain, token, 'DONT_CHASE', '价格绝对漂移超过8%', this.now());
        }
      } catch (error) {
        if (
          error instanceof ProviderRequestError &&
          error.provider === 'coingecko' &&
          error.operation === 'pool_detail' &&
          error.status === 404
        ) {
          this.invalidate(chain, token, 'FIXED_POOL_MISSING', this.now());
          await this.flushEdit(chain, token, signal);
        }
        return;
      }
      await this.flushEdit(chain, token, signal);
    });
  }

  async tick(signal?: AbortSignal): Promise<void> {
    const nowMs = this.now();
    for (const followup of this.followups.listOpen()) {
      if (nowMs >= followup.expiresAtMs) {
        this.followups.setDesired(
          followup.chain,
          followup.tokenAddress,
          'EXPIRED',
          '90秒有效期结束',
          nowMs
        );
      }
    }
    for (const recheck of this.rechecks.listDue(nowMs)) {
      await this.runRecheck(recheck, signal);
    }
    for (const followup of this.followups.listPendingEdits()) {
      await this.runSerial(
        `followup:${followup.chain}:${followup.tokenAddress}`,
        () => this.flushEdit(followup.chain, followup.tokenAddress, signal)
      );
    }
  }

  private async sendSignalOnce(
    eligibility: SendEligibilitySnapshot,
    requestedRole: 'validation' | 'formal',
    signal?: AbortSignal
  ): Promise<DeliveryResult> {
    const { chain } = eligibility;
    const token = normalizeAddress(chain, eligibility.tokenAddress);
    const existing = this.outbox.find(chain, token, 'signal');
    if (existing !== undefined && existing.status !== 'PENDING') {
      return { outcome: 'DUPLICATE' };
    }
    const releaseState = this.evaluations.chainState(chain).state;
    const expectedRole = releaseState === 'VALIDATING' ? 'validation' : 'formal';
    if (releaseState === 'SUSPENDED' || requestedRole !== expectedRole) {
      return { outcome: 'SUPPRESSED', reason: 'CHAIN_RELEASE_STATE_MISMATCH' };
    }
    if (existing !== undefined && existing.channelRole !== requestedRole) {
      this.outbox.updatePendingChannelRole(existing.id, requestedRole, this.now());
    }
    if (!this.isCandidateSendable(eligibility)) {
      return { outcome: 'SUPPRESSED', reason: 'ELIGIBILITY_NO_LONGER_CURRENT' };
    }
    let preSendTrades;
    try {
      const verifiedPool = await this.coinGecko.getPoolDetail(
        chain,
        eligibility.pool.poolAddress,
        token,
        signal
      );
      if (!this.samePoolComposition(eligibility, verifiedPool)) {
        return { outcome: 'SUPPRESSED', reason: 'POOL_COMPOSITION_CHANGED' };
      }
      const preSendLiquidity = evaluateLiquiditySample(
        verifiedPool,
        this.config.thresholds.liquidityMinUsd
      );
      const preSendReserveDecline =
        (eligibility.pool.reserveUsd - verifiedPool.reserveUsd) /
        eligibility.pool.reserveUsd;
      if (
        !preSendLiquidity.passed ||
        preSendReserveDecline > QUALIFICATION_POLICY.liquidityMaxDeclineRatio
      ) {
        return {
          outcome: 'SUPPRESSED',
          reason: preSendLiquidity.reasons[0] ?? 'POOL_LIQUIDITY_DECLINE'
        };
      }
      preSendTrades = evaluateTradeWindow(
        await this.coinGecko.getPoolTrades(verifiedPool, signal),
        this.now()
      );
    } catch (error) {
      return { outcome: 'SUPPRESSED', reason: this.safeError(error) };
    }
    if (
      !preSendTrades.passed ||
      preSendTrades.decisionPriceUsd === null ||
      preSendTrades.latestTradeAtMs === null
    ) {
      return { outcome: 'SUPPRESSED', reason: preSendTrades.reasons[0] ?? 'PRICE_NOT_FRESH' };
    }
    const drift = Math.abs(
      preSendTrades.decisionPriceUsd / eligibility.decisionPriceUsd - 1
    );
    if (
      Math.abs(preSendTrades.decisionPriceUsd - eligibility.decisionPriceUsd) >
      eligibility.decisionPriceUsd * TELEGRAM_DELIVERY_POLICY.preSendMaxDriftRatio
    ) {
      this.events.record({
        chain,
        tokenAddress: token,
        stage: 'telegram_pre_send',
        outcome: 'REJECT',
        reasonCode: 'PRE_SEND_DRIFT_REJECTED',
        source: 'coingecko',
        observedAtMs: this.now(),
        raw: { trades: preSendTrades.trades.map((trade) => trade.raw) },
        normalized: {
          decisionPriceUsd: eligibility.decisionPriceUsd,
          preSendPriceUsd: preSendTrades.decisionPriceUsd,
          driftRatio: drift
        },
        thresholds: { maxDriftRatio: TELEGRAM_DELIVERY_POLICY.preSendMaxDriftRatio },
        decisionRuleVersion: eligibility.ruleVersion
      });
      return { outcome: 'SUPPRESSED', reason: 'PRE_SEND_DRIFT_REJECTED' };
    }
    if (!this.isCandidateSendable(eligibility)) {
      return { outcome: 'SUPPRESSED', reason: 'ELIGIBILITY_NO_LONGER_CURRENT' };
    }

    const requestedAtMs = this.now();
    const role = requestedRole;
    const delivered: DeliveredSignalSnapshot = {
      eligibility,
      channelRole: role,
      sendRequestedAtMs: requestedAtMs,
      preSendPriceUsd: preSendTrades.decisionPriceUsd,
      preSendTradeAtMs: preSendTrades.latestTradeAtMs
    };
    const card = renderSignalCard(delivered);
    const { text } = card;
    const payload = { text, snapshot: delivered };
    const record =
      existing ??
      this.outbox.createOrGet({
        chain,
        tokenAddress: token,
        messageKind: 'signal',
        channelRole: role,
        payload,
        createdAtMs: requestedAtMs
      }).record;
    if (record.status !== 'PENDING') return { outcome: 'DUPLICATE' };
    this.outbox.updatePendingPayload(record.id, payload, requestedAtMs);
    this.outbox.claim(record.id, requestedAtMs);
    let receipt;
    try {
      receipt = await this.telegram.sendMessage(
        this.chatId(role),
        text,
        signal,
        card.options
      );
    } catch (error) {
      return this.handleSendFailure(record.id, error);
    }
    const receiptAtMs = this.now();
    try {
      withTransaction(this.database, () => {
        this.outbox.markSent(record.id, receipt.messageId, receiptAtMs);
        this.followups.create({
          chain,
          tokenAddress: token,
          outboxId: record.id,
          preSendPriceUsd: preSendTrades.decisionPriceUsd!,
          preSendTradeAtMs: preSendTrades.latestTradeAtMs!,
          receiptAtMs,
          snapshot: delivered
        });
        this.evaluations.recordDelivered({
          outboxId: record.id,
          snapshot: delivered,
          receiptAtMs
        });
        this.candidates.transition(chain, token, 'SIGNAL_SENT', {
          atMs: receiptAtMs,
          terminalReason: 'SIGNAL_SENT'
        });
      });
    } catch (error) {
      this.outbox.markUncertain(record.id, 'post_send_persistence_failed', receiptAtMs);
      return { outcome: 'UNCERTAIN', reason: this.safeError(error) };
    }
    this.retainPool(chain, token, eligibility.pool.poolAddress);
    return { outcome: 'SENT' };
  }

  private async runRecheck(
    recheck: SignalRecheckRecord,
    signal?: AbortSignal
  ): Promise<void> {
    await this.runSerial(
      `followup:${recheck.chain}:${recheck.tokenAddress}`,
      async () => {
        const followup = this.followups.find(recheck.chain, recheck.tokenAddress);
        if (followup === undefined) return;
        if (!['ACTIVE', 'DONT_CHASE'].includes(followup.desiredState)) {
          this.rechecks.markComplete(recheck, this.now());
          return;
        }
        const snapshot = followup.snapshot as DeliveredSignalSnapshot;
        try {
          const [security, detail] = await Promise.all([
            this.gmgn.getTokenSecurity(recheck.chain, recheck.tokenAddress, signal),
            this.coinGecko.getPoolDetail(
              recheck.chain,
              snapshot.eligibility.pool.poolAddress,
              recheck.tokenAddress,
              signal
            )
          ]);
          const tokenSecurity = evaluateGmgnTokenSecurity({
            chain: recheck.chain,
            security,
            thresholds: gmgnThresholds(this.config),
            nowMs: this.now()
          });
          const liquidity = evaluateLiquiditySample(
            detail,
            this.config.thresholds.liquidityMinUsd
          );
          if (!this.samePoolComposition(snapshot.eligibility, detail)) {
            this.invalidate(
              recheck.chain,
              recheck.tokenAddress,
              'POOL_COMPOSITION_CHANGED',
              this.now()
            );
            this.rechecks.markComplete(recheck, this.now());
            return;
          }
          const liquidityDecline =
            (snapshot.eligibility.pool.reserveUsd - detail.reserveUsd) /
            snapshot.eligibility.pool.reserveUsd;
          if (
            !tokenSecurity.passed ||
            !liquidity.passed ||
            liquidityDecline > QUALIFICATION_POLICY.liquidityMaxDeclineRatio
          ) {
            const reason =
              tokenSecurity.reasons[0] ??
              liquidity.reasons[0] ??
              'POOL_LIQUIDITY_DECLINE';
            this.invalidate(recheck.chain, recheck.tokenAddress, reason, this.now());
            this.rechecks.markComplete(recheck, this.now());
            return;
          }
          const optionalTrending = await this.gmgn.getTrending(
            recheck.chain,
            '1m',
            100,
            signal
          );
          const matchingItems =
            optionalTrending?.items.filter(
              (entry) =>
                normalizeAddress(recheck.chain, entry.tokenAddress) === recheck.tokenAddress
            ) ?? [];
          if (matchingItems.length > 1) {
            throw new Error('duplicate candidate in GMGN recheck rank');
          }
          const item = matchingItems[0];
          if (item !== undefined && optionalTrending !== undefined) {
            const combined = evaluateGmgnSecurity({
              chain: recheck.chain,
              trending: item,
              trendingFetchedAtMs: optionalTrending.fetchedAtMs,
              security,
              thresholds: gmgnThresholds(this.config),
              nowMs: this.now()
            });
            if (!combined.passed) {
              this.invalidate(
                recheck.chain,
                recheck.tokenAddress,
                combined.reasons[0]!,
                this.now()
              );
            }
          }
          this.rechecks.markComplete(recheck, this.now());
        } catch (error) {
          if (
            error instanceof ProviderRequestError &&
            error.provider === 'coingecko' &&
            error.operation === 'pool_detail' &&
            error.status === 404
          ) {
            this.invalidate(
              recheck.chain,
              recheck.tokenAddress,
              'FIXED_POOL_MISSING',
              this.now()
            );
            this.rechecks.markComplete(recheck, this.now());
            return;
          }
          const safeError = this.safeError(error);
          const finalFailure = this.rechecks.markFailure(recheck, safeError, this.now());
          if (finalFailure) {
            this.invalidate(
              recheck.chain,
              recheck.tokenAddress,
              `数据不可确认: ${safeError}`,
              this.now()
            );
          }
        }
      }
    );
  }

  private invalidate(chain: Chain, tokenAddress: string, reason: string, atMs: number): void {
    this.followups.setDesired(chain, tokenAddress, 'INVALID', reason, atMs);
    this.events.record({
      chain,
      tokenAddress,
      stage: 'telegram_followup',
      outcome: 'REJECT',
      reasonCode: 'SIGNAL_INVALIDATED',
      source: 'system',
      observedAtMs: atMs,
      raw: {},
      normalized: { reason },
      thresholds: TELEGRAM_DELIVERY_POLICY,
      decisionRuleVersion: this.config.ruleVersion
    });
  }

  private async flushEdit(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<void> {
    const followup = this.followups.find(chain, tokenAddress);
    if (followup === undefined || followup.desiredState === followup.appliedState) return;
    if (followup.desiredState === 'EXPIRED' || followup.desiredState === 'INVALID') {
      this.releasePool(chain, tokenAddress);
    }
    const outbox = this.outbox.find(chain, tokenAddress, 'signal');
    if (outbox?.status !== 'SENT' || outbox.telegramMessageId === null) return;
    const snapshot = followup.snapshot as DeliveredSignalSnapshot;
    const card = renderSignalEditCard(
      snapshot,
      followup.desiredState === 'ACTIVE' ? 'DONT_CHASE' : followup.desiredState,
      followup.desiredReason ?? '状态更新'
    );
    try {
      await this.telegram.editMessage(
        this.chatId(outbox.channelRole),
        outbox.telegramMessageId,
        card.text,
        signal,
        card.options
      );
      this.followups.markApplied(chain, tokenAddress, followup.desiredState, this.now());
    } catch (error) {
      if (
        error instanceof TelegramExplicitError &&
        error.description.toLowerCase().includes('message is not modified')
      ) {
        this.followups.markApplied(chain, tokenAddress, followup.desiredState, this.now());
        return;
      }
      this.followups.markEditFailure(chain, tokenAddress, this.safeError(error), this.now());
    }
  }

  private handleSendFailure(id: number, error: unknown): DeliveryResult {
    const atMs = this.now();
    if (error instanceof TelegramExplicitError) {
      this.outbox.markExplicitFailure(id, this.safeError(error), atMs);
      return { outcome: 'RETRYABLE_FAILURE', reason: this.safeError(error) };
    }
    this.outbox.markUncertain(id, this.safeError(error), atMs);
    return { outcome: 'UNCERTAIN', reason: this.safeError(error) };
  }

  private chatId(role: 'radar' | 'validation' | 'formal'): string {
    if (!this.config.telegram.enabled) throw new Error('Telegram delivery is disabled');
    if (role === 'radar') return this.config.telegram.radarChatId;
    if (role === 'validation') return this.config.telegram.validationChatId;
    return this.config.telegram.formalChatId;
  }

  private safeError(error: unknown): string {
    const secrets = this.config.telegram.enabled
      ? [this.config.telegram.botToken, this.config.telegram.radarChatId,
          this.config.telegram.validationChatId, this.config.telegram.formalChatId]
      : [];
    return formatSafeError(error, secrets);
  }

  private isCandidateSendable(eligibility: SendEligibilitySnapshot): boolean {
    const nowMs = this.now();
    const candidate = this.candidates.find(eligibility.chain, eligibility.tokenAddress);
    return (
      candidate?.status === 'MONITORING' &&
      eligibility.ruleVersion === this.config.ruleVersion &&
      candidate.decisionRuleVersion === eligibility.ruleVersion &&
      candidate.qualificationStartedAtMs !== null &&
      nowMs <
        candidate.qualificationStartedAtMs +
          this.config.thresholds.qualificationWindowSeconds * 1_000 &&
      nowMs >= eligibility.qualifiedAtMs &&
      nowMs <= eligibility.validUntilMs
    );
  }

  private samePoolComposition(
    expected: SendEligibilitySnapshot,
    detail: CoinGeckoPoolDetail
  ): boolean {
    const pool = expected.pool;
    return (
      detail.chain === pool.chain &&
      detail.poolAddress === pool.poolAddress &&
      detail.candidateTokenAddress === pool.candidateTokenAddress &&
      detail.candidateSide === pool.candidateSide &&
      detail.counterTokenAddress === pool.counterTokenAddress &&
      detail.baseTokenAddress === pool.baseTokenAddress &&
      detail.quoteTokenAddress === pool.quoteTokenAddress
    );
  }

  private async singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return existing;
    const promise = work().finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async runSerial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serialTails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.serialTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.serialTails.get(key) === tail) this.serialTails.delete(key);
    }
  }
}
