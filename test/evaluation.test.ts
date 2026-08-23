import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseConfig, type Chain } from '../src/config.js';
import { openDatabase, withTransaction, type SqliteDatabase } from '../src/db/database.js';
import {
  CandidateRepository,
  OutboxRepository,
  RuleVersionRepository
} from '../src/db/repositories.js';
import { EvaluationRepository } from '../src/evaluation/repository.js';
import {
  evaluateOhlcvPath,
  evaluateTradePath,
  isEntryWindowCovered,
  selectEntryTrade
} from '../src/evaluation/rules.js';
import { EVALUATION_POLICY } from '../src/evaluation/policy.js';
import { EvaluationService } from '../src/evaluation/service.js';
import type {
  CoinGeckoOhlcvBar,
  CoinGeckoPoolDetail,
  CoinGeckoTrade
} from '../src/providers/coingecko.js';
import type { GmgnTokenSecurity } from '../src/providers/gmgn.js';
import { ProviderRequestError } from '../src/providers/http.js';
import type { DeliveredSignalSnapshot } from '../src/telegram/messages.js';

const POOL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const COUNTER = '0xffffffffffffffffffffffffffffffffffffffff';

function tokenFor(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function config() {
  return parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test'
  });
}

function pool(tokenAddress: string, fetchedAtMs: number, reserveUsd = 12_000): CoinGeckoPoolDetail {
  return {
    chain: 'bsc',
    network: 'bsc',
    poolAddress: POOL,
    candidateTokenAddress: tokenAddress,
    candidateSide: 'base',
    counterTokenAddress: COUNTER,
    baseTokenAddress: tokenAddress,
    quoteTokenAddress: COUNTER,
    reserveUsd,
    baseLiquidityUsd: reserveUsd / 2,
    quoteLiquidityUsd: reserveUsd / 2,
    poolCreatedAtMs: fetchedAtMs - 60_000,
    fetchedAtMs,
    raw: { reserve_in_usd: String(reserveUsd) }
  };
}

function trade(
  tokenAddress: string,
  id: string,
  kind: 'buy' | 'sell',
  priceUsd: number,
  atMs: number
): CoinGeckoTrade {
  return {
    id,
    kind,
    blockTimestampMs: atMs,
    volumeUsd: 10,
    candidatePriceUsd: priceUsd,
    fromTokenAddress: kind === 'buy' ? COUNTER : tokenAddress,
    toTokenAddress: kind === 'buy' ? tokenAddress : COUNTER,
    fromTokenAmount: 1,
    toTokenAmount: 1,
    raw: { id, kind, priceUsd }
  };
}

function security(tokenAddress: string, fetchedAtMs: number): GmgnTokenSecurity {
  return {
    chain: 'bsc',
    tokenAddress,
    fetchedAtMs,
    raw: {
      top_10_holder_rate: '0.20',
      is_honeypot: false,
      is_open_source: true,
      is_renounced: true,
      buy_tax: '0.01',
      sell_tax: '0.01'
    }
  };
}

function snapshot(tokenAddress: string, receiptAtMs: number, ruleVersion: string): DeliveredSignalSnapshot {
  const detail = pool(tokenAddress, receiptAtMs);
  return {
    channelRole: 'validation',
    sendRequestedAtMs: receiptAtMs - 100,
    preSendPriceUsd: 100,
    preSendTradeAtMs: receiptAtMs - 200,
    eligibility: {
      chain: 'bsc',
      tokenAddress,
      pool: detail,
      decisionPriceUsd: 100,
      decisionTradeAtMs: receiptAtMs - 200,
      firstSeenAtMs: receiptAtMs - 20_000,
      sampledMaxGain: 0.4,
      security: { top10Ratio: 0.2, buyTaxRatio: 0.01, sellTaxRatio: 0.01 },
      trades: {
        passed: true,
        reasons: [],
        trades: [],
        latestTradeAtMs: receiptAtMs - 200,
        decisionPriceUsd: 100,
        buyCountRatio: 0.6,
        netBuyUsd: 10,
        largestTradeRatio: 0.4
      },
      liquidity: {
        outcome: 'PASS',
        reasons: [],
        intervalMs: 10_000,
        reserveDeclineRatio: 0,
        counterSideLiquidityUsd: 6_000,
        depthRatio: 100 / 6_000
      },
      ruleVersion,
      qualifiedAtMs: receiptAtMs - 500,
      validUntilMs: receiptAtMs + 10_000
    }
  };
}

function setupDatabase(): { database: SqliteDatabase; runtime: ReturnType<typeof config> } {
  const database = openDatabase(':memory:');
  const runtime = config();
  new RuleVersionRepository(database).save(runtime.ruleVersion, {
    thresholds: runtime.thresholds,
    discoveryPolicy: runtime.discoveryPolicy,
    qualificationPolicy: runtime.qualificationPolicy
  });
  return { database, runtime };
}

function addSample(
  database: SqliteDatabase,
  runtime: ReturnType<typeof config>,
  index: number,
  receiptAtMs: number,
  stage: 'validation' | 'formal' = 'validation'
) {
  const tokenAddress = tokenFor(index);
  new CandidateRepository(database).findOrCreate({
    chain: 'bsc',
    tokenAddress,
    firstSeenAtMs: receiptAtMs - 20_000,
    firstSeenPriceUsd: 50,
    firstSeenRank: 1,
    firstSeenMarketCapUsd: 50_000,
    firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: runtime.ruleVersion
  });
  const outboxes = new OutboxRepository(database);
  const outbox = outboxes.createOrGet({
    chain: 'bsc',
    tokenAddress,
    messageKind: 'signal',
    channelRole: stage,
    payload: {},
    createdAtMs: receiptAtMs
  }).record;
  const delivered = { ...snapshot(tokenAddress, receiptAtMs, runtime.ruleVersion), channelRole: stage };
  return withTransaction(database, () => {
    outboxes.claim(outbox.id, receiptAtMs - 1);
    outboxes.markSent(outbox.id, `message-${index}`, receiptAtMs);
    return new EvaluationRepository(database).recordDelivered({
      outboxId: outbox.id,
      snapshot: delivered,
      receiptAtMs
    });
  });
}

class MarketSource {
  trades: readonly CoinGeckoTrade[] = [];
  bars: readonly CoinGeckoOhlcvBar[] = [];
  reserveUsd = 12_000;
  detailError: unknown;
  detailCalls = 0;
  tradeCalls = 0;

  constructor(private readonly now: { value: number }) {}

  async getPoolDetail(
    _chain: Chain,
    _poolAddress: string,
    candidateTokenAddress: string
  ): Promise<CoinGeckoPoolDetail> {
    this.detailCalls += 1;
    if (this.detailError !== undefined) throw this.detailError;
    return pool(candidateTokenAddress, this.now.value, this.reserveUsd);
  }

  async getPoolTrades(): Promise<readonly CoinGeckoTrade[]> {
    this.tradeCalls += 1;
    return this.trades;
  }

  async getPoolOhlcv(): Promise<readonly CoinGeckoOhlcvBar[]> {
    return this.bars;
  }
}

class SecuritySource {
  error: unknown;

  constructor(private readonly now: { value: number }) {}

  async getTokenSecurity(chain: Chain, tokenAddress: string): Promise<GmgnTokenSecurity> {
    if (this.error !== undefined) throw this.error;
    assert.equal(chain, 'bsc');
    return security(tokenAddress, this.now.value);
  }
}

test('entry uses the first trade from the target through the inclusive three-second window', () => {
  const token = tokenFor(1);
  const receipt = 1_000_000;
  const input = [
    trade(token, 'before', 'buy', 100, receipt + 9_000),
    trade(token, 'at', 'buy', 101, receipt + 10_000),
    trade(token, 'after', 'buy', 102, receipt + 10_001)
  ];
  assert.equal(
    selectEntryTrade(input, receipt + 10_000, EVALUATION_POLICY.entryTradeMaxDelayMs)!.id,
    'at'
  );
  assert.equal(
    selectEntryTrade(
      input.filter((item) => item.id !== 'at'),
      receipt + 10_000,
      EVALUATION_POLICY.entryTradeMaxDelayMs
    )!.id,
    'after'
  );
  assert.equal(
    selectEntryTrade(
      [
        trade(token, 'before', 'buy', 100, receipt + 9_999),
        trade(token, 'inclusive', 'buy', 103, receipt + 13_000),
        trade(token, 'outside', 'buy', 104, receipt + 13_001)
      ],
      receipt + 10_000,
      EVALUATION_POLICY.entryTradeMaxDelayMs
    )!.id,
    'inclusive'
  );
  assert.equal(
    selectEntryTrade(
      [
        trade(token, 'before', 'buy', 100, receipt + 9_999),
        trade(token, 'outside', 'buy', 104, receipt + 13_001)
      ],
      receipt + 10_000,
      EVALUATION_POLICY.entryTradeMaxDelayMs
    ),
    undefined
  );
  assert.equal(
    isEntryWindowCovered(
      input,
      receipt + 10_000,
      EVALUATION_POLICY.poolTradesPageSize
    ),
    true
  );
  assert.equal(
    isEntryWindowCovered(
      Array.from({ length: 300 }, (_, index) =>
        trade(token, `saturated-${index}`, 'buy', 100, receipt + 13_001 + index)
      ),
      receipt + 10_000,
      EVALUATION_POLICY.poolTradesPageSize
    ),
    false
  );
  assert.equal(
    isEntryWindowCovered(
      Array.from({ length: EVALUATION_POLICY.poolTradesPageSize }, (_, index) =>
        trade(token, `partial-${index}`, 'buy', 100, receipt + 10_001 + index)
      ),
      receipt + 10_000,
      EVALUATION_POLICY.poolTradesPageSize
    ),
    false
  );

  const sameTimestamp = [
    trade(token, 'up', 'buy', 130, receipt + 20_000),
    trade(token, 'down', 'sell', 85, receipt + 20_000)
  ];
  const tradePath = evaluateTradePath(sameTimestamp, 100, receipt + 10_000, receipt + 30_000)!;
  assert.equal(tradePath.path30_15, 'AMBIGUOUS');
  const candlePath = evaluateOhlcvPath(
    [{ openAtMs: receipt + 20_000, open: 100, high: 130, low: 85, close: 110, volumeUsd: 10 }],
    100,
    receipt + 10_000,
    receipt + 30_000,
    1_000
  )!;
  assert.equal(candlePath.path30_15, 'AMBIGUOUS');
  const closedOnly = evaluateOhlcvPath(
    [
      { openAtMs: receipt + 9_000, open: 100, high: 999, low: 1, close: 100, volumeUsd: 1 },
      { openAtMs: receipt + 20_000, open: 100, high: 120, low: 90, close: 110, volumeUsd: 1 },
      { openAtMs: receipt + 30_000, open: 110, high: 999, low: 1, close: 999, volumeUsd: 1 }
    ],
    100,
    receipt + 10_000,
    receipt + 30_500,
    1_000
  )!;
  assert.ok(Math.abs(closedOnly.mfe - 0.2) < 1e-12);
  assert.ok(Math.abs(closedOnly.mae + 0.1) < 1e-12);
  assert.equal(closedOnly.priceUsd, 110);
});

test('only a matching Telegram SENT receipt can become an evaluation sample', () => {
  const { database, runtime } = setupDatabase();
  const receiptAtMs = 1_500_000;
  const tokenAddress = tokenFor(50);
  new CandidateRepository(database).findOrCreate({
    chain: 'bsc',
    tokenAddress,
    firstSeenAtMs: receiptAtMs - 1_000,
    firstSeenPriceUsd: 100,
    firstSeenRank: 1,
    firstSeenMarketCapUsd: 50_000,
    firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: runtime.ruleVersion
  });
  const outbox = new OutboxRepository(database).createOrGet({
    chain: 'bsc',
    tokenAddress,
    messageKind: 'signal',
    channelRole: 'validation',
    payload: {},
    createdAtMs: receiptAtMs
  }).record;
  assert.throws(
    () =>
      new EvaluationRepository(database).recordDelivered({
        outboxId: outbox.id,
        snapshot: snapshot(tokenAddress, receiptAtMs, runtime.ruleVersion),
        receiptAtMs
      }),
    /Telegram SENT receipt/
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM delivered_signal_samples').get()!.count,
    0
  );
  database.close();
});

test('evaluation records the 10-second entry, sell proxy, trades path and OHLCV ambiguity', async () => {
  const { database, runtime } = setupDatabase();
  const receipt = 2_000_000;
  const sample = addSample(database, runtime, 2, receipt);
  const now = { value: receipt + 12_999 };
  const market = new MarketSource(now);
  const gmgn = new SecuritySource(now);
  market.trades = [
    trade(sample.tokenAddress, 'sell', 'sell', 99, receipt + 8_000),
    trade(sample.tokenAddress, 'entry', 'buy', 100, receipt + 11_000),
    trade(sample.tokenAddress, 'future', 'buy', 500, receipt + 14_000)
  ];
  const service = new EvaluationService(database, runtime, market, gmgn, () => now.value);
  await service.tick();
  assert.equal(new EvaluationRepository(database).findSample(sample.id)!.entryStatus, 'PENDING');
  const entrySchedule = database
    .prepare(`
      SELECT scheduled_at_ms, next_attempt_at_ms
      FROM signal_evaluation_points WHERE sample_id = ? AND horizon_seconds = 10
    `)
    .get(sample.id)!;
  assert.deepEqual(
    [entrySchedule.scheduled_at_ms, entrySchedule.next_attempt_at_ms],
    [receipt + 10_000, receipt + 13_000]
  );
  now.value = receipt + 13_000;
  await service.tick();
  const entered = new EvaluationRepository(database).findSample(sample.id)!;
  assert.equal(entered.entryPriceUsd, 100);
  assert.equal(entered.entryTradeAtMs, receipt + 11_000);
  assert.equal(entered.sellTradeObserved, true);
  const entryDetails = JSON.parse(String(database
    .prepare(`
      SELECT details_json FROM signal_evaluation_points
      WHERE sample_id = ? AND horizon_seconds = 10
    `)
    .get(sample.id)!.details_json)) as { entryDelayMs: number; entryTradeAtMs: number };
  assert.deepEqual(
    [entryDetails.entryDelayMs, entryDetails.entryTradeAtMs],
    [1_000, receipt + 11_000]
  );

  now.value = receipt + 30_000;
  market.trades = [
    trade(sample.tokenAddress, 'entry', 'buy', 100, receipt + 11_000),
    trade(sample.tokenAddress, 'up', 'buy', 130, receipt + 20_000),
    trade(sample.tokenAddress, 'down', 'sell', 85, receipt + 25_000)
  ];
  await service.tick();
  const point30 = database
    .prepare(`
      SELECT status, gross_return, path_30_15, source
      FROM signal_evaluation_points WHERE sample_id = ? AND horizon_seconds = 30
    `)
    .get(sample.id)!;
  assert.equal(point30.status, 'COMPLETE');
  assert.equal(point30.path_30_15, 'UP_FIRST');
  assert.equal(point30.source, 'TRADES');

  now.value = receipt + 300_000;
  market.bars = [
    { openAtMs: receipt + 120_000, open: 100, high: 130, low: 85, close: 110, volumeUsd: 10 }
  ];
  await service.tick();
  const point300 = database
    .prepare(`
      SELECT status, path_30_15, source, granularity, details_json
      FROM signal_evaluation_points WHERE sample_id = ? AND horizon_seconds = 300
    `)
    .get(sample.id)!;
  assert.equal(point300.status, 'COMPLETE');
  assert.equal(point300.path_30_15, 'UP_FIRST');
  assert.equal(point300.source, 'OHLCV');
  assert.equal(point300.granularity, '1-second');
  assert.match(String(point300.details_json), /"grossPriceOnly":true/);
  assert.match(String(point300.details_json), /"executableSaleClaimed":false/);
  database.close();
});

test('pool disappearance is terminal while provider failure retries once and remains visible', async () => {
  const terminalSetup = setupDatabase();
  const terminalReceipt = 3_000_000;
  const terminalSample = addSample(
    terminalSetup.database,
    terminalSetup.runtime,
    3,
    terminalReceipt
  );
  const terminalNow = { value: terminalReceipt + 13_000 };
  const terminalMarket = new MarketSource(terminalNow);
  terminalMarket.detailError = new ProviderRequestError('coingecko', 'pool_detail', 'http', 404);
  await new EvaluationService(
    terminalSetup.database,
    terminalSetup.runtime,
    terminalMarket,
    new SecuritySource(terminalNow),
    () => terminalNow.value
  ).tick();
  assert.equal(
    terminalSetup.database
      .prepare('SELECT status FROM signal_evaluation_points WHERE sample_id = ? AND horizon_seconds = 10')
      .get(terminalSample.id)!.status,
    'TERMINAL_NEGATIVE'
  );
  terminalSetup.database.close();

  const missingSetup = setupDatabase();
  const missingReceipt = 4_000_000;
  const missingSample = addSample(missingSetup.database, missingSetup.runtime, 4, missingReceipt);
  const missingNow = { value: missingReceipt + 13_000 };
  const missingSecurity = new SecuritySource(missingNow);
  missingSecurity.error = new Error('gmgn unavailable');
  const missingService = new EvaluationService(
    missingSetup.database,
    missingSetup.runtime,
    new MarketSource(missingNow),
    missingSecurity,
    () => missingNow.value
  );
  await missingService.tick();
  let point = missingSetup.database
    .prepare('SELECT status, retry_count FROM signal_evaluation_points WHERE sample_id = ? AND horizon_seconds = 10')
    .get(missingSample.id)!;
  assert.deepEqual([point.status, point.retry_count], ['PENDING', 1]);
  missingNow.value += 2_999;
  await missingService.tick();
  point = missingSetup.database
    .prepare('SELECT status FROM signal_evaluation_points WHERE sample_id = ? AND horizon_seconds = 10')
    .get(missingSample.id)!;
  assert.equal(point.status, 'PENDING');
  missingNow.value += 1;
  await missingService.tick();
  point = missingSetup.database
    .prepare('SELECT status FROM signal_evaluation_points WHERE sample_id = ? AND horizon_seconds = 10')
    .get(missingSample.id)!;
  assert.equal(point.status, 'PROVIDER_MISSING');
  assert.equal(
    missingSetup.database
      .prepare(`
        SELECT COUNT(*) AS count FROM signal_evaluation_points
        WHERE sample_id = ? AND status = 'PROVIDER_MISSING'
      `)
      .get(missingSample.id)!.count,
    9
  );
  const report = new EvaluationRepository(missingSetup.database).liveReport('bsc', missingNow.value) as {
    totalDelivered: number;
    segments: Array<{ providerMissing: number; coverage: number }>;
  };
  assert.equal(report.totalDelivered, 1);
  assert.equal(report.segments.find((segment) => segment.providerMissing === 1)!.coverage, 0);
  missingSetup.database.close();
});

test('a saturated trades page missing the target boundary is provider missing', async () => {
  const { database, runtime } = setupDatabase();
  const receipt = 4_500_000;
  const sample = addSample(database, runtime, 5, receipt);
  const now = { value: receipt + 13_000 };
  const market = new MarketSource(now);
  market.trades = Array.from({ length: EVALUATION_POLICY.poolTradesPageSize }, (_, index) =>
    trade(
      sample.tokenAddress,
      `saturated-${index}`,
      'buy',
      100,
      receipt + 10_001 + index
    )
  );
  await new EvaluationService(
    database,
    runtime,
    market,
    new SecuritySource(now),
    () => now.value
  ).tick();
  assert.equal(
    new EvaluationRepository(database).findSample(sample.id)!.entryStatus,
    'PROVIDER_MISSING'
  );
  const points = database
    .prepare(`
      SELECT status, details_json FROM signal_evaluation_points
      WHERE sample_id = ? ORDER BY horizon_seconds
    `)
    .all(sample.id) as Array<{ status: string; details_json: string }>;
  assert.equal(points.length, EVALUATION_POLICY.horizonsSeconds.length);
  assert.ok(points.every((point) => point.status === 'PROVIDER_MISSING'));
  assert.ok(
    points.every(
      (point) => JSON.parse(point.details_json).providerError === 'ENTRY_WINDOW_NOT_COVERED'
    )
  );
  database.close();
});

test('a legacy due entry waits for the window end and then fails closed after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-entry-policy-restart-'));
  const path = join(directory, 'state.db');
  const runtime = config();
  const receipt = 4_700_000;
  let database = openDatabase(path);
  new RuleVersionRepository(database).save(runtime.ruleVersion, {
    thresholds: runtime.thresholds
  });
  const sample = addSample(database, runtime, 6, receipt);
  database
    .prepare(`
      UPDATE signal_evaluation_points
      SET next_attempt_at_ms = scheduled_at_ms, details_json = '{}'
      WHERE sample_id = ? AND horizon_seconds = 10
    `)
    .run(sample.id);
  database.close();

  database = openDatabase(path);
  const now = { value: receipt + 12_999 };
  const market = new MarketSource(now);
  await new EvaluationService(
    database,
    runtime,
    market,
    new SecuritySource(now),
    () => now.value
  ).tick();
  let point = database
    .prepare(`
      SELECT status, next_attempt_at_ms FROM signal_evaluation_points
      WHERE sample_id = ? AND horizon_seconds = 10
    `)
    .get(sample.id)!;
  assert.deepEqual(
    [point.status, point.next_attempt_at_ms, market.detailCalls],
    ['PENDING', receipt + 13_000, 0]
  );
  database.close();

  database = openDatabase(path);
  now.value = receipt + 13_000;
  await new EvaluationService(
    database,
    runtime,
    market,
    new SecuritySource(now),
    () => now.value
  ).tick();
  point = database
    .prepare(`
      SELECT status, details_json FROM signal_evaluation_points
      WHERE sample_id = ? AND horizon_seconds = 10
    `)
    .get(sample.id)!;
  assert.equal(point.status, 'PROVIDER_MISSING');
  assert.equal(JSON.parse(String(point.details_json)).providerError, 'ENTRY_POLICY_UNAVAILABLE');
  assert.equal(market.detailCalls, 0);
  database.close();
});

test('a pending entry is not evaluated under a different decision rule version', async () => {
  const { database, runtime } = setupDatabase();
  const receipt = 4_800_000;
  const sample = addSample(database, runtime, 7, receipt);
  const changedRuntime = parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test',
    MARKET_CAP_MAX_USD: '600000'
  });
  assert.notEqual(changedRuntime.ruleVersion, runtime.ruleVersion);
  const now = { value: receipt + 13_000 };
  const market = new MarketSource(now);
  await new EvaluationService(
    database,
    changedRuntime,
    market,
    new SecuritySource(now),
    () => now.value
  ).tick();
  const point = database
    .prepare(`
      SELECT status, details_json FROM signal_evaluation_points
      WHERE sample_id = ? AND horizon_seconds = 10
    `)
    .get(sample.id)!;
  assert.equal(point.status, 'PROVIDER_MISSING');
  assert.equal(JSON.parse(String(point.details_json)).providerError, 'ENTRY_POLICY_UNAVAILABLE');
  assert.equal(market.detailCalls, 0);
  database.close();
});

test('twenty ordered 15-minute samples promote one chain without a day gate and suspension starts a new epoch', () => {
  const { database, runtime } = setupDatabase();
  const repository = new EvaluationRepository(database);
  const samples = Array.from({ length: 20 }, (_, index) =>
    addSample(database, runtime, 100 + index, 5_000_000 + index)
  );
  database
    .prepare(`
      UPDATE signal_evaluation_points SET status = 'COMPLETE'
      WHERE horizon_seconds = 900 AND sample_id IN (
        SELECT id FROM delivered_signal_samples WHERE validation_seq BETWEEN 2 AND 20
      )
    `)
    .run();
  assert.equal(repository.maybePromoteBeta('bsc', 5_900_000), false);
  database
    .prepare(`
      UPDATE signal_evaluation_points SET status = 'TERMINAL_NEGATIVE'
      WHERE sample_id = ? AND horizon_seconds = 900
    `)
    .run(samples[0]!.id);
  assert.equal(repository.maybePromoteBeta('bsc', 5_900_100), true);
  assert.equal(repository.chainState('bsc').state, 'BETA');
  assert.equal(repository.chainState('sol').state, 'VALIDATING');
  const live = repository.liveReport('bsc', 5_900_100) as { statement: string };
  assert.match(live.statement, /不代表可执行净利润/);

  repository.suspend('bsc', 'duplicate message', 5_900_101);
  assert.equal(repository.chainState('bsc').state, 'SUSPENDED');
  assert.equal(new CandidateRepository(database).find('bsc', samples[0]!.tokenAddress)!.status, 'REJECTED');
  const resumed = repository.resumeAfterFix('bsc', 5_900_102);
  assert.deepEqual(
    [resumed.state, resumed.validationEpoch, resumed.nextValidationSeq],
    ['VALIDATING', 2, 1]
  );
  assert.equal(repository.maybePromoteBeta('bsc', 5_900_103), false);
  assert.equal(new CandidateRepository(database).find('bsc', samples[0]!.tokenAddress)!.status, 'REJECTED');

  const epochTwoSample = addSample(database, runtime, 999, 5_900_104);
  repository.suspend('bsc', 'stale price', 5_900_105);
  assert.equal(repository.resumeAfterFix('bsc', 5_900_106).validationEpoch, 3);
  database
    .prepare(`
      UPDATE signal_evaluation_points SET status = 'COMPLETE'
      WHERE sample_id = ? AND horizon_seconds = 900
    `)
    .run(epochTwoSample.id);
  assert.equal(repository.maybePromoteBeta('bsc', 5_900_107), false);
  database.close();
});

test('early terminal outcomes mature only after each 15-minute checkpoint is due', async () => {
  const { database, runtime } = setupDatabase();
  const repository = new EvaluationRepository(database);
  const baseReceipt = 5_920_000;
  const samples = Array.from({ length: 20 }, (_, index) =>
    addSample(database, runtime, 800 + index, baseReceipt + index)
  );
  for (const sample of samples) {
    repository.markTerminalNegative(sample.id, 'FIXED_POOL_MISSING', sample.receiptAtMs + 10_000);
  }
  const lastMaturityAtMs = samples.at(-1)!.receiptAtMs + 900_000;
  assert.equal(repository.maybePromoteBeta('bsc', lastMaturityAtMs - 1), false);
  const now = { value: lastMaturityAtMs };
  await new EvaluationService(
    database,
    runtime,
    new MarketSource(now),
    new SecuritySource(now),
    () => now.value
  ).tick();
  assert.equal(repository.chainState('bsc').state, 'BETA');
  database.close();
});

test('report status counts use the same due denominator and expose entry unavailable', () => {
  const { database, runtime } = setupDatabase();
  const repository = new EvaluationRepository(database);
  const nowMs = 5_980_000;
  const dueSample = addSample(database, runtime, 850, nowMs - 20_000);
  const futureTerminal = addSample(database, runtime, 851, nowMs - 5_000);
  database
    .prepare(`
      UPDATE signal_evaluation_points
      SET status = 'ENTRY_UNAVAILABLE'
      WHERE sample_id = ?
    `)
    .run(dueSample.id);
  repository.markTerminalNegative(futureTerminal.id, 'FIXED_POOL_MISSING', nowMs);
  const segment = (
    repository.liveReport('bsc', nowMs) as {
      segments: Array<{
        horizonSeconds: number;
        due: number;
        terminalNegative: number;
        entryUnavailable: number;
        coverage: number;
      }>;
    }
  ).segments.find((item) => item.horizonSeconds === 10)!;
  assert.deepEqual(
    [segment.due, segment.terminalNegative, segment.entryUnavailable, segment.coverage],
    [1, 0, 1, 0]
  );
  const matured = (
    repository.liveReport('bsc', nowMs + 5_000) as { segments: typeof segment[] }
  ).segments.find((item) => item.horizonSeconds === 10)!;
  assert.deepEqual(
    [matured.due, matured.terminalNegative, matured.entryUnavailable, matured.coverage],
    [2, 1, 1, 0.5]
  );
  database.close();
});

test('validation sequence allocation survives a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-evaluation-restart-'));
  const path = join(directory, 'state.db');
  const runtime = config();
  let database = openDatabase(path);
  new RuleVersionRepository(database).save(runtime.ruleVersion, { thresholds: runtime.thresholds });
  assert.equal(addSample(database, runtime, 700, 5_950_000).validationSeq, 1);
  database.close();
  database = openDatabase(path);
  assert.equal(addSample(database, runtime, 701, 5_950_001).validationSeq, 2);
  assert.equal(new EvaluationRepository(database).chainState('bsc').nextValidationSeq, 3);
  database.close();
});

test('reports are generated once at 50/100/200/+100 and parameter reviews every 20', () => {
  const { database, runtime } = setupDatabase();
  for (let index = 1; index <= 300; index += 1) {
    addSample(database, runtime, 1_000 + index, 6_000_000 + index);
  }
  const milestones = database
    .prepare("SELECT boundary_count FROM evaluation_reports WHERE kind = 'MILESTONE' ORDER BY boundary_count")
    .all()
    .map((row) => (row as { boundary_count: number }).boundary_count);
  assert.deepEqual(milestones, [50, 100, 200, 300]);
  const reviews = database
    .prepare("SELECT boundary_count FROM evaluation_reports WHERE kind = 'PARAMETER_REVIEW' ORDER BY boundary_count")
    .all()
    .map((row) => (row as { boundary_count: number }).boundary_count);
  assert.deepEqual(reviews, Array.from({ length: 15 }, (_, index) => (index + 1) * 20));
  const segmented = JSON.parse(
    String(
      database
        .prepare("SELECT snapshot_json FROM evaluation_reports WHERE kind = 'MILESTONE' AND boundary_count = 300")
        .get()!.snapshot_json
    )
  ) as { report: { totalDelivered: number; segments: unknown[] } };
  assert.equal(segmented.report.totalDelivered, 300);
  assert.ok(segmented.report.segments.length > 0);
  const review = JSON.parse(
    String(
      database
        .prepare("SELECT snapshot_json FROM evaluation_reports WHERE kind = 'PARAMETER_REVIEW' AND boundary_count = 300")
        .get()!.snapshot_json
    )
  ) as { reviewPolicy: { maximumParameterFamiliesPerChange: number } };
  assert.equal(review.reviewPolicy.maximumParameterFamiliesPerChange, 1);
  database.close();
});

test('progress has no day gate and exposes the 20/50/100/200 remaining counts', () => {
  const { database, runtime } = setupDatabase();
  const repository = new EvaluationRepository(database);
  for (let index = 1; index <= 3; index += 1) {
    addSample(database, runtime, 2_000 + index, 7_000_000 + index);
  }
  const progress = repository.progress('bsc', 7_000_100);
  assert.equal(progress.state, 'VALIDATING');
  assert.equal(progress.validationDelivered, 3);
  assert.equal(progress.validationMatured15m, 0);
  assert.deepEqual(progress.remainingTo, { '20': 20, '50': 47, '100': 97, '200': 197 });
  database.close();
});

test('Beta progress resets to the current epoch even after twenty historical samples', () => {
  const { database, runtime } = setupDatabase();
  const repository = new EvaluationRepository(database);
  const receiptAtMs = 7_500_000;
  for (let index = 1; index <= 20; index += 1) {
    addSample(database, runtime, 3_000 + index, receiptAtMs + index);
  }
  database
    .prepare(`
      UPDATE signal_evaluation_points
      SET status = 'COMPLETE'
      WHERE horizon_seconds = 900
    `)
    .run();
  assert.equal(repository.progress('bsc', receiptAtMs + 901_000).remainingTo['20'], 0);
  repository.suspend('bsc', 'TEST_RESET', receiptAtMs + 902_000);
  repository.resumeAfterFix('bsc', receiptAtMs + 903_000);
  const reset = repository.progress('bsc', receiptAtMs + 904_000);
  assert.equal(reset.totalDelivered, 20);
  assert.equal(reset.validationEpoch, 2);
  assert.equal(reset.validationMatured15m, 0);
  assert.equal(reset.remainingTo['20'], 20);
  database.close();
});
