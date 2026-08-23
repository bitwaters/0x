import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  CoinGeckoClient,
  hasFreshTrade,
  nextOhlcvBeforeTimestamp
} from '../src/providers/coingecko.js';
import { ContractError } from '../src/providers/contracts.js';
import {
  G2ChainSocket,
  PoolRefreshCoordinator,
  type G2SocketFactory,
  type G2SocketLike
} from '../src/providers/g2.js';
import {
  GmgnClient,
  evaluateGmgnSecurity,
  type GmgnTokenSecurity,
  type GmgnTrendingItem
} from '../src/providers/gmgn.js';
import { ProviderRequestError, requestJson, type Fetcher } from '../src/providers/http.js';
import { TokenBucket } from '../src/providers/runtime.js';
import {
  COINGECKO_REALTIME_CHANNELS,
  COINGECKO_REST_RESOURCES,
  MARKET_DECISION_SOURCES,
  MARKET_PROVIDER_REGISTRY,
  assertMarketDecisionSource,
  marketProviderRestUrl
} from '../src/providers/sourcePolicy.js';

const BSC_TOKEN = '0xabcdef0000000000000000000000000000000001';
const BSC_POOL = '0xabcdef0000000000000000000000000000000002';
const BSC_COUNTER = '0xabcdef0000000000000000000000000000000003';
const SOL_TOKEN = 'So11111111111111111111111111111111111111112';
const SOL_POOL = '11111111111111111111111111111111';

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function sequenceFetcher(responses: readonly Response[]): {
  readonly fetcher: Fetcher;
  readonly requests: Array<{ url: URL; init: RequestInit | undefined }>;
} {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
  let index = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init });
    const response = responses[index++];
    if (response === undefined) throw new Error('unexpected fetch');
    return response;
  }) as Fetcher;
  return { fetcher, requests };
}

function gmgnTrendingFixture(chain: 'sol' | 'bsc', tokenAddress: string) {
  return {
    code: 0,
    data: {
      code: 0,
      data: {
        rank: [
          {
            chain,
            address: tokenAddress,
            name: 'Test Meme',
            symbol: 'TME',
            rank: 1,
            price: 0.000123,
            market_cap: 123_456,
            liquidity: 23_456,
            open_timestamp: 1_787_426_000,
            creation_timestamp: 1_787_425_900,
            dev_team_hold_rate: 0.02,
            rug_ratio: 0.12,
            is_wash_trading: false,
            rat_trader_amount_rate: 0.08,
            bundler_rate: 0.05
          }
        ]
      },
      message: '',
      reason: ''
    }
  };
}

function gmgnInfoFixture(tokenAddress: string, poolAddress: string) {
  return {
    code: 0,
    data: {
      address: tokenAddress,
      biggest_pool_address: poolAddress,
      open_timestamp: 1_787_426_000,
      creation_timestamp: 1_787_425_900,
      liquidity: '23456.78',
      price: { price: '0.000123' },
      pool: { pool_address: poolAddress, creation_timestamp: 1_787_426_000 }
    }
  };
}

function bscSecurityRaw(): Record<string, unknown> {
  return {
    address: BSC_TOKEN,
    top_10_holder_rate: '0.164',
    is_honeypot: false,
    is_open_source: true,
    is_renounced: true,
    buy_tax: '0',
    sell_tax: '0.01',
    open_source: 1,
    renounced: 1
  };
}

const THRESHOLDS = {
  top10MaxRatio: 0.25,
  insiderMaxRatio: 0.2,
  bundlerMaxRatio: 0.2,
  devTeamMaxRatio: 0.2,
  rugMaxRatio: 0.3,
  taxMaxRatio: 0.05
};

function isolatedRestBudget(now: () => number = Date.now): TokenBucket {
  return new TokenBucket(60_000, 100, now, async () => undefined);
}

test('GMGN adapter validates nested rank wrapper, auth and token contracts', async () => {
  const now = 1_787_427_000_000;
  const mock = sequenceFetcher([
    jsonResponse(gmgnTrendingFixture('bsc', BSC_TOKEN)),
    jsonResponse(gmgnInfoFixture(BSC_TOKEN, BSC_POOL)),
    jsonResponse({ code: 0, data: bscSecurityRaw() })
  ]);
  const client = new GmgnClient('gmgn-secret', {
    fetcher: mock.fetcher,
    now: () => now,
    wait: async () => undefined,
    limiter: new TokenBucket(120, 10, () => now)
  });

  const trending = await client.getTrending('bsc', '1m', 100);
  const info = await client.getTokenInfo('bsc', BSC_TOKEN.toUpperCase().replace('0X', '0x'));
  const security = await client.getTokenSecurity('bsc', BSC_TOKEN);

  assert.equal(trending.items[0]!.priceUsd, 0.000123);
  assert.equal(trending.items[0]!.name, 'Test Meme');
  assert.equal(trending.items[0]!.symbol, 'TME');
  assert.deepEqual(trending.filters, ['not_honeypot', 'verified', 'renounced']);
  assert.equal(info.biggestPoolAddress, BSC_POOL);
  assert.equal(info.poolCreatedAtMs, 1_787_426_000_000);
  assert.equal(security.raw.is_open_source, true);
  for (const request of mock.requests) {
    assert.equal(new Headers(request.init?.headers).get('X-APIKEY'), 'gmgn-secret');
    assert.equal(request.url.searchParams.get('timestamp'), String(now / 1000));
    assert.match(request.url.searchParams.get('client_id')!, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(request.url.toString(), /gmgn-secret/);
  }
  assert.deepEqual(mock.requests[0]!.url.searchParams.getAll('filters'), [
    'not_honeypot',
    'verified',
    'renounced'
  ]);
});

test('GMGN trending identity rejects missing or blank display fields', async () => {
  for (const patch of [{ name: undefined }, { symbol: '   ' }]) {
    const fixture = gmgnTrendingFixture('bsc', BSC_TOKEN);
    Object.assign(fixture.data.data.rank[0]!, patch);
    const mock = sequenceFetcher([jsonResponse(fixture)]);
    const client = new GmgnClient('gmgn-secret', {
      fetcher: mock.fetcher,
      now: () => 1_787_427_000_000,
      limiter: new TokenBucket(120, 10, () => 1_787_427_000_000)
    });
    await assert.rejects(() => client.getTrending('bsc', '1m', 1), ContractError);
  }
});

test('GMGN retries 5xx with a fresh anti-replay client ID', async () => {
  const mock = sequenceFetcher([
    jsonResponse({ error: 'temporary' }, 502),
    jsonResponse(gmgnTrendingFixture('sol', SOL_TOKEN))
  ]);
  const client = new GmgnClient('gmgn-secret', {
    fetcher: mock.fetcher,
    now: () => 1_787_427_000_000,
    wait: async () => undefined,
    limiter: new TokenBucket(120, 10, () => 1_787_427_000_000)
  });
  await client.getTrending('sol', '5m', 1);
  assert.equal(mock.requests.length, 2);
  assert.notEqual(
    mock.requests[0]!.url.searchParams.get('client_id'),
    mock.requests[1]!.url.searchParams.get('client_id')
  );
});

test('GMGN 429 cooldown uses the injected clock before allowing the next request', async () => {
  let now = 1_000_000;
  const resetAtSeconds = (now + 10_000) / 1_000;
  const mock = sequenceFetcher([
    jsonResponse(
      { code: 429, error: 'RATE_LIMIT_BANNED', reset_at: resetAtSeconds },
      429,
      { 'x-ratelimit-reset': String(resetAtSeconds) }
    ),
    jsonResponse(gmgnTrendingFixture('sol', SOL_TOKEN))
  ]);
  const waits: number[] = [];
  const client = new GmgnClient('gmgn-secret', {
    fetcher: mock.fetcher,
    now: () => now,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    limiter: new TokenBucket(120, 10, () => now)
  });
  await assert.rejects(
    () => client.getTrending('sol', '1m', 1),
    (error: unknown) =>
      error instanceof ProviderRequestError && error.retryAtMs === 1_010_000
  );
  assert.deepEqual(waits, []);
  const recovered = await client.getTrending('sol', '1m', 1);
  assert.equal(recovered.items.length, 1);
  assert.deepEqual(waits, [10_000]);
  assert.equal(mock.requests.length, 2);
});

test('GMGN security matrix uses exact production fields and fails closed', async () => {
  const now = 1_787_427_000_000;
  const trendingRaw = gmgnTrendingFixture('bsc', BSC_TOKEN).data.data.rank[0]!;
  const trending: GmgnTrendingItem = {
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    name: 'Test Meme',
    symbol: 'TME',
    rank: 1,
    priceUsd: 0.000123,
    marketCapUsd: 123_456,
    liquidityUsd: 23_456,
    openAtMs: 1_787_426_000_000,
    createdAtMs: 1_787_425_900_000,
    raw: trendingRaw
  };
  const security: GmgnTokenSecurity = {
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    fetchedAtMs: now - 1_000,
    raw: bscSecurityRaw()
  };
  const decision = evaluateGmgnSecurity({
    chain: 'bsc',
    trending,
    trendingFetchedAtMs: now - 1_000,
    security,
    thresholds: THRESHOLDS,
    nowMs: now
  });
  assert.equal(decision.passed, true);

  const aliasOnly = { ...bscSecurityRaw(), is_open_source: undefined };
  assert.throws(
    () =>
      evaluateGmgnSecurity({
        chain: 'bsc',
        trending,
        trendingFetchedAtMs: now - 1_000,
        security: { ...security, raw: aliasOnly },
        thresholds: THRESHOLDS,
        nowMs: now
      }),
    (error: unknown) =>
      error instanceof ContractError && /security\.is_open_source/.test(error.message)
  );
  assert.throws(
    () =>
      evaluateGmgnSecurity({
        chain: 'bsc',
        trending,
        trendingFetchedAtMs: now - 16_000,
        security,
        thresholds: THRESHOLDS,
        nowMs: now
      }),
    /is stale/
  );
  await Promise.resolve();
});

test('GMGN SOL matrix requires boolean mint and freeze values', () => {
  const now = 1_787_427_000_000;
  const trending: GmgnTrendingItem = {
    chain: 'sol',
    tokenAddress: SOL_TOKEN,
    name: 'Test Meme',
    symbol: 'TME',
    rank: 1,
    priceUsd: 0.001,
    marketCapUsd: 100_000,
    liquidityUsd: 20_000,
    openAtMs: now - 10_000,
    createdAtMs: now - 20_000,
    raw: {
      dev_team_hold_rate: 0.02,
      rug_ratio: 0.1,
      is_wash_trading: false,
      rat_trader_amount_rate: 0.03,
      bundler_rate: 0.04
    }
  };
  const base: GmgnTokenSecurity = {
    chain: 'sol',
    tokenAddress: SOL_TOKEN,
    fetchedAtMs: now,
    raw: {
      top_10_holder_rate: '0.18',
      renounced_mint: true,
      renounced_freeze_account: true
    }
  };
  assert.equal(
    evaluateGmgnSecurity({
      chain: 'sol',
      trending,
      trendingFetchedAtMs: now,
      security: base,
      thresholds: THRESHOLDS,
      nowMs: now
    }).passed,
    true
  );
  assert.throws(
    () =>
      evaluateGmgnSecurity({
        chain: 'sol',
        trending,
        trendingFetchedAtMs: now,
        security: { ...base, raw: { ...base.raw, renounced_mint: 1 } },
        thresholds: THRESHOLDS,
        nowMs: now
      }),
    /must be a boolean/
  );
});

function poolFixture(candidateSide: 'base' | 'quote' = 'base') {
  const base = candidateSide === 'base' ? BSC_TOKEN : BSC_COUNTER;
  const quote = candidateSide === 'quote' ? BSC_TOKEN : BSC_COUNTER;
  return {
    data: {
      id: `bsc_${BSC_POOL}`,
      type: 'pool',
      attributes: {
        address: BSC_POOL.toUpperCase().replace('0X', '0x'),
        reserve_in_usd: '22000',
        base_token_liquidity_usd: '10000',
        quote_token_liquidity_usd: '12000',
        pool_created_at: '2026-08-22T00:00:00Z'
      },
      relationships: {
        base_token: { data: { id: `bsc_${base}`, type: 'token' } },
        quote_token: { data: { id: `bsc_${quote}`, type: 'token' } }
      }
    },
    included: [
      { id: `bsc_${base}`, type: 'token', attributes: { address: base } },
      { id: `bsc_${quote}`, type: 'token', attributes: { address: quote } },
      { id: 'pancakeswap_v3', type: 'dex', attributes: { name: 'PancakeSwap V3' } }
    ]
  };
}

function tradeFixture(candidateAddress = BSC_TOKEN) {
  return {
    data: [
      {
        id: 'bsc_trade_1',
        type: 'trade',
        attributes: {
          block_number: 1,
          tx_hash: '0xabc',
          tx_from_address: BSC_COUNTER,
          from_token_amount: '10',
          to_token_amount: '2000',
          price_from_in_usd: candidateAddress === BSC_COUNTER ? '0.5' : '1',
          price_to_in_usd: candidateAddress === BSC_TOKEN ? '0.00025' : '1',
          block_timestamp: '2020-01-01T00:00:00Z',
          kind: 'buy',
          volume_in_usd: '5',
          from_token_address: BSC_COUNTER,
          to_token_address: BSC_TOKEN
        }
      }
    ]
  };
}

test('CoinGecko binds exact fixed-pool composition and maps candidate-directed trades', async () => {
  const mock = sequenceFetcher([
    jsonResponse(poolFixture('base')),
    jsonResponse(tradeFixture(BSC_TOKEN))
  ]);
  const client = new CoinGeckoClient('cg-secret', {
    fetcher: mock.fetcher,
    now: () => 1_787_427_000_000,
    wait: async () => undefined,
    restBudget: isolatedRestBudget(() => 1_787_427_000_000)
  });
  const pool = await client.getPoolDetail('bsc', BSC_POOL, BSC_TOKEN);
  const trades = await client.getPoolTrades(pool);

  assert.equal(pool.candidateSide, 'base');
  assert.equal(Object.isFrozen(pool), true);
  assert.equal(pool.counterTokenAddress, BSC_COUNTER);
  assert.equal(pool.reserveUsd, 22_000);
  assert.equal(trades[0]!.kind, 'buy');
  assert.equal(trades[0]!.candidatePriceUsd, 0.00025);
  assert.equal(trades[0]!.blockTimestampMs, 1_577_836_800_000);
  assert.equal(hasFreshTrade(trades, 1_787_427_000_000), false);
  assert.equal(mock.requests[0]!.url.searchParams.get('include_composition'), 'true');
  assert.equal(mock.requests[1]!.url.searchParams.get('token'), 'base');
  for (const request of mock.requests) {
    assert.equal(new Headers(request.init?.headers).get('x-cg-pro-api-key'), 'cg-secret');
    assert.doesNotMatch(request.url.toString(), /cg-secret/);
  }
});

test('CoinGecko preserves quote-directed kind without a second inversion', async () => {
  const quoteTrade = tradeFixture(BSC_TOKEN);
  const resource = quoteTrade.data[0]!;
  resource.attributes.kind = 'sell';
  const mock = sequenceFetcher([
    jsonResponse(poolFixture('quote')),
    jsonResponse(quoteTrade)
  ]);
  const client = new CoinGeckoClient('cg-secret', {
    fetcher: mock.fetcher,
    wait: async () => undefined,
    restBudget: isolatedRestBudget()
  });
  const pool = await client.getPoolDetail('bsc', BSC_POOL, BSC_TOKEN);
  const trades = await client.getPoolTrades(pool);
  assert.equal(pool.candidateSide, 'quote');
  assert.equal(trades[0]!.kind, 'sell');
  assert.equal(mock.requests[1]!.url.searchParams.get('token'), 'quote');
});

test('CoinGecko fails closed on missing composition and wrong network identity', async () => {
  const missing = poolFixture();
  missing.included.splice(0, 1);
  const wrongNetwork = poolFixture();
  wrongNetwork.data.id = `solana_${BSC_POOL}`;
  const mock = sequenceFetcher([jsonResponse(missing), jsonResponse(wrongNetwork)]);
  const client = new CoinGeckoClient('cg-secret', {
    fetcher: mock.fetcher,
    wait: async () => undefined,
    restBudget: isolatedRestBudget()
  });
  await assert.rejects(() => client.getPoolDetail('bsc', BSC_POOL, BSC_TOKEN), /target is missing/);
  await assert.rejects(() => client.getPoolDetail('bsc', BSC_POOL, BSC_TOKEN), /network/);
});

test('CoinGecko parses OHLCV candle time separately and paginates without overlap', async () => {
  const mock = sequenceFetcher([
    jsonResponse(poolFixture('base')),
    jsonResponse({
      data: {
        id: 'ohlcv-id',
        type: 'ohlcv_request_response',
        attributes: {
          ohlcv_list: [
            [1_787_427_000, 1, 1.2, 0.9, 1.1, 100],
            [1_787_426_940, 0.9, 1.1, 0.8, 1, 80]
          ]
        }
      },
      meta: {
        base: { address: BSC_TOKEN },
        quote: { address: BSC_COUNTER }
      }
    })
  ]);
  const client = new CoinGeckoClient('cg-secret', {
    fetcher: mock.fetcher,
    wait: async () => undefined,
    restBudget: isolatedRestBudget()
  });
  const binding = await client.getPoolDetail('bsc', BSC_POOL, BSC_TOKEN);
  const bars = await client.getPoolOhlcv({
    binding,
    timeframe: 'minute',
    aggregate: 1,
    limit: 2
  });
  assert.equal(bars[0]!.openAtMs, 1_787_427_000_000);
  assert.equal(nextOhlcvBeforeTimestamp(bars), 1_787_426_939);
  await assert.rejects(
    () =>
      client.getPoolOhlcv({
        binding,
        timeframe: 'day',
        aggregate: 30
      }),
    /invalid OHLCV aggregate/
  );
});

test('CoinGecko rejects partially or fully swapped forged pool bindings before fetching', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as Fetcher;
  const client = new CoinGeckoClient('cg-secret', {
    fetcher,
    restBudget: isolatedRestBudget()
  });
  await assert.rejects(
    () =>
      client.getPoolTrades({
        chain: 'bsc',
        poolAddress: BSC_POOL,
        candidateTokenAddress: BSC_TOKEN,
        candidateSide: 'quote',
        counterTokenAddress: BSC_COUNTER,
        baseTokenAddress: BSC_TOKEN,
        quoteTokenAddress: BSC_COUNTER
      }),
    /verified pool detail/
  );
  await assert.rejects(
    () =>
      client.getPoolTrades({
        chain: 'bsc',
        poolAddress: BSC_POOL,
        candidateTokenAddress: BSC_TOKEN,
        candidateSide: 'quote',
        counterTokenAddress: BSC_COUNTER,
        baseTokenAddress: BSC_COUNTER,
        quoteTokenAddress: BSC_TOKEN
      }),
    /verified pool detail/
  );
  assert.equal(calls, 0);
});

test('CoinGecko default clients share one process REST budget', () => {
  const first = new CoinGeckoClient('first');
  const second = new CoinGeckoClient('second');
  assert.equal(first.restBudget, second.restBudget);
});

test('HTTP retry honors long 429 cooldown without logging credentials', async () => {
  const resetAt = Math.floor((Date.now() + 10_000) / 1000);
  let observedRetryAtMs = 0;
  const mock = sequenceFetcher([
    jsonResponse({ reset_at: resetAt, key: 'should-not-appear' }, 429)
  ]);
  await assert.rejects(
    () =>
      requestJson({
        provider: 'coingecko',
        operation: 'test_rate_limit',
        url: new URL('https://pro-api.coingecko.com/api/v3/onchain/networks'),
        headers: { 'x-cg-pro-api-key': 'cg-secret' },
        fetcher: mock.fetcher,
        wait: async () => assert.fail('must not wait through a long cooldown'),
        maximumAttempts: 3,
        maximumRetryDelayMs: 5_000,
        onRateLimited: (retryAtMs) => {
          observedRetryAtMs = retryAtMs;
        }
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.retryAtMs, resetAt * 1_000);
      assert.doesNotMatch(error.message, /cg-secret|should-not-appear|https:/);
      return true;
    }
  );
  assert.equal(observedRetryAtMs, resetAt * 1_000);
  assert.equal(mock.requests.length, 1);
});

test('HTTP timeout covers response body reads and pre-aborted calls do not fetch', async () => {
  let calls = 0;
  const stalledBodyFetcher = (async (_input, init) => {
    calls += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener(
          'abort',
          () => controller.error(new Error('aborted body')),
          { once: true }
        );
      }
    });
    return new Response(stream, { status: 200 });
  }) as Fetcher;
  await assert.rejects(
    () =>
      requestJson({
        provider: 'coingecko',
        operation: 'stalled_body',
        url: new URL('https://pro-api.coingecko.com/test'),
        headers: {},
        fetcher: stalledBodyFetcher,
        timeoutMs: 5,
        maximumAttempts: 1
      }),
    (error: unknown) => error instanceof ProviderRequestError && error.kind === 'timeout'
  );

  const controller = new AbortController();
  controller.abort('caller_abort');
  await assert.rejects(() =>
    requestJson({
      provider: 'coingecko',
      operation: 'pre_aborted',
      url: new URL('https://pro-api.coingecko.com/test'),
      headers: {},
      fetcher: stalledBodyFetcher,
      signal: controller.signal
    })
  );
  assert.equal(calls, 1);
});

test('shared token bucket exposes deterministic budget exhaustion', () => {
  let now = 0;
  const bucket = new TokenBucket(60, 1, () => now);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
  now = 1_000;
  assert.equal(bucket.tryTake(), true);
});

class MockSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}

test('G2 uses header auth, coalesces dirty pools and releases subscriptions', async () => {
  const sockets: MockSocket[] = [];
  const factory: G2SocketFactory = (url, headers) => {
    assert.equal(url, 'wss://stream.coingecko.com/v1');
    assert.doesNotMatch(url, /cg-secret/);
    assert.equal(headers['x-cg-pro-api-key'], 'cg-secret');
    const socket = new MockSocket();
    sockets.push(socket);
    return socket as unknown as G2SocketLike;
  };
  const refreshed: string[] = [];
  const coordinator = new PoolRefreshCoordinator(
    async (chain, pool) => {
      refreshed.push(`${chain}:${pool}`);
    },
    1
  );
  const g2 = new G2ChainSocket('bsc', 'cg-secret', coordinator, factory);
  g2.subscribe(BSC_POOL);
  g2.start();
  sockets[0]!.emit('open');
  assert.match(sockets[0]!.sent[0]!, /OnchainTrade/);
  sockets[0]!.message({
    type: 'confirm_subscription',
    identifier: JSON.stringify({ channel: 'OnchainTrade' })
  });
  const setMessage = JSON.parse(sockets[0]!.sent[1]!) as { data: string };
  assert.deepEqual(JSON.parse(setMessage.data), {
    'network_id:pool_addresses': [`bsc:${BSC_POOL}`],
    action: 'set_pools'
  });
  const event = { c: 'G2', n: 'bsc', pa: BSC_POOL, t: Date.now() };
  sockets[0]!.message(event);
  sockets[0]!.message(event);
  sockets[0]!.message(event);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshed.length, 1);

  g2.release(BSC_POOL);
  const unsetMessage = JSON.parse(sockets[0]!.sent.at(-1)!) as { data: string };
  assert.equal((JSON.parse(unsetMessage.data) as { action: string }).action, 'unset_pools');
  sockets[0]!.message(event);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(refreshed.length, 1);
  g2.stop();
});

test('G2 reconnects, restores pools and enforces 90/100 watermarks', async () => {
  const sockets: MockSocket[] = [];
  const factory: G2SocketFactory = () => {
    const socket = new MockSocket();
    sockets.push(socket);
    return socket as unknown as G2SocketLike;
  };
  const coordinator = new PoolRefreshCoordinator(async () => undefined, 1);
  const g2 = new G2ChainSocket('bsc', 'cg-secret', coordinator, factory);
  for (let index = 1; index <= 90; index += 1) {
    g2.subscribe(`0x${index.toString(16).padStart(40, '0')}`);
  }
  assert.equal(g2.atHighWatermark, true);
  for (let index = 91; index <= 100; index += 1) {
    g2.subscribe(`0x${index.toString(16).padStart(40, '0')}`);
  }
  assert.throws(() => g2.subscribe('0xffffffffffffffffffffffffffffffffffffffff'), /limit/);
  g2.start();
  sockets[0]!.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(sockets.length, 2);
  sockets[1]!.emit('open');
  sockets[1]!.message({
    type: 'confirm_subscription',
    identifier: JSON.stringify({ channel: 'OnchainTrade' })
  });
  const setMessage = JSON.parse(sockets[1]!.sent[1]!) as { data: string };
  assert.equal(
    (JSON.parse(setMessage.data) as { 'network_id:pool_addresses': string[] })[
      'network_id:pool_addresses'
    ].length,
    100
  );
  g2.stop();
});

test('G2 release during an in-flight refresh cannot requeue the pool', async () => {
  let finishRefresh: (() => void) | undefined;
  let refreshCount = 0;
  const coordinator = new PoolRefreshCoordinator(async () => {
    refreshCount += 1;
    await new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
  }, 1);
  coordinator.markDirty('bsc', BSC_POOL);
  await new Promise((resolve) => setTimeout(resolve, 5));
  coordinator.markDirty('bsc', BSC_POOL);
  coordinator.release('bsc', BSC_POOL);
  finishRefresh?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(refreshCount, 1);
});

test('stopping the G2 coordinator cancels queued dirty refreshes', async () => {
  let refreshCount = 0;
  const coordinator = new PoolRefreshCoordinator(async () => {
    refreshCount += 1;
  }, 20);
  coordinator.markDirty('bsc', BSC_POOL);
  coordinator.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(refreshCount, 0);
  coordinator.start();
  coordinator.markDirty('bsc', BSC_POOL);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(refreshCount, 1);
  coordinator.stop();
});

test('market decision boundary permits only GMGN/CoinGecko and only G2 realtime', () => {
  assert.deepEqual(MARKET_DECISION_SOURCES, ['gmgn', 'coingecko']);
  assert.deepEqual(COINGECKO_REALTIME_CHANNELS, ['G2']);
  assert.deepEqual(COINGECKO_REST_RESOURCES, [
    'fixed_pool_detail',
    'fixed_pool_trades',
    'fixed_pool_ohlcv'
  ]);
  assert.doesNotThrow(() => assertMarketDecisionSource('gmgn'));
  assert.throws(() => assertMarketDecisionSource('other-api'), /not allowed/);
  assert.throws(
    () => marketProviderRestUrl('coingecko', 'https://example.com/market'),
    /origin-relative/
  );
  assert.throws(
    () => marketProviderRestUrl('coingecko', '//example.com/market'),
    /origin-relative/
  );
  assert.throws(
    () => marketProviderRestUrl('coingecko', '/api/v3/onchain/networks/bsc/tokens/a'),
    /path is not allowed/
  );
  assert.equal(
    marketProviderRestUrl(
      'coingecko',
      `/api/v3/onchain/networks/bsc/pools/${BSC_POOL}/trades`
    ).origin,
    'https://pro-api.coingecko.com'
  );

  assert.deepEqual(MARKET_PROVIDER_REGISTRY, {
    gmgn: { restOrigin: 'https://openapi.gmgn.ai', webOrigin: 'https://gmgn.ai' },
    coingecko: {
      restOrigin: 'https://pro-api.coingecko.com',
      realtimeOrigin: 'wss://stream.coingecko.com'
    }
  });
  const sourceRoot = join(process.cwd(), 'src');
  const pending = [sourceRoot];
  const sourceFiles: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.endsWith('.ts')) sourceFiles.push(path);
    }
  }
  for (const path of sourceFiles) {
    const source = readFileSync(path, 'utf8');
    const isTelegramTransport = path.endsWith(join('telegram', 'transport.ts'));
    if (!path.endsWith('sourcePolicy.ts') && !isTelegramTransport) {
      assert.doesNotMatch(source, /https?:\/\/|wss:\/\//, `${path} bypasses the provider registry`);
      assert.doesNotMatch(source, /['"]G[13]['"]/, `${path} enables a forbidden realtime channel`);
    }
    if (!path.endsWith(join('providers', 'http.ts')) && !isTelegramTransport) {
      assert.doesNotMatch(source, /\bfetch\b/, `${path} bypasses the shared HTTP transport`);
    }
    if (!path.endsWith(join('providers', 'g2.ts'))) {
      assert.doesNotMatch(source, /\bWebSocket\b/, `${path} bypasses the G2 transport`);
    }
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*\(|require\s*\()\s*['"](?:node:)?(?:http|https|net|tls)['"]/,
      `${path} imports an unapproved network transport`
    );
  }
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8')
  ) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['dotenv', 'ws', 'zod']);
});

test('SOL pool addresses remain exact Base58 values', async () => {
  const fixture = {
    data: {
      id: `solana_${SOL_POOL}`,
      type: 'pool',
      attributes: {
        address: SOL_POOL,
        reserve_in_usd: '20000',
        base_token_liquidity_usd: '10000',
        quote_token_liquidity_usd: '10000',
        pool_created_at: '2026-08-22T00:00:00Z'
      },
      relationships: {
        base_token: { data: { id: `solana_${SOL_TOKEN}`, type: 'token' } },
        quote_token: { data: { id: `solana_${SOL_POOL}`, type: 'token' } }
      }
    },
    included: [
      { id: `solana_${SOL_TOKEN}`, type: 'token', attributes: { address: SOL_TOKEN } },
      { id: `solana_${SOL_POOL}`, type: 'token', attributes: { address: SOL_POOL } }
    ]
  };
  const mock = sequenceFetcher([jsonResponse(fixture)]);
  const client = new CoinGeckoClient('cg-secret', {
    fetcher: mock.fetcher,
    wait: async () => undefined,
    restBudget: isolatedRestBudget()
  });
  const detail = await client.getPoolDetail('sol', SOL_POOL, SOL_TOKEN);
  assert.equal(detail.poolAddress, SOL_POOL);
  assert.equal(detail.candidateSide, 'base');
});
