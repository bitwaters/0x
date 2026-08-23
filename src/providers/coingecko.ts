import type { Chain } from '../config.js';
import { normalizeAddress } from '../domain/address.js';
import {
  ContractError,
  arrayValue,
  decimalStringValue,
  numberValue,
  recordValue,
  stringValue,
  timestampMsFromIso
} from './contracts.js';
import { requestJson, type Fetcher } from './http.js';
import { TokenBucket, type Sleep } from './runtime.js';
import { marketProviderRestUrl } from './sourcePolicy.js';

export const COINGECKO_NETWORK: Readonly<Record<Chain, string>> = {
  sol: 'solana',
  bsc: 'bsc'
};

export type CandidateSide = 'base' | 'quote';

export interface FixedPoolBinding {
  readonly chain: Chain;
  readonly poolAddress: string;
  readonly candidateTokenAddress: string;
  readonly candidateSide: CandidateSide;
  readonly counterTokenAddress: string;
  readonly baseTokenAddress: string;
  readonly quoteTokenAddress: string;
}

export interface CoinGeckoPoolDetail extends FixedPoolBinding {
  readonly network: string;
  readonly reserveUsd: number;
  readonly baseLiquidityUsd: number;
  readonly quoteLiquidityUsd: number;
  readonly poolCreatedAtMs: number;
  readonly fetchedAtMs: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

let processRestBudget: TokenBucket | undefined;
let processRestRequestsPerMinute: number | undefined;

function sharedCoinGeckoRestBudget(requestsPerMinute: number): TokenBucket {
  if (processRestBudget === undefined) {
    processRestRequestsPerMinute = requestsPerMinute;
    processRestBudget = new TokenBucket(requestsPerMinute, Math.min(requestsPerMinute, 8));
  } else if (processRestRequestsPerMinute !== requestsPerMinute) {
    throw new Error('CoinGecko process REST budget is already configured with a different limit');
  }
  return processRestBudget;
}

function validateFixedPoolBinding(
  operation: string,
  binding: FixedPoolBinding
): FixedPoolBinding {
  const chain = binding.chain;
  const candidateTokenAddress = normalizeAddress(chain, binding.candidateTokenAddress);
  const counterTokenAddress = normalizeAddress(chain, binding.counterTokenAddress);
  const baseTokenAddress = normalizeAddress(chain, binding.baseTokenAddress);
  const quoteTokenAddress = normalizeAddress(chain, binding.quoteTokenAddress);
  const candidateIsBase = candidateTokenAddress === baseTokenAddress;
  const candidateIsQuote = candidateTokenAddress === quoteTokenAddress;
  if (candidateIsBase === candidateIsQuote) {
    throw new ContractError(
      'coingecko',
      operation,
      'binding.pool_composition',
      'candidate must match exactly one pool side'
    );
  }
  const expectedSide: CandidateSide = candidateIsBase ? 'base' : 'quote';
  const expectedCounter = candidateIsBase ? quoteTokenAddress : baseTokenAddress;
  if (binding.candidateSide !== expectedSide || counterTokenAddress !== expectedCounter) {
    throw new ContractError(
      'coingecko',
      operation,
      'binding.pool_composition',
      'candidate side or counter token does not match the fixed pool'
    );
  }
  return {
    chain,
    poolAddress: normalizeAddress(chain, binding.poolAddress),
    candidateTokenAddress,
    candidateSide: expectedSide,
    counterTokenAddress,
    baseTokenAddress,
    quoteTokenAddress
  };
}

export interface CoinGeckoTrade {
  readonly id: string;
  readonly kind: 'buy' | 'sell';
  readonly blockTimestampMs: number;
  readonly volumeUsd: number;
  readonly candidatePriceUsd: number;
  readonly fromTokenAddress: string;
  readonly toTokenAddress: string;
  readonly fromTokenAmount: number;
  readonly toTokenAmount: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CoinGeckoOhlcvBar {
  readonly openAtMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volumeUsd: number;
}

function tokenAddressFromIncluded(input: {
  chain: Chain;
  operation: string;
  relationship: unknown;
  included: readonly unknown[];
  side: CandidateSide;
}): string {
  const relationship = recordValue(
    'coingecko',
    input.operation,
    `data.relationships.${input.side}_token`,
    input.relationship
  );
  const relationshipData = recordValue(
    'coingecko',
    input.operation,
    `data.relationships.${input.side}_token.data`,
    relationship.data
  );
  const id = stringValue(
    'coingecko',
    input.operation,
    `data.relationships.${input.side}_token.data.id`,
    relationshipData.id
  );
  const match = input.included.find((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const candidate = item as Record<string, unknown>;
    return candidate.id === id && candidate.type === 'token';
  });
  if (match === undefined) {
    throw new ContractError(
      'coingecko',
      input.operation,
      `included.${input.side}_token`,
      'relationship target is missing'
    );
  }
  const resource = recordValue('coingecko', input.operation, `included.${id}`, match);
  const attributes = recordValue(
    'coingecko',
    input.operation,
    `included.${id}.attributes`,
    resource.attributes
  );
  return normalizeAddress(
    input.chain,
    stringValue('coingecko', input.operation, `included.${id}.attributes.address`, attributes.address)
  );
}

export class CoinGeckoClient {
  readonly restBudget: TokenBucket;
  private readonly verifiedBindings = new WeakSet<FixedPoolBinding>();
  private readonly fetcher: Fetcher | undefined;
  private readonly wait: Sleep | undefined;
  private readonly now: () => number;

  constructor(
    private readonly apiKey: string,
    options: {
      readonly fetcher?: Fetcher;
      readonly wait?: Sleep;
      readonly now?: () => number;
      readonly restBudget?: TokenBucket;
      readonly restRequestsPerMinute?: number;
    } = {}
  ) {
    this.fetcher = options.fetcher;
    this.wait = options.wait;
    this.now = options.now ?? Date.now;
    const rpm = options.restRequestsPerMinute ?? 450;
    this.restBudget = options.restBudget ?? sharedCoinGeckoRestBudget(rpm);
  }

  async getPoolDetail(
    chain: Chain,
    poolAddress: string,
    candidateTokenAddress: string,
    signal?: AbortSignal
  ): Promise<CoinGeckoPoolDetail> {
    const operation = 'pool_detail';
    const normalizedPool = normalizeAddress(chain, poolAddress);
    const normalizedCandidate = normalizeAddress(chain, candidateTokenAddress);
    const response = await this.get(
      operation,
      `/api/v3/onchain/networks/${COINGECKO_NETWORK[chain]}/pools/${encodeURIComponent(normalizedPool)}`,
      {
        include: 'base_token,quote_token,dex',
        include_composition: 'true',
        include_volume_breakdown: 'true'
      },
      signal
    );
    const root = recordValue('coingecko', operation, 'response', response);
    const data = recordValue('coingecko', operation, 'data', root.data);
    const resourceId = stringValue('coingecko', operation, 'data.id', data.id);
    if (!resourceId.startsWith(`${COINGECKO_NETWORK[chain]}_`)) {
      throw new ContractError('coingecko', operation, 'data.id', 'network does not match request');
    }
    if (stringValue('coingecko', operation, 'data.type', data.type) !== 'pool') {
      throw new ContractError('coingecko', operation, 'data.type', 'must equal pool');
    }
    const attributes = recordValue('coingecko', operation, 'data.attributes', data.attributes);
    const returnedPool = normalizeAddress(
      chain,
      stringValue('coingecko', operation, 'data.attributes.address', attributes.address)
    );
    if (returnedPool !== normalizedPool) {
      throw new ContractError('coingecko', operation, 'data.attributes.address', 'does not match request');
    }
    const relationships = recordValue(
      'coingecko',
      operation,
      'data.relationships',
      data.relationships
    );
    const included = arrayValue('coingecko', operation, 'included', root.included);
    const baseTokenAddress = tokenAddressFromIncluded({
      chain,
      operation,
      relationship: relationships.base_token,
      included,
      side: 'base'
    });
    const quoteTokenAddress = tokenAddressFromIncluded({
      chain,
      operation,
      relationship: relationships.quote_token,
      included,
      side: 'quote'
    });
    const isBase = baseTokenAddress === normalizedCandidate;
    const isQuote = quoteTokenAddress === normalizedCandidate;
    if (isBase === isQuote) {
      throw new ContractError(
        'coingecko',
        operation,
        'pool.composition',
        'candidate must match exactly one side'
      );
    }
    const candidateSide: CandidateSide = isBase ? 'base' : 'quote';
    const detail: CoinGeckoPoolDetail = Object.freeze({
      chain,
      network: COINGECKO_NETWORK[chain],
      poolAddress: returnedPool,
      candidateTokenAddress: normalizedCandidate,
      baseTokenAddress,
      quoteTokenAddress,
      candidateSide,
      counterTokenAddress: isBase ? quoteTokenAddress : baseTokenAddress,
      reserveUsd: decimalStringValue(
        'coingecko',
        operation,
        'data.attributes.reserve_in_usd',
        attributes.reserve_in_usd,
        { minimum: 0 }
      ),
      baseLiquidityUsd: decimalStringValue(
        'coingecko',
        operation,
        'data.attributes.base_token_liquidity_usd',
        attributes.base_token_liquidity_usd,
        { minimum: 0 }
      ),
      quoteLiquidityUsd: decimalStringValue(
        'coingecko',
        operation,
        'data.attributes.quote_token_liquidity_usd',
        attributes.quote_token_liquidity_usd,
        { minimum: 0 }
      ),
      poolCreatedAtMs: timestampMsFromIso(
        'coingecko',
        operation,
        'data.attributes.pool_created_at',
        attributes.pool_created_at
      ),
      fetchedAtMs: this.now(),
      raw: root
    });
    this.verifiedBindings.add(detail);
    return detail;
  }

  async getPoolTrades(
    binding: FixedPoolBinding,
    signal?: AbortSignal
  ): Promise<readonly CoinGeckoTrade[]> {
    const operation = 'pool_trades';
    this.assertVerifiedBinding(operation, binding);
    const fixed = validateFixedPoolBinding(operation, binding);
    const response = await this.get(
      operation,
      `/api/v3/onchain/networks/${COINGECKO_NETWORK[fixed.chain]}/pools/${encodeURIComponent(fixed.poolAddress)}/trades`,
      { token: fixed.candidateSide },
      signal
    );
    const root = recordValue('coingecko', operation, 'response', response);
    return arrayValue('coingecko', operation, 'data', root.data).map((item, index) => {
      const field = `data[${index}]`;
      const resource = recordValue('coingecko', operation, field, item);
      if (stringValue('coingecko', operation, `${field}.type`, resource.type) !== 'trade') {
        throw new ContractError('coingecko', operation, `${field}.type`, 'must equal trade');
      }
      const attributes = recordValue(
        'coingecko',
        operation,
        `${field}.attributes`,
        resource.attributes
      );
      const fromTokenAddress = normalizeAddress(
        fixed.chain,
        stringValue(
          'coingecko',
          operation,
          `${field}.attributes.from_token_address`,
          attributes.from_token_address
        )
      );
      const toTokenAddress = normalizeAddress(
        fixed.chain,
        stringValue(
          'coingecko',
          operation,
          `${field}.attributes.to_token_address`,
          attributes.to_token_address
        )
      );
      const candidateIsFrom = fromTokenAddress === fixed.candidateTokenAddress;
      const candidateIsTo = toTokenAddress === fixed.candidateTokenAddress;
      if (candidateIsFrom === candidateIsTo) {
        throw new ContractError(
          'coingecko',
          operation,
          `${field}.candidate_address`,
          'candidate must match exactly one trade side'
        );
      }
      const returnedCounter = candidateIsFrom ? toTokenAddress : fromTokenAddress;
      if (returnedCounter !== fixed.counterTokenAddress) {
        throw new ContractError(
          'coingecko',
          operation,
          `${field}.counter_address`,
          'does not match the fixed pool'
        );
      }
      const kind = stringValue(
        'coingecko',
        operation,
        `${field}.attributes.kind`,
        attributes.kind
      );
      if (kind !== 'buy' && kind !== 'sell') {
        throw new ContractError('coingecko', operation, `${field}.attributes.kind`, 'unknown kind');
      }
      return {
        id: stringValue('coingecko', operation, `${field}.id`, resource.id),
        kind,
        blockTimestampMs: timestampMsFromIso(
          'coingecko',
          operation,
          `${field}.attributes.block_timestamp`,
          attributes.block_timestamp
        ),
        volumeUsd: decimalStringValue(
          'coingecko',
          operation,
          `${field}.attributes.volume_in_usd`,
          attributes.volume_in_usd,
          { positive: true }
        ),
        candidatePriceUsd: decimalStringValue(
          'coingecko',
          operation,
          `${field}.attributes.${candidateIsFrom ? 'price_from_in_usd' : 'price_to_in_usd'}`,
          candidateIsFrom ? attributes.price_from_in_usd : attributes.price_to_in_usd,
          { positive: true }
        ),
        fromTokenAddress,
        toTokenAddress,
        fromTokenAmount: decimalStringValue(
          'coingecko',
          operation,
          `${field}.attributes.from_token_amount`,
          attributes.from_token_amount,
          { positive: true }
        ),
        toTokenAmount: decimalStringValue(
          'coingecko',
          operation,
          `${field}.attributes.to_token_amount`,
          attributes.to_token_amount,
          { positive: true }
        ),
        raw: resource
      };
    });
  }

  async getPoolOhlcv(input: {
    readonly binding: FixedPoolBinding;
    readonly timeframe: 'second' | 'minute' | 'hour' | 'day';
    readonly aggregate: 1 | 4 | 5 | 12 | 15 | 30;
    readonly limit?: number;
    readonly beforeTimestampSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly CoinGeckoOhlcvBar[]> {
    const operation = 'pool_ohlcv';
    this.assertVerifiedBinding(operation, input.binding);
    const fixed = validateFixedPoolBinding(operation, input.binding);
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('CoinGecko OHLCV limit must be between 1 and 1000');
    }
    const allowedAggregates: Readonly<Record<typeof input.timeframe, readonly number[]>> = {
      second: [1, 15, 30],
      minute: [1, 5, 15],
      hour: [1, 4, 12],
      day: [1]
    };
    if (!allowedAggregates[input.timeframe].includes(input.aggregate)) {
      throw new RangeError('invalid OHLCV aggregate for timeframe');
    }
    const query: Record<string, string | number> = {
      token: fixed.candidateSide,
      aggregate: input.aggregate,
      limit,
      currency: 'usd',
      include_empty_intervals: 'false'
    };
    if (input.beforeTimestampSeconds !== undefined) {
      if (!Number.isInteger(input.beforeTimestampSeconds) || input.beforeTimestampSeconds <= 0) {
        throw new RangeError('beforeTimestampSeconds must be a positive integer');
      }
      query.before_timestamp = input.beforeTimestampSeconds;
    }
    const response = await this.get(
      operation,
      `/api/v3/onchain/networks/${COINGECKO_NETWORK[fixed.chain]}/pools/${encodeURIComponent(fixed.poolAddress)}/ohlcv/${input.timeframe}`,
      query,
      input.signal
    );
    const root = recordValue('coingecko', operation, 'response', response);
    const meta = recordValue('coingecko', operation, 'meta', root.meta);
    for (const side of ['base', 'quote'] as const) {
      const metaSide = recordValue('coingecko', operation, `meta.${side}`, meta[side]);
      const metaAddress = normalizeAddress(
        fixed.chain,
        stringValue('coingecko', operation, `meta.${side}.address`, metaSide.address)
      );
      if (metaAddress !== fixed[`${side}TokenAddress`]) {
        throw new ContractError(
          'coingecko',
          operation,
          `meta.${side}.address`,
          'does not match the fixed pool'
        );
      }
    }
    const data = recordValue('coingecko', operation, 'data', root.data);
    if (
      stringValue('coingecko', operation, 'data.type', data.type) !==
      'ohlcv_request_response'
    ) {
      throw new ContractError('coingecko', operation, 'data.type', 'unexpected type');
    }
    const attributes = recordValue('coingecko', operation, 'data.attributes', data.attributes);
    return arrayValue('coingecko', operation, 'data.attributes.ohlcv_list', attributes.ohlcv_list).map(
      (row, index) => {
        const values = arrayValue(
          'coingecko',
          operation,
          `data.attributes.ohlcv_list[${index}]`,
          row
        );
        if (values.length !== 6) {
          throw new ContractError(
            'coingecko',
            operation,
            `data.attributes.ohlcv_list[${index}]`,
            'must contain six values'
          );
        }
        return {
          openAtMs:
            numberValue('coingecko', operation, `ohlcv[${index}].timestamp`, values[0], {
              integer: true,
              positive: true
            }) * 1000,
          open: numberValue('coingecko', operation, `ohlcv[${index}].open`, values[1], {
            positive: true
          }),
          high: numberValue('coingecko', operation, `ohlcv[${index}].high`, values[2], {
            positive: true
          }),
          low: numberValue('coingecko', operation, `ohlcv[${index}].low`, values[3], {
            positive: true
          }),
          close: numberValue('coingecko', operation, `ohlcv[${index}].close`, values[4], {
            positive: true
          }),
          volumeUsd: numberValue(
            'coingecko',
            operation,
            `ohlcv[${index}].volume`,
            values[5],
            { minimum: 0 }
          )
        };
      }
    );
  }

  private async get(
    operation: string,
    path: string,
    query: Readonly<Record<string, string | number>>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const url = marketProviderRestUrl('coingecko', path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const response = await requestJson({
      provider: 'coingecko',
      operation,
      url,
      headers: { 'x-cg-pro-api-key': this.apiKey, Accept: 'application/json' },
      ...(this.fetcher === undefined ? {} : { fetcher: this.fetcher }),
      ...(this.wait === undefined ? {} : { wait: this.wait }),
      timeoutMs: 3_000,
      maximumAttempts: 3,
      maximumRetryDelayMs: 5_000,
      beforeAttempt: () => this.restBudget.take(1, signal),
      ...(signal === undefined ? {} : { signal })
    });
    return response.value;
  }

  private assertVerifiedBinding(operation: string, binding: FixedPoolBinding): void {
    if (!this.verifiedBindings.has(binding)) {
      throw new ContractError(
        'coingecko',
        operation,
        'binding',
        'must come from this client\'s verified pool detail'
      );
    }
  }
}

export function nextOhlcvBeforeTimestamp(
  bars: readonly CoinGeckoOhlcvBar[]
): number | undefined {
  if (bars.length === 0) return undefined;
  return Math.floor(Math.min(...bars.map((bar) => bar.openAtMs)) / 1000) - 1;
}

export function hasFreshTrade(
  trades: readonly CoinGeckoTrade[],
  nowMs: number,
  maximumAgeMs = 15_000
): boolean {
  if (trades.length === 0 || maximumAgeMs < 0) return false;
  const latest = Math.max(...trades.map((trade) => trade.blockTimestampMs));
  return latest <= nowMs + 2_000 && nowMs - latest <= maximumAgeMs;
}
