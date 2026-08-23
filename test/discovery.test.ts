import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  CandidateRepository,
  PoolBindingRepository,
  RuleVersionRepository
} from '../src/db/repositories.js';
import { CandidateDiscoveryEngine } from '../src/discovery/engine.js';
import { DiscoveryPoller, type TrendingSource } from '../src/discovery/poller.js';
import type {
  GmgnTokenInfo,
  GmgnTrendingItem,
  GmgnTrendingSnapshot
} from '../src/providers/gmgn.js';

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  GMGN_API_KEY: 'gmgn-test-secret',
  COINGECKO_PRO_API_KEY: 'coingecko-test-secret'
};

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function trendingItem(input: {
  token: string;
  rank: number;
  price?: number;
  marketCap?: number;
  liquidity?: number;
  openAtMs?: number | null;
}): GmgnTrendingItem {
  return {
    chain: 'bsc',
    tokenAddress: input.token,
    name: 'Test Meme',
    symbol: 'TME',
    rank: input.rank,
    priceUsd: input.price ?? 0.001,
    marketCapUsd: input.marketCap ?? 100_000,
    liquidityUsd: input.liquidity ?? 15_000,
    openAtMs: input.openAtMs ?? null,
    createdAtMs: null,
    raw: {
      address: input.token,
      name: 'Test Meme',
      symbol: 'TME',
      rank: input.rank,
      price: input.price ?? 0.001,
      market_cap: input.marketCap ?? 100_000
    }
  };
}

function snapshot(
  interval: '1m' | '5m',
  fetchedAtMs: number,
  items: readonly GmgnTrendingItem[]
): GmgnTrendingSnapshot {
  return {
    chain: 'bsc',
    interval,
    fetchedAtMs,
    filters: ['not_honeypot', 'verified', 'renounced'],
    items
  };
}

function tokenInfo(input: {
  token: string;
  fetchedAtMs: number;
  pool?: string | null;
  openAtMs?: number | null;
  poolCreatedAtMs?: number | null;
  liquidity?: number;
}): GmgnTokenInfo {
  const pool = input.pool === undefined ? address(900) : input.pool;
  const openAtMs = input.openAtMs === undefined ? input.fetchedAtMs - 60_000 : input.openAtMs;
  return {
    chain: 'bsc',
    tokenAddress: input.token,
    biggestPoolAddress: pool,
    priceUsd: 0.001,
    liquidityUsd: input.liquidity ?? 15_000,
    openAtMs,
    poolCreatedAtMs:
      input.poolCreatedAtMs === undefined ? openAtMs : input.poolCreatedAtMs,
    fetchedAtMs: input.fetchedAtMs,
    raw: { address: input.token, biggest_pool_address: pool }
  };
}

function setup(nowRef: { value: number }, resolver: (token: string) => GmgnTokenInfo) {
  const database = openDatabase(':memory:');
  const config = parseConfig({ ...ENV });
  new RuleVersionRepository(database).save(config.ruleVersion, {
    thresholds: config.thresholds,
    sourcePolicy: config.sourcePolicy,
    discoveryPolicy: config.discoveryPolicy
  });
  const engine = new CandidateDiscoveryEngine(
    database,
    config,
    async (_chain, token) => resolver(token),
    () => nowRef.value
  );
  return { database, config, engine, candidates: new CandidateRepository(database) };
}

test('fresh dual-rank activation handles partial Top100 and exact real-pool boundaries', async () => {
  const now = { value: 1_000_000_000 };
  const good = address(1);
  const outside = address(2);
  const { database, engine, candidates } = setup(now, (token) =>
    tokenInfo({
      token,
      fetchedAtMs: now.value,
      liquidity: 10_000,
      poolCreatedAtMs: now.value - 1_800_000
    })
  );

  const first = await engine.acceptSnapshot(
    snapshot('1m', now.value - 1_000, [
      trendingItem({ token: good, rank: 20, marketCap: 20_000 }),
      trendingItem({ token: outside, rank: 21, marketCap: 19_999 })
    ])
  );
  const second = await engine.acceptSnapshot(
    snapshot('5m', now.value, [trendingItem({ token: good, rank: 18, marketCap: 20_000 })])
  );

  assert.deepEqual(first, { observed: 2, created: 2, activated: 0 });
  assert.equal(second.activated, 1);
  assert.equal(candidates.find('bsc', good)!.status, 'PREHEAT');
  assert.equal(candidates.find('bsc', good)!.decisionRuleVersion, setupRule(database));
  assert.equal(candidates.find('bsc', outside)!.status, 'DISCOVERED');
  assert.equal(database.prepare('SELECT count(*) AS count FROM rank_snapshots').get()!.count, 3);
  database.close();
});

function setupRule(database: ReturnType<typeof openDatabase>): string {
  return database.prepare('SELECT version FROM rule_versions').get()!.version as string;
}

test('three-rising activation resets on a missing successful snapshot', async () => {
  const now = { value: 10_000 };
  const token = address(3);
  const { database, engine, candidates } = setup(now, (candidate) =>
    tokenInfo({
      token: candidate,
      fetchedAtMs: now.value,
      pool: null,
      openAtMs: null,
      poolCreatedAtMs: null,
      liquidity: 0
    })
  );

  for (const [time, rank, present] of [
    [10_000, 30, true],
    [13_000, 20, true],
    [16_000, 0, false],
    [19_000, 15, true],
    [22_000, 10, true],
    [25_000, 5, true]
  ] as const) {
    now.value = time;
    const result = await engine.acceptSnapshot(
      snapshot('1m', time, present ? [trendingItem({ token, rank })] : [])
    );
    if (time < 25_000) assert.equal(result.activated, 0);
  }

  assert.equal(candidates.find('bsc', token)!.status, 'RADAR');
  const activation = database
    .prepare("SELECT reason_code FROM qualification_events WHERE stage = 'activation'")
    .get() as { reason_code: string };
  assert.equal(activation.reason_code, 'THREE_RISING_1M_BONDING_CURVE');
  const emptyFetch = database
    .prepare('SELECT item_count FROM rank_snapshot_fetches WHERE fetched_at_ms = 16000')
    .get() as { item_count: number };
  assert.equal(emptyFetch.item_count, 0);
  database.close();
});

test('consecutive dual-rank activation resets when a successful 1m snapshot omits the token', async () => {
  const now = { value: 1_000 };
  const token = address(4);
  const { database, engine, candidates } = setup(now, (candidate) =>
    tokenInfo({
      token: candidate,
      fetchedAtMs: now.value,
      pool: null,
      openAtMs: null,
      poolCreatedAtMs: null,
      liquidity: 0
    })
  );

  await engine.acceptSnapshot(snapshot('1m', 1_000, [trendingItem({ token, rank: 5 })]));
  now.value = 1_001;
  await engine.acceptSnapshot(snapshot('5m', 1_001, [trendingItem({ token, rank: 5 })]));
  now.value = 4_000;
  await engine.acceptSnapshot(snapshot('1m', 4_000, []));
  now.value = 11_000;
  await engine.acceptSnapshot(snapshot('5m', 11_000, [trendingItem({ token, rank: 5 })]));
  now.value = 11_001;
  await engine.acceptSnapshot(snapshot('1m', 11_001, [trendingItem({ token, rank: 5 })]));
  assert.equal(candidates.find('bsc', token)!.status, 'DISCOVERED');

  now.value = 21_000;
  await engine.acceptSnapshot(snapshot('5m', 21_000, [trendingItem({ token, rank: 5 })]));
  now.value = 21_001;
  await engine.acceptSnapshot(snapshot('1m', 21_001, [trendingItem({ token, rank: 5 })]));
  now.value = 31_001;
  await engine.acceptSnapshot(snapshot('1m', 31_001, [trendingItem({ token, rank: 5 })]));
  assert.equal(candidates.find('bsc', token)!.status, 'RADAR');
  database.close();
});

test('real-pool activation waits on low liquidity while old pools can revive and bonding needs strong heat', async () => {
  const now = { value: 2_000_000_000 };
  const good = address(10);
  const lowLiquidity = address(11);
  const oldPool = address(12);
  const bonding = address(13);
  const { database, engine, candidates } = setup(now, (token) => {
    if (token === lowLiquidity) {
      return tokenInfo({ token, fetchedAtMs: now.value, liquidity: 9_999 });
    }
    if (token === oldPool) {
      return tokenInfo({
        token,
        fetchedAtMs: now.value,
        poolCreatedAtMs: now.value - 21_601_000
      });
    }
    if (token === bonding) {
      return tokenInfo({
        token,
        fetchedAtMs: now.value,
        pool: null,
        openAtMs: null,
        poolCreatedAtMs: null,
        liquidity: 0
      });
    }
    return tokenInfo({ token, fetchedAtMs: now.value });
  });
  const items = [good, lowLiquidity, oldPool, bonding].map((token, rank) =>
    trendingItem({ token, rank: rank + 1, marketCap: rank === 0 ? 300_000 : 100_000 })
  );
  await engine.acceptSnapshot(snapshot('1m', now.value - 1_000, items));
  await engine.acceptSnapshot(snapshot('5m', now.value, items));
  now.value += 10_000;
  await engine.acceptSnapshot(snapshot('1m', now.value, items));

  assert.equal(candidates.find('bsc', good)!.status, 'PREHEAT');
  assert.equal(candidates.find('bsc', lowLiquidity)!.status, 'DISCOVERED');
  assert.equal(candidates.find('bsc', lowLiquidity)!.terminalReason, null);
  assert.equal(candidates.find('bsc', oldPool)!.status, 'PREHEAT');
  assert.equal(candidates.find('bsc', oldPool)!.opportunityType, 'revival');
  assert.equal(candidates.find('bsc', bonding)!.status, 'RADAR');
  database.close();
});

test('sampled high-water starts at real-pool activation and ignores bonding-era gains', async () => {
  const now = { value: 3_000_000_000 };
  const token = address(20);
  let resolutions = 0;
  const { database, engine, candidates } = setup(now, (candidate) => {
    resolutions += 1;
    return tokenInfo({ token: candidate, fetchedAtMs: now.value });
  });
  await engine.acceptSnapshot(
    snapshot('1m', now.value, [trendingItem({ token, rank: 10, price: 0.001 })])
  );
  now.value += 3_000;
  await engine.acceptSnapshot(
    snapshot('1m', now.value, [trendingItem({ token, rank: 9, price: 0.0018 })])
  );
  assert.equal(candidates.find('bsc', token)!.status, 'DISCOVERED');
  now.value += 3_000;
  await engine.acceptSnapshot(
    snapshot('1m', now.value, [trendingItem({ token, rank: 8, price: 0.00181 })])
  );
  assert.equal(candidates.find('bsc', token)!.status, 'PREHEAT');
  assert.equal(candidates.find('bsc', token)!.activationPriceUsd, 0.00181);
  now.value += 3_000;
  await engine.acceptSnapshot(
    snapshot('1m', now.value, [trendingItem({ token, rank: 7, price: 0.0033 })])
  );
  assert.equal(candidates.find('bsc', token)!.highPriceUsd, 0.0033);
  assert.equal(candidates.find('bsc', token)!.status, 'REJECTED');
  assert.equal(resolutions, 1);
  database.close();
});

test('qualification window expires atomically at 120 seconds and remains terminal', () => {
  const now = { value: 1_000 };
  const token = address(30);
  const { database, engine, candidates } = setup(now, (candidate) =>
    tokenInfo({ token: candidate, fetchedAtMs: now.value })
  );
  candidates.findOrCreate({
    chain: 'bsc',
    tokenAddress: token,
    firstSeenAtMs: 1_000,
    firstSeenPriceUsd: 0.001,
    firstSeenRank: 1,
    firstSeenMarketCapUsd: 100_000,
    firstSeenLiquidityUsd: 20_000,
    discoveryRuleVersion: setupRule(database)
  });
  candidates.transition('bsc', token, 'PREHEAT', { atMs: 1_000 });
  new PoolBindingRepository(database).bind({
    chain: 'bsc',
    tokenAddress: token,
    poolAddress: address(901),
    candidateSide: 'base',
    counterTokenAddress: address(902),
    boundAtMs: 1_000
  });
  assert.equal(engine.expireQualificationWindows(120_999).length, 0);
  assert.equal(engine.expireQualificationWindows(121_000).length, 1);
  assert.equal(candidates.find('bsc', token)!.status, 'EXPIRED');
  assert.throws(() => candidates.transition('bsc', token, 'MONITORING'), /invalid/);
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM qualification_events WHERE reason_code = 'QUALIFICATION_WINDOW_EXPIRED'")
      .get()!.count,
    1
  );
  database.close();
});

test('poller startup expires overdue qualifications even when GMGN is unavailable', () => {
  const now = { value: 121_000 };
  const token = address(31);
  const { database, config, engine, candidates } = setup(now, (candidate) =>
    tokenInfo({ token: candidate, fetchedAtMs: now.value })
  );
  candidates.findOrCreate({
    chain: 'bsc',
    tokenAddress: token,
    firstSeenAtMs: 1_000,
    firstSeenPriceUsd: 0.001,
    firstSeenRank: 1,
    firstSeenMarketCapUsd: 100_000,
    firstSeenLiquidityUsd: 20_000,
    discoveryRuleVersion: setupRule(database)
  });
  candidates.transition('bsc', token, 'PREHEAT', { atMs: 1_000 });
  new PoolBindingRepository(database).bind({
    chain: 'bsc',
    tokenAddress: token,
    poolAddress: address(903),
    candidateSide: 'base',
    counterTokenAddress: address(904),
    boundAtMs: 1_000
  });
  const unavailable: TrendingSource = {
    async getTrending() {
      throw new Error('GMGN unavailable');
    }
  };
  const expiredTokens: string[] = [];
  const poller = new DiscoveryPoller(unavailable, engine, {
    ...config,
    chains: { sol: false, bsc: true }
  }, () => undefined, () => undefined, (expired) => {
    expiredTokens.push(...expired.map((candidate) => candidate.tokenAddress));
  });
  poller.start();
  assert.equal(candidates.find('bsc', token)!.status, 'EXPIRED');
  assert.deepEqual(expiredTokens, [token]);
  poller.stop();
  database.close();
});

test('poller prevents overlapping requests and a failed request cannot refresh snapshots', async () => {
  const now = { value: 4_000_000_000 };
  const token = address(40);
  const { database, config, engine, candidates } = setup(now, (candidate) =>
    tokenInfo({ token: candidate, fetchedAtMs: now.value })
  );
  let release: ((value: GmgnTrendingSnapshot) => void) | undefined;
  let calls = 0;
  const source: TrendingSource = {
    async getTrending(_chain, interval, limit) {
      calls += 1;
      assert.equal(limit, 100);
      if (calls === 1) {
        return await new Promise<GmgnTrendingSnapshot>((resolve) => {
          release = resolve;
        });
      }
      if (calls === 2) throw new Error('temporary GMGN failure');
      return snapshot(interval, now.value, [trendingItem({ token, rank: 8 })]);
    }
  };
  const poller = new DiscoveryPoller(source, engine, config);
  const first = poller.pollOnce('bsc', '1m');
  assert.equal(await poller.pollOnce('bsc', '1m'), false);
  release?.(snapshot('1m', now.value, [trendingItem({ token, rank: 10 })]));
  assert.equal(await first, true);
  await assert.rejects(() => poller.pollOnce('bsc', '5m'), /temporary GMGN failure/);
  now.value += 7_000;
  assert.equal(await poller.pollOnce('bsc', '5m'), true);
  assert.equal(candidates.find('bsc', token)!.status, 'DISCOVERED');
  assert.equal(calls, 3);
  database.close();
});

test('stale snapshots are rejected without advancing discovery state', async () => {
  const now = { value: 5_000_000_000 };
  const token = address(50);
  const { database, engine, candidates } = setup(now, (candidate) =>
    tokenInfo({ token: candidate, fetchedAtMs: now.value })
  );
  await assert.rejects(
    () =>
      engine.acceptSnapshot(
        snapshot('1m', now.value - 6_001, [trendingItem({ token, rank: 1 })])
      ),
    /freshness window/
  );
  assert.equal(candidates.find('bsc', token), undefined);
  assert.equal(database.prepare('SELECT count(*) AS count FROM rank_snapshots').get()!.count, 0);
  database.close();
});

test('stop then start cannot revive the previous polling generation', async () => {
  const now = { value: 5_500_000_000 };
  const { database, engine } = setup(now, (candidate) =>
    tokenInfo({ token: candidate, fetchedAtMs: now.value })
  );
  let oneMinuteCalls = 0;
  let releaseFirst: ((value: GmgnTrendingSnapshot) => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const source: TrendingSource = {
    async getTrending(_chain, interval) {
      if (interval === '5m') return snapshot('5m', now.value, []);
      oneMinuteCalls += 1;
      if (oneMinuteCalls === 1) {
        markFirstStarted?.();
        return await new Promise<GmgnTrendingSnapshot>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return snapshot('1m', now.value, []);
    }
  };
  const poller = new DiscoveryPoller(source, engine, {
    chains: { sol: true, bsc: false },
    polling: { oneMinuteMs: 1_000, fiveMinuteMs: 1_000 }
  });
  poller.start();
  await firstStarted;
  poller.stop();
  poller.start();
  releaseFirst?.(snapshot('1m', now.value, []));
  await poller.drain();
  poller.stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(oneMinuteCalls, 1);
  database.close();
});

test('duplicate normalized BSC addresses reject the whole successful batch', async () => {
  const now = { value: 6_000_000_000 };
  const lower = '0xabcdef0000000000000000000000000000000001';
  const checksum = '0xAbCdEf0000000000000000000000000000000001';
  const { database, engine } = setup(now, (candidate) =>
    tokenInfo({ token: candidate, fetchedAtMs: now.value })
  );
  await assert.rejects(
    () =>
      engine.acceptSnapshot(
        snapshot('1m', now.value, [
          trendingItem({ token: lower, rank: 1 }),
          trendingItem({ token: checksum, rank: 2 })
        ])
      ),
    /duplicate normalized/
  );
  assert.equal(
    database.prepare('SELECT count(*) AS count FROM rank_snapshot_fetches').get()!.count,
    0
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM candidates').get()!.count, 0);
  database.close();
});

test('successful snapshot batch rolls back its header and candidate on evidence failure', async () => {
  const now = { value: 7_000_000_000 };
  const token = address(60);
  const { database, engine } = setup(now, (candidate) =>
    tokenInfo({ token: candidate, fetchedAtMs: now.value })
  );
  const item = trendingItem({ token, rank: 1 });
  await assert.rejects(
    () => engine.acceptSnapshot(snapshot('1m', now.value, [{ ...item, raw: { bad: 1n } }])),
    /BigInt/
  );
  assert.equal(
    database.prepare('SELECT count(*) AS count FROM rank_snapshot_fetches').get()!.count,
    0
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM candidates').get()!.count, 0);
  database.close();
});

test('a rolled-back snapshot cannot advance the in-memory dual-rank counter', async () => {
  const now = { value: 7_100_000_000 };
  const token = address(61);
  const badToken = address(62);
  const { database, engine, candidates } = setup(now, (candidate) =>
    tokenInfo({
      token: candidate,
      fetchedAtMs: now.value,
      pool: null,
      openAtMs: null,
      poolCreatedAtMs: null,
      liquidity: 0
    })
  );
  await engine.acceptSnapshot(
    snapshot('5m', now.value, [trendingItem({ token, rank: 5 })])
  );

  now.value += 1_000;
  const invalid = trendingItem({ token: badToken, rank: 6 });
  await assert.rejects(
    () => engine.acceptSnapshot(snapshot('1m', now.value, [
      trendingItem({ token, rank: 5 }),
      { ...invalid, raw: { bad: 1n } }
    ])),
    /BigInt/
  );

  now.value += 1_000;
  await engine.acceptSnapshot(
    snapshot('1m', now.value, [trendingItem({ token, rank: 5 })])
  );
  assert.equal(candidates.find('bsc', token)!.status, 'DISCOVERED');
  database.close();
});

test('a suspended chain can observe polling success without creating candidates', async () => {
  const now = { value: 8_000_000_000 };
  const database = openDatabase(':memory:');
  const config = parseConfig({ ...ENV });
  const engine = new CandidateDiscoveryEngine(
    database,
    config,
    async (_chain, token) => tokenInfo({ token, fetchedAtMs: now.value }),
    () => now.value,
    () => false
  );
  const result = await engine.acceptSnapshot(
    snapshot('1m', now.value, [trendingItem({ token: address(70), rank: 1 })])
  );
  assert.deepEqual(result, { observed: 0, created: 0, activated: 0 });
  assert.equal(database.prepare('SELECT count(*) AS count FROM candidates').get()!.count, 0);
  assert.equal(
    database.prepare('SELECT count(*) AS count FROM rank_snapshot_fetches').get()!.count,
    0
  );
  database.close();
});
