import type { Chain, RuntimeConfig } from '../config.js';
import type { CandidateRecord } from '../db/repositories.js';
import type { GmgnTrendingSnapshot } from '../providers/gmgn.js';
import type { CandidateDiscoveryEngine } from './engine.js';
import { DISCOVERY_POLICY } from './policy.js';

type Interval = '1m' | '5m';

export interface TrendingSource {
  getTrending(
    chain: Chain,
    interval: Interval,
    limit: number,
    signal?: AbortSignal
  ): Promise<GmgnTrendingSnapshot>;
}

export class DiscoveryPoller {
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controllers = new Map<string, AbortController>();
  private running = false;
  private generation = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly activePolls = new Set<Promise<boolean>>();

  constructor(
    private readonly source: TrendingSource,
    private readonly engine: CandidateDiscoveryEngine,
    private readonly config: Pick<RuntimeConfig, 'chains' | 'polling'>,
    private readonly onError: (error: unknown, chain: Chain, interval: Interval) => void =
      () => undefined,
    private readonly onMaintenanceError: (error: unknown) => void = () => undefined,
    private readonly onQualificationsExpired: (
      candidates: readonly CandidateRecord[]
    ) => void = () => undefined
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    try {
      this.expireQualifications();
    } catch (error) {
      this.onMaintenanceError(error);
    }
    this.scheduleExpiry(generation);
    for (const chain of ['sol', 'bsc'] as const) {
      if (!this.config.chains[chain]) continue;
      for (const interval of ['1m', '5m'] as const) {
        const period = this.periodMs(interval);
        this.schedule(
          chain,
          interval,
          chain === 'sol' ? 0 : Math.floor(period / 2),
          generation
        );
      }
    }
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) controller.abort('poller_stopped');
    this.controllers.clear();
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.activePolls]);
  }

  pollOnce(chain: Chain, interval: Interval): Promise<boolean> {
    const work = this.pollOnceTracked(chain, interval);
    this.activePolls.add(work);
    void work.then(
      () => this.activePolls.delete(work),
      () => this.activePolls.delete(work)
    );
    return work;
  }

  private async pollOnceTracked(chain: Chain, interval: Interval): Promise<boolean> {
    const key = `${chain}:${interval}`;
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    try {
      const snapshot = await this.source.getTrending(
        chain,
        interval,
        DISCOVERY_POLICY.trendingLimit,
        controller.signal
      );
      await this.engine.acceptSnapshot(snapshot, controller.signal);
      return true;
    } finally {
      this.controllers.delete(key);
      this.inFlight.delete(key);
    }
  }

  private periodMs(interval: Interval): number {
    return interval === '1m'
      ? this.config.polling.oneMinuteMs
      : this.config.polling.fiveMinuteMs;
  }

  private schedule(
    chain: Chain,
    interval: Interval,
    delayMs: number,
    generation: number
  ): void {
    if (!this.running || generation !== this.generation) return;
    const key = `${chain}:${interval}`;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (!this.running || generation !== this.generation) return;
      const startedAtMs = Date.now();
      void this.pollOnce(chain, interval)
        .catch((error) => this.onError(error, chain, interval))
        .finally(() =>
          this.schedule(
            chain,
            interval,
            Math.max(0, this.periodMs(interval) - (Date.now() - startedAtMs)),
            generation
          )
        );
    }, delayMs);
    this.timers.set(key, timer);
  }

  private scheduleExpiry(generation: number): void {
    if (!this.running || generation !== this.generation) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      if (!this.running || generation !== this.generation) return;
      try {
        this.expireQualifications();
      } catch (error) {
        this.onMaintenanceError(error);
      }
      this.scheduleExpiry(generation);
    }, 1_000);
  }

  private expireQualifications(): void {
    const expired = this.engine.expireQualificationWindows();
    this.onQualificationsExpired(expired);
  }
}
