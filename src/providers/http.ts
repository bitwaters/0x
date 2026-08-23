import { sleep, type Sleep } from './runtime.js';

export type Fetcher = typeof fetch;

export class ProviderRequestError extends Error {
  constructor(
    readonly provider: 'gmgn' | 'coingecko',
    readonly operation: string,
    readonly kind: 'timeout' | 'network' | 'http' | 'response',
    readonly status?: number,
    readonly retryAtMs?: number
  ) {
    super(
      `${provider} ${operation} failed: ${kind}${status === undefined ? '' : ` ${status}`}${
        retryAtMs === undefined ? '' : `; retry after ${new Date(retryAtMs).toISOString()}`
      }`
    );
    this.name = 'ProviderRequestError';
  }
}

export interface JsonResponse {
  readonly value: unknown;
  readonly status: number;
  readonly headers: Headers;
}

async function retryDelay(
  response: Response,
  fallbackMs: number,
  now: () => number
): Promise<number> {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now());
  }
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now());
  if (response.status === 429) {
    try {
      const body = (await response.clone().json()) as { reset_at?: unknown };
      const bodyReset = Number(body.reset_at);
      if (Number.isFinite(bodyReset) && bodyReset > 0) {
        return Math.max(0, bodyReset * 1000 - now());
      }
    } catch {
      // The bounded exponential fallback below is safer than parsing arbitrary text.
    }
  }
  return fallbackMs;
}

export async function requestJson(input: {
  readonly provider: ProviderRequestError['provider'];
  readonly operation: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetcher?: Fetcher;
  readonly timeoutMs?: number;
  readonly maximumAttempts?: number;
  readonly maximumRetryDelayMs?: number;
  readonly wait?: Sleep;
  readonly beforeAttempt?: () => Promise<void>;
  readonly onRateLimited?: (retryAtMs: number) => void;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}): Promise<JsonResponse> {
  const fetcher = input.fetcher ?? fetch;
  const maximumAttempts = input.maximumAttempts ?? 3;
  const maximumRetryDelayMs = input.maximumRetryDelayMs ?? 5_000;
  const wait = input.wait ?? sleep;
  const now = input.now ?? Date.now;
  const callerAborted = () => input.signal?.aborted === true;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (callerAborted()) {
      throw new ProviderRequestError(input.provider, input.operation, 'network');
    }
    try {
      await input.beforeAttempt?.();
    } catch {
      if (callerAborted()) {
        throw new ProviderRequestError(input.provider, input.operation, 'network');
      }
      throw new ProviderRequestError(input.provider, input.operation, 'network');
    }
    if (callerAborted()) {
      throw new ProviderRequestError(input.provider, input.operation, 'network');
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort('provider_timeout'), input.timeoutMs ?? 3_000);
    let waitBeforeRetryMs: number | undefined;
    try {
      const response = await fetcher(input.url, {
        method: 'GET',
        headers: input.headers,
        signal: controller.signal
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          throw new ProviderRequestError(input.provider, input.operation, 'http', response.status);
        }
        const delay = await retryDelay(response, 200 * 2 ** (attempt - 1), now);
        const retryAtMs = now() + delay;
        if (response.status === 429) input.onRateLimited?.(retryAtMs);
        if (attempt === maximumAttempts || delay > maximumRetryDelayMs) {
          throw new ProviderRequestError(
            input.provider,
            input.operation,
            'http',
            response.status,
            retryAtMs
          );
        }
        waitBeforeRetryMs = delay;
      } else {
        const text = await response.text();
        if (text.length > 5_000_000) {
          throw new ProviderRequestError(input.provider, input.operation, 'response', response.status);
        }
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          throw new ProviderRequestError(
            input.provider,
            input.operation,
            'response',
            response.status
          );
        }
        return { value, status: response.status, headers: response.headers };
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      const timedOut = controller.signal.reason === 'provider_timeout';
      if (attempt === maximumAttempts || callerAborted()) {
        throw new ProviderRequestError(
          input.provider,
          input.operation,
          timedOut ? 'timeout' : 'network'
        );
      }
      waitBeforeRetryMs = 200 * 2 ** (attempt - 1);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortFromCaller);
    }

    try {
      await wait(waitBeforeRetryMs!, input.signal);
    } catch {
      throw new ProviderRequestError(input.provider, input.operation, 'network');
    }
  }

  throw new ProviderRequestError(input.provider, input.operation, 'network');
}
