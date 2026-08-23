export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    readonly tokensPerMinute: number,
    readonly capacity = tokensPerMinute,
    private readonly now: () => number = Date.now,
    private readonly wait: Sleep = sleep
  ) {
    if (tokensPerMinute <= 0 || capacity <= 0) {
      throw new RangeError('token bucket values must be positive');
    }
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  tryTake(cost = 1): boolean {
    if (cost <= 0 || cost > this.capacity) throw new RangeError('invalid token cost');
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  async take(cost = 1, signal?: AbortSignal): Promise<void> {
    while (!this.tryTake(cost)) {
      this.refill();
      const missing = cost - this.tokens;
      const waitMs = Math.max(1, Math.ceil((missing * 60_000) / this.tokensPerMinute));
      await this.wait(waitMs, signal);
    }
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefillMs);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed * this.tokensPerMinute) / 60_000
    );
    this.lastRefillMs = current;
  }
}

export class BoundedExecutor {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    readonly concurrency: number,
    readonly maximumQueue: number
  ) {
    if (concurrency <= 0 || maximumQueue < 0) throw new RangeError('invalid executor limits');
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.maximumQueue) throw new Error('provider queue is full');
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}
