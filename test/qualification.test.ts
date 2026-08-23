import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  CandidateRepository,
  PoolBindingRepository,
  QualificationEventRepository,
  RuleVersionRepository
} from '../src/db/repositories.js';
import { FixedPoolQualificationService } from '../src/qualification/service.js';
import {
  evaluateLiquiditySample,
  evaluateLiquidityStability,
  evaluateTradeWindow
} from '../src/qualification/rules.js';
import type { CoinGeckoPoolDetail, CoinGeckoTrade } from '../src/providers/coingecko.js';
import type {
  GmgnTrendingItem,
  GmgnTokenInfo,
  GmgnTokenSecurity,
  GmgnTrendingSnapshot
} from '../src/providers/gmgn.js';
import { evaluateGmgnSecurity, gmgnThresholds } from '../src/providers/gmgn.js';
import { ContractError } from '../src/providers/contracts.js';

const TOKEN = '0xabcdef0000000000000000000000000000000001';
const POOL = '0xabcdef0000000000000000000000000000000002';
const COUNTER = '0xabcdef0000000000000000000000000000000003';

function trade(id: string, kind: 'buy' | 'sell', volumeUsd: number, atMs: number): CoinGeckoTrade {
  return {
    id,
    kind,
    blockTimestampMs: atMs,
    volumeUsd,
    candidatePriceUsd: 0.001,
    fromTokenAddress: kind === 'buy' ? COUNTER : TOKEN,
    toTokenAddress: kind === 'buy' ? TOKEN : COUNTER,
    fromTokenAmount: 1,
    toTokenAmount: 1,
    raw: { id, kind, volumeUsd }
  };
}

function detail(
  fetchedAtMs: number,
  input: {
    side?: 'base' | 'quote';
    reserve?: number;
    baseLiquidity?: number;
    quoteLiquidity?: number;
  } = {}
): CoinGeckoPoolDetail {
  const side = input.side ?? 'base';
  return Object.freeze({
    chain: 'bsc',
    network: 'bsc',
    poolAddress: POOL,
    candidateTokenAddress: TOKEN,
    candidateSide: side,
    counterTokenAddress: COUNTER,
    baseTokenAddress: side === 'base' ? TOKEN : COUNTER,
    quoteTokenAddress: side === 'quote' ? TOKEN : COUNTER,
    reserveUsd: input.reserve ?? 12_000,
    baseLiquidityUsd: input.baseLiquidity ?? 6_000,
    quoteLiquidityUsd: input.quoteLiquidity ?? 6_000,
    poolCreatedAtMs: fetchedAtMs - 60_000,
    fetchedAtMs,
    raw: { reserve_in_usd: String(input.reserve ?? 12_000) }
  });
}

test('30-second trades use provider IDs once and pass exact momentum boundaries', () => {
  const now = 1_000_000;
  const trades = [
    trade('a', 'buy', 40, now),
    trade('b', 'buy', 20, now - 1_000),
    trade('c', 'buy', 20, now - 2_000),
    trade('d', 'sell', 10, now - 3_000),
    trade('e', 'sell', 10, now - 4_000),
    trade('a', 'buy', 40, now)
  ];
  const decision = evaluateTradeWindow(trades, now);
  assert.equal(decision.passed, true);
  assert.equal(decision.trades.length, 5);
  assert.equal(decision.buyCountRatio, 0.6);
  assert.equal(decision.netBuyUsd, 60);
  assert.equal(decision.largestTradeRatio, 0.4);
});

test('trade window waits on low count, stale latest, weak net buys or a dominant trade', () => {
  const now = 2_000_000;
  const decision = evaluateTradeWindow(
    [
      trade('a', 'buy', 70, now - 16_000),
      trade('b', 'buy', 5, now - 17_000),
      trade('c', 'sell', 10, now - 18_000),
      trade('d', 'sell', 10, now - 19_000)
    ],
    now
  );
  assert.deepEqual(decision.reasons, [
    'TRADE_COUNT_LOW',
    'LATEST_TRADE_STALE',
    'BUY_COUNT_RATIO_LOW',
    'LARGEST_TRADE_TOO_HIGH'
  ]);
});

test('trade window treats missing facts as waiting and conflicting provider IDs as invalid', () => {
  const now = 2_100_000;
  assert.deepEqual(evaluateTradeWindow([], now).reasons, [
    'TRADE_COUNT_LOW',
    'LATEST_TRADE_STALE',
    'BUY_COUNT_RATIO_LOW',
    'NET_BUY_NOT_POSITIVE',
    'LARGEST_TRADE_TOO_HIGH'
  ]);
  const valid = [
    trade('a', 'buy', 40, now),
    trade('b', 'buy', 20, now - 1_000),
    trade('c', 'buy', 20, now - 2_000),
    trade('d', 'sell', 10, now - 3_000),
    trade('e', 'sell', 10, now - 4_000)
  ];
  assert.equal(
    evaluateTradeWindow([...valid, trade('a', 'sell', 40, now)], now).reasons[0],
    'TRADE_ID_CONFLICT'
  );
});

test('liquidity stability uses the candidate counter side and inclusive boundaries', () => {
  const first = detail(1_000, { reserve: 12_000, quoteLiquidity: 4_000 });
  const second = detail(11_000, {
    reserve: 10_800,
    quoteLiquidity: 100 / 0.03
  });
  const base = evaluateLiquidityStability({ first, second, liquidityMinUsd: 10_000 });
  assert.equal(base.outcome, 'PASS');
  assert.ok(base.reserveDeclineRatio <= 0.1);
  assert.ok(base.depthRatio <= 0.03);

  const quote = evaluateLiquidityStability({
    first: detail(1_000, { side: 'quote', baseLiquidity: 4_000 }),
    second: detail(11_000, { side: 'quote', baseLiquidity: 4_000 }),
    liquidityMinUsd: 10_000
  });
  assert.equal(quote.outcome, 'PASS');
  assert.equal(quote.counterSideLiquidityUsd, 4_000);
  assert.equal(
    evaluateLiquidityStability({ first, second: detail(10_999), liquidityMinUsd: 10_000 })
      .outcome,
    'WAIT'
  );

  const fastLoss = evaluateLiquidityStability({
    first: detail(1_000, { reserve: 12_000 }),
    second: detail(11_000, { reserve: 10_799 }),
    liquidityMinUsd: 10_000
  });
  assert.equal(fastLoss.outcome, 'REJECT');
  assert.deepEqual(fastLoss.reasons, ['POOL_LIQUIDITY_DECLINE']);
  assert.equal(
    evaluateLiquiditySample(detail(1_000, { quoteLiquidity: 100 / 0.03001 }), 10_000)
      .passed,
    false
  );
});

test('every BSC security threshold is inclusive and fails immediately above its boundary', () => {
  const now = 2_500_000;
  const config = parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test'
  });
  const rawTrending: Record<string, unknown> = {
    dev_team_hold_rate: config.thresholds.devTeamMaxRatio,
    rug_ratio: config.thresholds.rugMaxRatio,
    is_wash_trading: false,
    rat_trader_amount_rate: config.thresholds.insiderMaxRatio,
    bundler_rate: config.thresholds.bundlerMaxRatio
  };
  const rawSecurity: Record<string, unknown> = {
    top_10_holder_rate: String(config.thresholds.top10MaxRatio),
    is_honeypot: false,
    is_open_source: true,
    is_renounced: true,
    buy_tax: String(config.thresholds.taxMaxRatio),
    sell_tax: String(config.thresholds.taxMaxRatio)
  };
  const trending: GmgnTrendingItem = {
    chain: 'bsc',
    tokenAddress: TOKEN,
    name: 'Test Meme',
    symbol: 'TME',
    rank: 1,
    priceUsd: 0.001,
    marketCapUsd: 100_000,
    liquidityUsd: 15_000,
    openAtMs: now - 1_000,
    createdAtMs: now - 2_000,
    raw: rawTrending
  };
  const security: GmgnTokenSecurity = {
    chain: 'bsc',
    tokenAddress: TOKEN,
    fetchedAtMs: now,
    raw: rawSecurity
  };
  const decide = (
    trendingPatch: Record<string, unknown> = {},
    securityPatch: Record<string, unknown> = {}
  ) =>
    evaluateGmgnSecurity({
      chain: 'bsc',
      trending: { ...trending, raw: { ...rawTrending, ...trendingPatch } },
      trendingFetchedAtMs: now,
      security: { ...security, raw: { ...rawSecurity, ...securityPatch } },
      thresholds: gmgnThresholds(config),
      nowMs: now
    });
  assert.equal(decide().passed, true);
  const failures: readonly [Record<string, unknown>, Record<string, unknown>, string][] = [
    [{ dev_team_hold_rate: config.thresholds.devTeamMaxRatio + 0.001 }, {}, 'DEV_TEAM_HIGH'],
    [{ rug_ratio: config.thresholds.rugMaxRatio + 0.001 }, {}, 'RUG_RISK_HIGH'],
    [{ is_wash_trading: true }, {}, 'WASH_TRADING'],
    [{ rat_trader_amount_rate: config.thresholds.insiderMaxRatio + 0.001 }, {}, 'INSIDER_HIGH'],
    [{ bundler_rate: config.thresholds.bundlerMaxRatio + 0.001 }, {}, 'BUNDLER_HIGH'],
    [{}, { top_10_holder_rate: String(config.thresholds.top10MaxRatio + 0.001) }, 'TOP10_HIGH'],
    [{}, { is_honeypot: true }, 'HONEYPOT'],
    [{}, { is_open_source: false }, 'SOURCE_NOT_OPEN'],
    [{}, { is_renounced: false }, 'OWNER_NOT_RENOUNCED'],
    [{}, { buy_tax: String(config.thresholds.taxMaxRatio + 0.001) }, 'BUY_TAX_HIGH'],
    [{}, { sell_tax: String(config.thresholds.taxMaxRatio + 0.001) }, 'SELL_TAX_HIGH']
  ];
  for (const [trendingPatch, securityPatch, reason] of failures) {
    assert.deepEqual(decide(trendingPatch, securityPatch).reasons, [reason]);
  }
});

function gmgnFacts(nowMs: number) {
  const trending: GmgnTrendingSnapshot = {
    chain: 'bsc',
    interval: '1m',
    fetchedAtMs: nowMs,
    filters: ['not_honeypot', 'verified', 'renounced'],
    items: [
      {
        chain: 'bsc',
        tokenAddress: TOKEN,
        name: 'Test Meme',
        symbol: 'TME',
        rank: 1,
        priceUsd: 0.001,
        marketCapUsd: 100_000,
        liquidityUsd: 15_000,
        openAtMs: nowMs - 60_000,
        createdAtMs: nowMs - 120_000,
        raw: {
          dev_team_hold_rate: 0.1,
          rug_ratio: 0.1,
          is_wash_trading: false,
          rat_trader_amount_rate: 0.1,
          bundler_rate: 0.1
        }
      }
    ]
  };
  const info: GmgnTokenInfo = {
    chain: 'bsc',
    tokenAddress: TOKEN,
    biggestPoolAddress: POOL,
    priceUsd: 0.001,
    liquidityUsd: 15_000,
    openAtMs: nowMs - 60_000,
    poolCreatedAtMs: nowMs - 60_000,
    fetchedAtMs: nowMs,
    raw: { biggest_pool_address: POOL }
  };
  const security: GmgnTokenSecurity = {
    chain: 'bsc',
    tokenAddress: TOKEN,
    fetchedAtMs: nowMs,
    raw: {
      top_10_holder_rate: '0.2',
      is_honeypot: false,
      is_open_source: true,
      is_renounced: true,
      buy_tax: '0.01',
      sell_tax: '0.01'
    }
  };
  return { trending, info, security };
}

function qualificationSetup(now: { value: number }) {
  const database = openDatabase(':memory:');
  const config = parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test'
  });
  new RuleVersionRepository(database).save(config.ruleVersion, {
    thresholds: config.thresholds,
    discoveryPolicy: config.discoveryPolicy,
    sourcePolicy: config.sourcePolicy,
    qualificationPolicy: config.qualificationPolicy
  });
  const candidates = new CandidateRepository(database);
  candidates.findOrCreate({
    chain: 'bsc',
    tokenAddress: TOKEN,
    firstSeenAtMs: now.value - 1_000,
    firstSeenPriceUsd: 0.001,
    firstSeenRank: 2,
    firstSeenMarketCapUsd: 100_000,
    firstSeenLiquidityUsd: 15_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.transition('bsc', TOKEN, 'PREHEAT', { atMs: now.value });
  new QualificationEventRepository(database).record({
    chain: 'bsc',
    tokenAddress: TOKEN,
    stage: 'activation',
    outcome: 'PASS',
    reasonCode: 'DUAL_RANK_REAL_POOL',
    source: 'gmgn',
    observedAtMs: now.value,
    raw: {},
    normalized: {},
    thresholds: {},
    decisionRuleVersion: config.ruleVersion
  });
  return { database, config, candidates };
}

test('qualification binds once, waits ten seconds, then becomes eligible', async () => {
  const now = { value: 3_000_000 };
  const { database, config, candidates } = qualificationSetup(now);
  const pools = [detail(now.value), detail(now.value + 10_000)];
  const subscribed: string[] = [];
  const gmgn = {
    async getTrending() {
      return gmgnFacts(now.value).trending;
    },
    async getTokenInfo() {
      return gmgnFacts(now.value).info;
    },
    async getTokenSecurity() {
      return gmgnFacts(now.value).security;
    }
  };
  const coinGecko = {
    async getPoolDetail() {
      return pools.shift()!;
    },
    async getPoolTrades() {
      return [
        trade('a', 'buy', 40, now.value),
        trade('b', 'buy', 20, now.value - 1_000),
        trade('c', 'buy', 20, now.value - 2_000),
        trade('d', 'sell', 10, now.value - 3_000),
        trade('e', 'sell', 10, now.value - 4_000)
      ];
    }
  };
  const service = new FixedPoolQualificationService(
    database,
    config,
    gmgn,
    coinGecko,
    () => now.value,
    (_chain, pool) => subscribed.push(pool)
  );
  assert.equal((await service.refresh('bsc', TOKEN)).outcome, 'WAIT');
  assert.equal(candidates.find('bsc', TOKEN)!.status, 'POOL_BOUND');
  now.value += 10_000;
  const eligible = await service.refresh('bsc', TOKEN);
  assert.equal(eligible.outcome, 'ELIGIBLE');
  assert.deepEqual(eligible.eligibility?.presentation, {
    name: 'Test Meme',
    symbol: 'TME',
    marketCapUsd: 100_000,
    rank: 1,
    currentGain: 0,
    activationReason: 'DUAL_RANK'
  });
  assert.equal(candidates.find('bsc', TOKEN)!.status, 'MONITORING');
  assert.equal(candidates.find('bsc', TOKEN)!.decisionRuleVersion, config.ruleVersion);
  assert.deepEqual(subscribed, [POOL]);
  const evidence = database
    .prepare(`
      SELECT raw_json, normalized_json, thresholds_json
      FROM qualification_events
      WHERE reason_code = 'ELIGIBLE_FOR_SEND_CHECK'
    `)
    .get() as { raw_json: string; normalized_json: string; thresholds_json: string };
  assert.deepEqual(Object.keys(JSON.parse(evidence.raw_json)), [
    'gmgn',
    'poolDetails',
    'trades'
  ]);
  assert.ok(JSON.parse(evidence.normalized_json).security);
  assert.equal(JSON.parse(evidence.thresholds_json).qualification.tradeMinCount, 5);
  database.close();
});

test('a changed GMGN main pool terminates the fixed candidate and releases subscription', async () => {
  const now = { value: 4_000_000 };
  const { database, config, candidates } = qualificationSetup(now);
  let changed = false;
  const facts = () => {
    const value = gmgnFacts(now.value);
    return changed ? { ...value, info: { ...value.info, biggestPoolAddress: COUNTER } } : value;
  };
  const released: string[] = [];
  const service = new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() {
        return facts().trending;
      },
      async getTokenInfo() {
        return facts().info;
      },
      async getTokenSecurity() {
        return facts().security;
      }
    },
    {
      async getPoolDetail() {
        return detail(now.value);
      },
      async getPoolTrades() {
        return [];
      }
    },
    () => now.value,
    () => undefined,
    (_chain, pool) => released.push(pool)
  );
  await service.refresh('bsc', TOKEN);
  changed = true;
  now.value += 10_000;
  const result = await service.refresh('bsc', TOKEN);
  assert.equal(result.outcome, 'REJECTED');
  assert.equal(candidates.find('bsc', TOKEN)!.terminalReason, 'MAIN_POOL_CHANGED');
  assert.deepEqual(released, [POOL]);
  database.close();
});

test('the first invalid pool sample rejects before subscription', async () => {
  const now = { value: 5_000_000 };
  const { database, config, candidates } = qualificationSetup(now);
  const subscribed: string[] = [];
  const facts = gmgnFacts(now.value);
  const service = new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() { return facts.trending; },
      async getTokenInfo() { return facts.info; },
      async getTokenSecurity() { return facts.security; }
    },
    {
      async getPoolDetail() { return detail(now.value, { reserve: 9_999 }); },
      async getPoolTrades() { return []; }
    },
    () => now.value,
    (_chain, pool) => subscribed.push(pool)
  );
  assert.equal((await service.refresh('bsc', TOKEN)).outcome, 'REJECTED');
  assert.equal(candidates.find('bsc', TOKEN)!.terminalReason, 'POOL_LIQUIDITY_LOW');
  assert.deepEqual(subscribed, []);
  database.close();
});

test('qualification expiry is inclusive and releases the fixed-pool subscription once', async () => {
  const now = { value: 6_000_000 };
  const { database, config, candidates } = qualificationSetup(now);
  const released: string[] = [];
  const service = new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() { return gmgnFacts(now.value).trending; },
      async getTokenInfo() { return gmgnFacts(now.value).info; },
      async getTokenSecurity() { return gmgnFacts(now.value).security; }
    },
    {
      async getPoolDetail() { return detail(now.value); },
      async getPoolTrades() { return []; }
    },
    () => now.value,
    () => undefined,
    (_chain, pool) => released.push(pool)
  );
  await service.refresh('bsc', TOKEN);
  now.value += config.thresholds.qualificationWindowSeconds * 1_000;
  const expired = candidates.expireQualificationWindows({
    nowMs: now.value,
    windowSeconds: config.thresholds.qualificationWindowSeconds,
    decisionRuleVersion: config.ruleVersion
  });
  service.releaseExpiredCandidates(expired);
  assert.equal(expired.length, 1);
  assert.equal(service.expireWindows(now.value).length, 0);
  assert.equal(candidates.find('bsc', TOKEN)!.status, 'EXPIRED');
  assert.deepEqual(released, [POOL]);
  database.close();
});

test('a GMGN response contract failure is terminal and cannot recover on retry', async () => {
  const now = { value: 6_500_000 };
  const { database, config, candidates } = qualificationSetup(now);
  let trendingCalls = 0;
  const service = new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() {
        trendingCalls += 1;
        throw new ContractError('gmgn', 'trending', 'response.data', 'must be an object');
      },
      async getTokenInfo() { return gmgnFacts(now.value).info; },
      async getTokenSecurity() { return gmgnFacts(now.value).security; }
    },
    {
      async getPoolDetail() { return detail(now.value); },
      async getPoolTrades() { return []; }
    },
    () => now.value
  );
  assert.equal((await service.refresh('bsc', TOKEN)).outcome, 'REJECTED');
  assert.equal((await service.refresh('bsc', TOKEN)).outcome, 'REJECTED');
  assert.equal(trendingCalls, 1);
  assert.equal(candidates.find('bsc', TOKEN)!.terminalReason, 'GMGN_CONTRACT_ERROR');
  database.close();
});

test('concurrent qualification refreshes for one candidate share one decision run', async () => {
  const now = { value: 6_700_000 };
  const { database, config } = qualificationSetup(now);
  let trendingCalls = 0;
  let detailCalls = 0;
  let resolveTrending: ((snapshot: GmgnTrendingSnapshot) => void) | undefined;
  const subscribed: string[] = [];
  const service = new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() {
        trendingCalls += 1;
        return await new Promise<GmgnTrendingSnapshot>((resolve) => {
          resolveTrending = resolve;
        });
      },
      async getTokenInfo() { return gmgnFacts(now.value).info; },
      async getTokenSecurity() { return gmgnFacts(now.value).security; }
    },
    {
      async getPoolDetail() {
        detailCalls += 1;
        return detail(now.value);
      },
      async getPoolTrades() { return []; }
    },
    () => now.value,
    (_chain, pool) => subscribed.push(pool)
  );
  const first = service.refresh('bsc', TOKEN);
  const second = service.refresh('bsc', TOKEN);
  resolveTrending?.(gmgnFacts(now.value).trending);
  assert.deepEqual(await Promise.all([first, second]), [
    { outcome: 'WAIT', reasons: ['SECOND_DETAIL_REQUIRED'], pool: detail(now.value) },
    { outcome: 'WAIT', reasons: ['SECOND_DETAIL_REQUIRED'], pool: detail(now.value) }
  ]);
  assert.equal(trendingCalls, 1);
  assert.equal(detailCalls, 1);
  assert.deepEqual(subscribed, [POOL]);
  database.close();
});

test('a restarted qualification service restores the persisted fixed-pool subscription', async () => {
  const now = { value: 6_900_000 };
  const { database, config } = qualificationSetup(now);
  const source = {
    async getTrending() { return gmgnFacts(now.value).trending; },
    async getTokenInfo() { return gmgnFacts(now.value).info; },
    async getTokenSecurity() { return gmgnFacts(now.value).security; }
  };
  const coinGecko = {
    async getPoolDetail() { return detail(now.value); },
    async getPoolTrades() { return []; }
  };
  await new FixedPoolQualificationService(
    database,
    config,
    source,
    coinGecko,
    () => now.value
  ).refresh('bsc', TOKEN);
  now.value += 1_000;
  const restored: string[] = [];
  const restarted = new FixedPoolQualificationService(
    database,
    config,
    source,
    coinGecko,
    () => now.value,
    (_chain, pool) => restored.push(pool)
  );
  restarted.start();
  assert.deepEqual(restored, [POOL]);
  const result = await restarted.refresh('bsc', TOKEN);
  assert.deepEqual(result.reasons, ['SECOND_DETAIL_REQUIRED_AFTER_RESTART']);
  assert.deepEqual(restored, [POOL]);
  database.close();
});

test('a disabled chain does not restore or refresh a persisted unsent pool', async () => {
  const now = { value: 6_925_000 };
  const { database, config } = qualificationSetup(now);
  const facts = gmgnFacts(now.value);
  await new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() { return facts.trending; },
      async getTokenInfo() { return facts.info; },
      async getTokenSecurity() { return facts.security; }
    },
    {
      async getPoolDetail() { return detail(now.value); },
      async getPoolTrades() { return []; }
    },
    () => now.value
  ).refresh('bsc', TOKEN);
  const disabled = parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test',
    BSC_ENABLED: 'false'
  });
  let providerCalls = 0;
  const subscriptions: string[] = [];
  const restarted = new FixedPoolQualificationService(
    database,
    disabled,
    {
      async getTrending() { providerCalls += 1; return facts.trending; },
      async getTokenInfo() { providerCalls += 1; return facts.info; },
      async getTokenSecurity() { providerCalls += 1; return facts.security; }
    },
    {
      async getPoolDetail() { providerCalls += 1; return detail(now.value); },
      async getPoolTrades() { providerCalls += 1; return []; }
    },
    () => now.value,
    (_chain, pool) => subscriptions.push(pool)
  );
  restarted.start();
  assert.deepEqual(subscriptions, []);
  assert.deepEqual(await restarted.refresh('bsc', TOKEN), {
    outcome: 'WAIT',
    reasons: ['CHAIN_DISABLED']
  });
  assert.equal(providerCalls, 0);
  database.close();
});

test('qualification rejects duplicate normalized candidate rows from its fresh GMGN rank', async () => {
  const now = { value: 6_950_000 };
  const { database, config, candidates } = qualificationSetup(now);
  const facts = gmgnFacts(now.value);
  let detailCalls = 0;
  const duplicate = {
    ...facts.trending.items[0]!,
    tokenAddress: TOKEN.toUpperCase().replace('0X', '0x'),
    raw: { ...facts.trending.items[0]!.raw, dev_team_hold_rate: 0 }
  };
  const service = new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() {
        return { ...facts.trending, items: [...facts.trending.items, duplicate] };
      },
      async getTokenInfo() { return facts.info; },
      async getTokenSecurity() { return facts.security; }
    },
    {
      async getPoolDetail() {
        detailCalls += 1;
        return detail(now.value);
      },
      async getPoolTrades() { return []; }
    },
    () => now.value
  );
  assert.equal((await service.refresh('bsc', TOKEN)).outcome, 'REJECTED');
  assert.equal(candidates.find('bsc', TOKEN)!.terminalReason, 'GMGN_CONTRACT_ERROR');
  assert.equal(detailCalls, 0);
  database.close();
});

test('a shared G2 pool is released only after its final candidate terminates', async () => {
  const now = { value: 6_975_000 };
  const { database, config, candidates } = qualificationSetup(now);
  candidates.findOrCreate({
    chain: 'bsc',
    tokenAddress: COUNTER,
    firstSeenAtMs: now.value - 1_000,
    firstSeenPriceUsd: 1,
    firstSeenRank: 3,
    firstSeenMarketCapUsd: 200_000,
    firstSeenLiquidityUsd: 15_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.transition('bsc', COUNTER, 'PREHEAT', { atMs: now.value });
  const bindings = new PoolBindingRepository(database);
  bindings.bind({
    chain: 'bsc',
    tokenAddress: TOKEN,
    poolAddress: POOL,
    candidateSide: 'base',
    counterTokenAddress: COUNTER,
    boundAtMs: now.value
  });
  bindings.bind({
    chain: 'bsc',
    tokenAddress: COUNTER,
    poolAddress: POOL,
    candidateSide: 'quote',
    counterTokenAddress: TOKEN,
    boundAtMs: now.value
  });
  const subscribed: string[] = [];
  const released: string[] = [];
  const service = new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() { return gmgnFacts(now.value).trending; },
      async getTokenInfo() { return gmgnFacts(now.value).info; },
      async getTokenSecurity() { return gmgnFacts(now.value).security; }
    },
    {
      async getPoolDetail() { return detail(now.value); },
      async getPoolTrades() { return []; }
    },
    () => now.value,
    (_chain, pool) => subscribed.push(pool),
    (_chain, pool) => released.push(pool)
  );
  service.start();
  assert.deepEqual(subscribed, [POOL]);
  candidates.transition('bsc', TOKEN, 'REJECTED', {
    atMs: now.value,
    terminalReason: 'TEST_REJECT'
  });
  await service.refresh('bsc', TOKEN);
  assert.deepEqual(released, []);
  candidates.transition('bsc', COUNTER, 'REJECTED', {
    atMs: now.value,
    terminalReason: 'TEST_REJECT'
  });
  await service.refresh('bsc', COUNTER);
  assert.deepEqual(released, [POOL]);
  database.close();
});

test('a monitoring candidate records a newly applied qualification rule version', async () => {
  const now = { value: 6_990_000 };
  const { database, config, candidates } = qualificationSetup(now);
  const trades = () => [
    trade('a', 'buy', 40, now.value),
    trade('b', 'buy', 20, now.value - 1_000),
    trade('c', 'buy', 20, now.value - 2_000),
    trade('d', 'sell', 10, now.value - 3_000),
    trade('e', 'sell', 10, now.value - 4_000)
  ];
  const source = {
    async getTrending() { return gmgnFacts(now.value).trending; },
    async getTokenInfo() { return gmgnFacts(now.value).info; },
    async getTokenSecurity() { return gmgnFacts(now.value).security; }
  };
  const coinGecko = {
    async getPoolDetail() { return detail(now.value); },
    async getPoolTrades() { return trades(); }
  };
  const initial = new FixedPoolQualificationService(
    database,
    config,
    source,
    coinGecko,
    () => now.value
  );
  await initial.refresh('bsc', TOKEN);
  now.value += 10_000;
  assert.equal((await initial.refresh('bsc', TOKEN)).outcome, 'ELIGIBLE');

  const changed = parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test',
    TOP10_MAX_RATIO: '0.24'
  });
  new RuleVersionRepository(database).save(changed.ruleVersion, {
    thresholds: changed.thresholds,
    discoveryPolicy: changed.discoveryPolicy,
    sourcePolicy: changed.sourcePolicy,
    qualificationPolicy: changed.qualificationPolicy
  });
  const restarted = new FixedPoolQualificationService(
    database,
    changed,
    source,
    coinGecko,
    () => now.value
  );
  restarted.start();
  assert.deepEqual(
    (await restarted.refresh('bsc', TOKEN)).reasons,
    ['SECOND_DETAIL_REQUIRED_AFTER_RESTART']
  );
  now.value += 10_000;
  assert.equal((await restarted.refresh('bsc', TOKEN)).outcome, 'ELIGIBLE');
  assert.equal(candidates.find('bsc', TOKEN)!.decisionRuleVersion, changed.ruleVersion);
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM qualification_events WHERE reason_code = 'ELIGIBLE_FOR_SEND_CHECK'")
      .get()!.count,
    2
  );
  database.close();
});

test('GMGN facts becoming stale during REST checks cannot become eligible', async () => {
  const now = { value: 7_000_000 };
  const { database, config, candidates } = qualificationSetup(now);
  const service = new FixedPoolQualificationService(
    database,
    config,
    {
      async getTrending() { return gmgnFacts(now.value).trending; },
      async getTokenInfo() { return gmgnFacts(now.value).info; },
      async getTokenSecurity() { return gmgnFacts(now.value).security; }
    },
    {
      async getPoolDetail() { return detail(now.value); },
      async getPoolTrades() {
        now.value += 16_000;
        return [
          trade('a', 'buy', 40, now.value),
          trade('b', 'buy', 20, now.value - 1_000),
          trade('c', 'buy', 20, now.value - 2_000),
          trade('d', 'sell', 10, now.value - 3_000),
          trade('e', 'sell', 10, now.value - 4_000)
        ];
      }
    },
    () => now.value
  );
  await service.refresh('bsc', TOKEN);
  now.value += 10_000;
  const result = await service.refresh('bsc', TOKEN);
  assert.equal(result.outcome, 'WAIT');
  assert.deepEqual(result.reasons, ['GMGN_FACTS_STALE']);
  assert.equal(candidates.find('bsc', TOKEN)!.status, 'POOL_BOUND');
  database.close();
});
