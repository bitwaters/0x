import { randomUUID } from 'node:crypto';

import type { Chain, RuntimeConfig } from '../config.js';
import { normalizeAddress } from '../domain/address.js';
import {
  ContractError,
  arrayValue,
  booleanValue,
  decimalStringValue,
  numberValue,
  recordValue,
  stringValue,
  timestampMsFromSeconds
} from './contracts.js';
import { requestJson, type Fetcher } from './http.js';
import { BoundedExecutor, TokenBucket, sleep, type Sleep } from './runtime.js';
import { GMGN_TRENDING_FILTERS, marketProviderRestUrl } from './sourcePolicy.js';

export interface GmgnTrendingItem {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly name: string;
  readonly symbol: string;
  readonly rank: number;
  readonly priceUsd: number;
  readonly marketCapUsd: number;
  readonly liquidityUsd: number;
  readonly openAtMs: number | null;
  readonly createdAtMs: number | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GmgnTrendingSnapshot {
  readonly chain: Chain;
  readonly interval: '1m' | '5m';
  readonly fetchedAtMs: number;
  readonly filters: readonly string[];
  readonly items: readonly GmgnTrendingItem[];
}

export interface GmgnTokenInfo {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly biggestPoolAddress: string | null;
  readonly priceUsd: number;
  readonly liquidityUsd: number;
  readonly openAtMs: number | null;
  readonly poolCreatedAtMs: number | null;
  readonly fetchedAtMs: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GmgnTokenSecurity {
  readonly chain: Chain;
  readonly tokenAddress: string;
  readonly fetchedAtMs: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

function unwrapGmgnResponse(operation: string, value: unknown): Record<string, unknown> {
  const envelope = recordValue('gmgn', operation, 'response', value);
  const code = numberValue('gmgn', operation, 'response.code', envelope.code, {
    integer: true
  });
  if (code !== 0) throw new ContractError('gmgn', operation, 'response.code', 'must equal 0');
  return recordValue('gmgn', operation, 'response.data', envelope.data);
}

function optionalUnixTimestamp(
  operation: string,
  field: string,
  value: unknown
): number | null {
  if (value === undefined || value === null) return null;
  return timestampMsFromSeconds('gmgn', operation, field, value, true);
}

function parseTrendingItem(
  expectedChain: Chain,
  value: unknown,
  index: number
): GmgnTrendingItem {
  const operation = 'trending';
  const field = `data.rank[${index}]`;
  const raw = recordValue('gmgn', operation, field, value);
  const chain = stringValue('gmgn', operation, `${field}.chain`, raw.chain);
  if (chain !== expectedChain) {
    throw new ContractError('gmgn', operation, `${field}.chain`, 'does not match request');
  }
  const name = stringValue('gmgn', operation, `${field}.name`, raw.name).trim();
  const symbol = stringValue('gmgn', operation, `${field}.symbol`, raw.symbol).trim();
  if (name === '') {
    throw new ContractError('gmgn', operation, `${field}.name`, 'must not be blank');
  }
  if (symbol === '') {
    throw new ContractError('gmgn', operation, `${field}.symbol`, 'must not be blank');
  }
  return {
    chain: expectedChain,
    tokenAddress: normalizeAddress(
      expectedChain,
      stringValue('gmgn', operation, `${field}.address`, raw.address)
    ),
    name,
    symbol,
    rank: numberValue('gmgn', operation, `${field}.rank`, raw.rank, {
      integer: true,
      minimum: 1
    }),
    priceUsd: numberValue('gmgn', operation, `${field}.price`, raw.price, {
      positive: true
    }),
    marketCapUsd: numberValue(
      'gmgn',
      operation,
      `${field}.market_cap`,
      raw.market_cap,
      { minimum: 0 }
    ),
    liquidityUsd: numberValue('gmgn', operation, `${field}.liquidity`, raw.liquidity, {
      minimum: 0
    }),
    openAtMs: optionalUnixTimestamp(operation, `${field}.open_timestamp`, raw.open_timestamp),
    createdAtMs: optionalUnixTimestamp(
      operation,
      `${field}.creation_timestamp`,
      raw.creation_timestamp
    ),
    raw
  };
}

export class GmgnClient {
  private readonly limiter: TokenBucket;
  private readonly executors: Readonly<Record<Chain, BoundedExecutor>>;
  private readonly fetcher: Fetcher | undefined;
  private readonly wait: Sleep | undefined;
  private cooldownUntilMs = 0;

  constructor(
    private readonly apiKey: string,
    options: {
      readonly fetcher?: Fetcher;
      readonly wait?: Sleep;
      readonly now?: () => number;
      readonly limiter?: TokenBucket;
      readonly requestsPerMinute?: number;
    } = {}
  ) {
    this.fetcher = options.fetcher;
    this.wait = options.wait;
    this.now = options.now ?? Date.now;
    const requestsPerMinute = options.requestsPerMinute ?? 120;
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 120) {
      throw new RangeError('GMGN requests per minute must be between 1 and 120');
    }
    this.limiter = options.limiter ?? new TokenBucket(
      requestsPerMinute,
      1,
      this.now,
      options.wait
    );
    this.executors = {
      sol: new BoundedExecutor(2, 100),
      bsc: new BoundedExecutor(2, 100)
    };
  }

  private readonly now: () => number;

  async getTrending(
    chain: Chain,
    interval: '1m' | '5m',
    limit = 100,
    signal?: AbortSignal
  ): Promise<GmgnTrendingSnapshot> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('GMGN trending limit must be between 1 and 100');
    }
    const filters = GMGN_TRENDING_FILTERS[chain];
    const data = await this.get(
      chain,
      'trending',
      '/v1/market/rank',
      { chain, interval, limit, filters },
      signal
    );
    const innerCode = numberValue('gmgn', 'trending', 'data.code', data.code, {
      integer: true
    });
    if (innerCode !== 0) {
      throw new ContractError('gmgn', 'trending', 'data.code', 'must equal 0');
    }
    const innerData = recordValue('gmgn', 'trending', 'data.data', data.data);
    const rank = arrayValue('gmgn', 'trending', 'data.data.rank', innerData.rank);
    return {
      chain,
      interval,
      fetchedAtMs: this.now(),
      filters,
      items: rank.map((item, index) => parseTrendingItem(chain, item, index))
    };
  }

  async getTokenInfo(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<GmgnTokenInfo> {
    const normalizedToken = normalizeAddress(chain, tokenAddress);
    const data = await this.get(
      chain,
      'token_info',
      '/v1/token/info',
      { chain, address: normalizedToken },
      signal
    );
    const returnedToken = normalizeAddress(
      chain,
      stringValue('gmgn', 'token_info', 'data.address', data.address)
    );
    if (returnedToken !== normalizedToken) {
      throw new ContractError('gmgn', 'token_info', 'data.address', 'does not match request');
    }
    const price = recordValue('gmgn', 'token_info', 'data.price', data.price);
    const rawPoolAddress = stringValue(
      'gmgn',
      'token_info',
      'data.biggest_pool_address',
      data.biggest_pool_address,
      true
    ).trim();
    const pool =
      rawPoolAddress === ''
        ? null
        : recordValue('gmgn', 'token_info', 'data.pool', data.pool);
    return {
      chain,
      tokenAddress: returnedToken,
      biggestPoolAddress:
        rawPoolAddress === '' ? null : normalizeAddress(chain, rawPoolAddress),
      priceUsd: decimalStringValue('gmgn', 'token_info', 'data.price.price', price.price, {
        positive: true
      }),
      liquidityUsd: decimalStringValue('gmgn', 'token_info', 'data.liquidity', data.liquidity, {
        minimum: 0
      }),
      openAtMs: optionalUnixTimestamp(
        'token_info',
        'data.open_timestamp',
        data.open_timestamp
      ),
      poolCreatedAtMs: optionalUnixTimestamp(
        'token_info',
        'data.pool.creation_timestamp',
        pool?.creation_timestamp
      ),
      fetchedAtMs: this.now(),
      raw: data
    };
  }

  async getTokenSecurity(
    chain: Chain,
    tokenAddress: string,
    signal?: AbortSignal
  ): Promise<GmgnTokenSecurity> {
    const normalizedToken = normalizeAddress(chain, tokenAddress);
    const data = await this.get(
      chain,
      'token_security',
      '/v1/token/security',
      { chain, address: normalizedToken },
      signal
    );
    const returnedToken = normalizeAddress(
      chain,
      stringValue('gmgn', 'token_security', 'data.address', data.address)
    );
    if (returnedToken !== normalizedToken) {
      throw new ContractError('gmgn', 'token_security', 'data.address', 'does not match request');
    }
    return { chain, tokenAddress: returnedToken, fetchedAtMs: this.now(), raw: data };
  }

  private async get(
    chain: Chain,
    operation: string,
    path: string,
    query: Readonly<Record<string, string | number | readonly string[]>>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.executors[chain].run(async () => {
      const url = marketProviderRestUrl('gmgn', path);
      for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, item);
        } else {
          url.searchParams.set(key, String(value));
        }
      }
      const response = await requestJson({
        provider: 'gmgn',
        operation,
        url,
        headers: {
          'X-APIKEY': this.apiKey,
          Accept: 'application/json',
          'User-Agent': 'low-cap-meme-signal-bot/0.1.0'
        },
        ...(this.fetcher === undefined ? {} : { fetcher: this.fetcher }),
        ...(this.wait === undefined ? {} : { wait: this.wait }),
        timeoutMs: 3_000,
        maximumAttempts: 3,
        maximumRetryDelayMs: 5_000,
        now: this.now,
        beforeAttempt: async () => {
          while (true) {
            const cooldownMs = this.cooldownUntilMs - this.now();
            if (cooldownMs > 0) {
              await (this.wait ?? sleep)(cooldownMs, signal);
            }
            await this.limiter.take(1, signal);
            if (this.cooldownUntilMs <= this.now()) break;
          }
          url.searchParams.set('timestamp', String(Math.floor(this.now() / 1000)));
          url.searchParams.set('client_id', randomUUID());
        },
        onRateLimited: (retryAtMs) => {
          this.cooldownUntilMs = Math.max(this.cooldownUntilMs, retryAtMs);
        },
        ...(signal === undefined ? {} : { signal })
      });
      return unwrapGmgnResponse(operation, response.value);
    });
  }
}

export interface GmgnSecurityThresholds {
  readonly top10MaxRatio: number;
  readonly insiderMaxRatio: number;
  readonly bundlerMaxRatio: number;
  readonly devTeamMaxRatio: number;
  readonly rugMaxRatio: number;
  readonly taxMaxRatio: number;
}

export interface GmgnSecurityDecision {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly normalized: Readonly<Record<string, number | boolean>>;
  readonly raw: {
    readonly trending: Readonly<Record<string, unknown>>;
    readonly security: Readonly<Record<string, unknown>>;
  };
}

export interface GmgnTokenSecurityDecision {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly normalized: Readonly<Record<string, number | boolean>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export function evaluateGmgnTokenSecurity(input: {
  readonly chain: Chain;
  readonly security: GmgnTokenSecurity;
  readonly thresholds: GmgnSecurityThresholds;
  readonly nowMs: number;
}): GmgnTokenSecurityDecision {
  if (input.security.chain !== input.chain) {
    throw new ContractError('gmgn', 'token_security_decision', 'chain', 'does not match');
  }
  if (
    input.nowMs - input.security.fetchedAtMs > 30_000 ||
    input.security.fetchedAtMs > input.nowMs + 2_000
  ) {
    throw new ContractError(
      'gmgn',
      'token_security_decision',
      'security.fetched_at',
      'is stale'
    );
  }
  const security = input.security.raw;
  const normalized: Record<string, number | boolean> = {
    top10Ratio: decimalStringValue(
      'gmgn',
      'token_security_decision',
      'security.top_10_holder_rate',
      security.top_10_holder_rate,
      { minimum: 0, maximum: 1 }
    )
  };
  if (input.chain === 'sol') {
    normalized.renouncedMint = booleanValue(
      'gmgn',
      'token_security_decision',
      'security.renounced_mint',
      security.renounced_mint
    );
    normalized.renouncedFreezeAccount = booleanValue(
      'gmgn',
      'token_security_decision',
      'security.renounced_freeze_account',
      security.renounced_freeze_account
    );
  } else {
    normalized.honeypot = booleanValue(
      'gmgn',
      'token_security_decision',
      'security.is_honeypot',
      security.is_honeypot
    );
    normalized.openSource = booleanValue(
      'gmgn',
      'token_security_decision',
      'security.is_open_source',
      security.is_open_source
    );
    normalized.ownerRenounced = booleanValue(
      'gmgn',
      'token_security_decision',
      'security.is_renounced',
      security.is_renounced
    );
    normalized.buyTaxRatio = decimalStringValue(
      'gmgn',
      'token_security_decision',
      'security.buy_tax',
      security.buy_tax,
      { minimum: 0, maximum: 1 }
    );
    normalized.sellTaxRatio = decimalStringValue(
      'gmgn',
      'token_security_decision',
      'security.sell_tax',
      security.sell_tax,
      { minimum: 0, maximum: 1 }
    );
  }
  const reasons: string[] = [];
  if ((normalized.top10Ratio as number) > input.thresholds.top10MaxRatio) {
    reasons.push('TOP10_HIGH');
  }
  if (input.chain === 'sol') {
    if (normalized.renouncedMint !== true) reasons.push('MINT_NOT_RENOUNCED');
    if (normalized.renouncedFreezeAccount !== true) reasons.push('FREEZE_NOT_RENOUNCED');
  } else {
    if (normalized.honeypot !== false) reasons.push('HONEYPOT');
    if (normalized.openSource !== true) reasons.push('SOURCE_NOT_OPEN');
    if (normalized.ownerRenounced !== true) reasons.push('OWNER_NOT_RENOUNCED');
    if ((normalized.buyTaxRatio as number) > input.thresholds.taxMaxRatio) {
      reasons.push('BUY_TAX_HIGH');
    }
    if ((normalized.sellTaxRatio as number) > input.thresholds.taxMaxRatio) {
      reasons.push('SELL_TAX_HIGH');
    }
  }
  return { passed: reasons.length === 0, reasons, normalized, raw: security };
}

export function evaluateGmgnSecurity(input: {
  readonly chain: Chain;
  readonly trending: GmgnTrendingItem;
  readonly trendingFetchedAtMs: number;
  readonly security: GmgnTokenSecurity;
  readonly thresholds: GmgnSecurityThresholds;
  readonly nowMs: number;
}): GmgnSecurityDecision {
  if (input.trending.chain !== input.chain || input.security.chain !== input.chain) {
    throw new ContractError('gmgn', 'security_decision', 'chain', 'sources differ');
  }
  if (input.trending.tokenAddress !== input.security.tokenAddress) {
    throw new ContractError('gmgn', 'security_decision', 'token_address', 'sources differ');
  }
  if (
    input.nowMs - input.trendingFetchedAtMs > 15_000 ||
    input.trendingFetchedAtMs > input.nowMs + 2_000
  ) {
    throw new ContractError('gmgn', 'security_decision', 'trending.fetched_at', 'is stale');
  }
  const trending = input.trending.raw;
  const tokenDecision = evaluateGmgnTokenSecurity({
    chain: input.chain,
    security: input.security,
    thresholds: input.thresholds,
    nowMs: input.nowMs
  });
  const normalized: Record<string, number | boolean> = {
    ...tokenDecision.normalized,
    devTeamRatio: numberValue(
      'gmgn',
      'security_decision',
      'trending.dev_team_hold_rate',
      trending.dev_team_hold_rate,
      { minimum: 0, maximum: 1 }
    ),
    rugRatio: numberValue(
      'gmgn',
      'security_decision',
      'trending.rug_ratio',
      trending.rug_ratio,
      { minimum: 0, maximum: 1 }
    ),
    washTrading: booleanValue(
      'gmgn',
      'security_decision',
      'trending.is_wash_trading',
      trending.is_wash_trading
    ),
    insiderRatio: numberValue(
      'gmgn',
      'security_decision',
      'trending.rat_trader_amount_rate',
      trending.rat_trader_amount_rate,
      { minimum: 0, maximum: 1 }
    ),
    bundlerRatio: numberValue(
      'gmgn',
      'security_decision',
      'trending.bundler_rate',
      trending.bundler_rate,
      { minimum: 0, maximum: 1 }
    )
  };

  const reasons: string[] = [...tokenDecision.reasons];
  if ((normalized.devTeamRatio as number) > input.thresholds.devTeamMaxRatio) reasons.push('DEV_TEAM_HIGH');
  if ((normalized.rugRatio as number) > input.thresholds.rugMaxRatio) reasons.push('RUG_RISK_HIGH');
  if (normalized.washTrading === true) reasons.push('WASH_TRADING');
  if ((normalized.insiderRatio as number) > input.thresholds.insiderMaxRatio) reasons.push('INSIDER_HIGH');
  if ((normalized.bundlerRatio as number) > input.thresholds.bundlerMaxRatio) reasons.push('BUNDLER_HIGH');
  return {
    passed: reasons.length === 0,
    reasons,
    normalized,
    raw: { trending, security: tokenDecision.raw }
  };
}

export function gmgnThresholds(config: RuntimeConfig): GmgnSecurityThresholds {
  return {
    top10MaxRatio: config.thresholds.top10MaxRatio,
    insiderMaxRatio: config.thresholds.insiderMaxRatio,
    bundlerMaxRatio: config.thresholds.bundlerMaxRatio,
    devTeamMaxRatio: config.thresholds.devTeamMaxRatio,
    rugMaxRatio: config.thresholds.rugMaxRatio,
    taxMaxRatio: config.thresholds.taxMaxRatio
  };
}
