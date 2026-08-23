import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  CandidateRepository,
  OutboxRepository,
  PoolBindingRepository,
  QualificationEventRepository,
  RankSnapshotFetchRepository,
  RankSnapshotRepository,
  RuleVersionRepository
} from '../src/db/repositories.js';
import { BotRuntime } from '../src/runtime/service.js';
import {
  TelegramExplicitError,
  type TelegramTransportLike
} from '../src/telegram/transport.js';

const TOKEN = '0xabcdef0000000000000000000000000000000001';
const POOL = '0xabcdef0000000000000000000000000000000002';
const COUNTER = '0xabcdef0000000000000000000000000000000003';

test('runtime edits one radar through current-rank omission and lifecycle changes', async () => {
  const now = { value: 9_000_000 };
  const database = openDatabase(':memory:');
  const config = parseConfig({
    NODE_ENV: 'test',
    GMGN_API_KEY: 'gmgn-test',
    COINGECKO_PRO_API_KEY: 'cg-test',
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'telegram-test',
    TELEGRAM_RADAR_CHAT_ID: '-1001',
    TELEGRAM_VALIDATION_CHAT_ID: '-1002',
    TELEGRAM_FORMAL_CHAT_ID: '-1003'
  });
  new RuleVersionRepository(database).save(config.ruleVersion, {
    thresholds: config.thresholds,
    discoveryPolicy: config.discoveryPolicy,
    sourcePolicy: config.sourcePolicy
  });
  const candidates = new CandidateRepository(database);
  candidates.findOrCreate({
    chain: 'bsc',
    tokenAddress: TOKEN,
    firstSeenAtMs: now.value - 20_000,
    firstSeenPriceUsd: 0.001,
    firstSeenRank: 7,
    firstSeenMarketCapUsd: 80_000,
    firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.transition('bsc', TOKEN, 'RADAR', { atMs: now.value });
  const snapshots = new RankSnapshotRepository(database);
  const fetches = new RankSnapshotFetchRepository(database);
  const insertCurrent = (fetchedAtMs: number, rank = 7) => {
    snapshots.insert({
      chain: 'bsc',
      interval: '1m',
      fetchedAtMs,
      tokenAddress: TOKEN,
      rank,
      priceUsd: 0.001,
      marketCapUsd: 80_000,
      liquidityUsd: 12_000,
      raw: { name: 'Runtime Meme', symbol: 'RUN' }
    });
    fetches.insert({
      chain: 'bsc',
      interval: '1m',
      fetchedAtMs,
      itemCount: 1,
      discoveryRuleVersion: config.ruleVersion
    });
  };
  insertCurrent(now.value);
  snapshots.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value - 3_000,
    tokenAddress: TOKEN, rank: 7, priceUsd: 0.001,
    marketCapUsd: 80_000, liquidityUsd: 12_000,
    raw: { name: 'Runtime Meme', symbol: 'RUN' }
  });
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value - 3_000,
    itemCount: 1, discoveryRuleVersion: config.ruleVersion
  });
  snapshots.insert({
    chain: 'bsc', interval: '5m', fetchedAtMs: now.value - 2_000,
    tokenAddress: TOKEN, rank: 7, priceUsd: 0.001,
    marketCapUsd: 80_000, liquidityUsd: 12_000,
    raw: { name: 'Runtime Meme', symbol: 'RUN' }
  });
  fetches.insert({
    chain: 'bsc', interval: '5m', fetchedAtMs: now.value - 2_000,
    itemCount: 1, discoveryRuleVersion: config.ruleVersion
  });
  const events = new QualificationEventRepository(database);
  const recordEvent = (
    tokenAddress: string,
    stage: string,
    reasonCode: string,
    observedAtMs = now.value
  ) => events.record({
    chain: 'bsc', tokenAddress, stage, outcome: 'PASS', reasonCode,
    source: 'gmgn', observedAtMs, raw: {}, normalized: {}, thresholds: {},
    decisionRuleVersion: config.ruleVersion
  });
  recordEvent(TOKEN, 'activation', 'DUAL_RANK_BONDING_CURVE');
  recordEvent(TOKEN, 'radar_public_readiness', 'BSC_RADAR_PUBLIC_READY');

  const sends: string[] = [];
  const edits: string[] = [];
  const editErrors: unknown[] = [];
  const telegram: TelegramTransportLike = {
    async sendMessage(_chatId: string, text: string) {
      sends.push(text);
      return { messageId: '501' };
    },
    async editMessage(
      _chatId: string,
      _messageId: string,
      text: string
    ) {
      edits.push(text);
      const error = editErrors.shift();
      if (error !== undefined) throw error;
    }
  };
  const runtime = new BotRuntime(database, config, {
    gmgn: {} as never,
    coinGecko: {} as never,
    telegram,
    now: () => now.value,
    log: () => undefined
  });
  const processRadar = async () => {
    await (runtime as unknown as {
      processRadar(items: ReturnType<CandidateRepository['listRadarCandidates']>): Promise<void>;
    }).processRadar(candidates.listRadarCandidates());
  };

  await processRadar();
  assert.match(sends[0]!, /Bonding Curve 观察中/);

  now.value += 3_000;
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value,
    itemCount: 0, discoveryRuleVersion: config.ruleVersion
  });
  editErrors.push(
    new TelegramExplicitError(429, 429, 'Too Many Requests: retry after 10')
  );
  await processRadar();
  assert.match(edits[0]!, /热度暂时不足/);

  now.value += 3_000;
  await processRadar();
  assert.equal(edits.length, 1);

  now.value += 7_000;
  await processRadar();
  assert.match(edits[1]!, /热度暂时不足/);

  now.value += 3_000;
  insertCurrent(now.value, 3);
  await processRadar();
  assert.match(edits[2]!, /当前不在公开观察区间/);

  now.value += 3_000;
  insertCurrent(now.value);
  candidates.activate({
    chain: 'bsc', tokenAddress: TOKEN, opportunityType: 'new_pool',
    priceUsd: 0.001, ruleVersion: config.ruleVersion, atMs: now.value
  });
  recordEvent(TOKEN, 'activation', 'RADAR_OPENED_REAL_POOL');
  candidates.transition('bsc', TOKEN, 'PREHEAT', { atMs: now.value });
  await processRadar();
  assert.match(edits[3]!, /真实池验证中/);

  new PoolBindingRepository(database).bind({
    chain: 'bsc', tokenAddress: TOKEN, poolAddress: POOL,
    candidateSide: 'base', counterTokenAddress: COUNTER, boundAtMs: now.value
  });
  candidates.transition('bsc', TOKEN, 'MONITORING', { atMs: now.value });
  candidates.transition('bsc', TOKEN, 'SIGNAL_SENT', { atMs: now.value });
  now.value += 3_000;
  await processRadar();
  assert.match(edits[4]!, /已通过正式资格/);
  assert.equal(sends.length, 1);
  assert.equal(edits.length, 5);

  const pendingToken = '0xabcdef0000000000000000000000000000000009';
  now.value += 3_000;
  candidates.findOrCreate({
    chain: 'bsc', tokenAddress: pendingToken,
    firstSeenAtMs: now.value - 20_000, firstSeenPriceUsd: 0.001,
    firstSeenRank: 7, firstSeenMarketCapUsd: 80_000,
    firstSeenLiquidityUsd: 12_000, discoveryRuleVersion: config.ruleVersion
  });
  candidates.transition('bsc', pendingToken, 'RADAR', { atMs: now.value });
  new OutboxRepository(database).create({
    chain: 'bsc', tokenAddress: pendingToken, messageKind: 'radar',
    channelRole: 'radar', payload: {}, createdAtMs: now.value
  });
  snapshots.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value,
    tokenAddress: pendingToken, rank: 7, priceUsd: 0.001,
    marketCapUsd: 80_000, liquidityUsd: 12_000,
    raw: { name: 'Pending Meme', symbol: 'PEND' }
  });
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value,
    itemCount: 1, discoveryRuleVersion: config.ruleVersion
  });
  await processRadar();
  assert.equal(sends.length, 1);
  recordEvent(pendingToken, 'activation', 'DUAL_RANK_BONDING_CURVE');
  recordEvent(pendingToken, 'radar_public_readiness', 'BSC_RADAR_PUBLIC_READY');
  now.value += 3_000;
  await processRadar();
  assert.equal(sends.length, 2);
  snapshots.insert({
    chain: 'bsc', interval: '5m', fetchedAtMs: now.value,
    tokenAddress: pendingToken, rank: 7, priceUsd: 0.001,
    marketCapUsd: 80_000, liquidityUsd: 12_000,
    raw: { name: 'Pending Meme', symbol: 'PEND' }
  });
  fetches.insert({
    chain: 'bsc', interval: '5m', fetchedAtMs: now.value,
    itemCount: 1, discoveryRuleVersion: config.ruleVersion
  });
  for (const offset of [1_000, 4_000]) {
    snapshots.insert({
      chain: 'bsc', interval: '1m', fetchedAtMs: now.value + offset,
      tokenAddress: pendingToken, rank: 7, priceUsd: 0.001,
      marketCapUsd: 80_000, liquidityUsd: 12_000,
      raw: { name: 'Pending Meme', symbol: 'PEND' }
    });
    fetches.insert({
      chain: 'bsc', interval: '1m', fetchedAtMs: now.value + offset,
      itemCount: 1, discoveryRuleVersion: config.ruleVersion
    });
  }
  now.value += 4_000;
  await processRadar();
  assert.equal(sends.length, 2);

  const revivalToken = '0xabcdef0000000000000000000000000000000008';
  now.value += 1_200;
  candidates.findOrCreate({
    chain: 'bsc', tokenAddress: revivalToken,
    firstSeenAtMs: now.value - 20_000, firstSeenPriceUsd: 0.001,
    firstSeenRank: 7, firstSeenMarketCapUsd: 80_000,
    firstSeenLiquidityUsd: 12_000, discoveryRuleVersion: config.ruleVersion
  });
  candidates.activate({
    chain: 'bsc', tokenAddress: revivalToken, opportunityType: 'revival',
    priceUsd: 0.001, ruleVersion: config.ruleVersion, atMs: now.value
  });
  candidates.transition('bsc', revivalToken, 'PREHEAT', { atMs: now.value });
  recordEvent(revivalToken, 'activation', 'DUAL_RANK_REVIVAL_POOL');
  snapshots.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value,
    tokenAddress: revivalToken, rank: 7, priceUsd: 0.001,
    marketCapUsd: 80_000, liquidityUsd: 12_000,
    raw: { name: 'Revival Meme', symbol: 'REV' }
  });
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value,
    itemCount: 1, discoveryRuleVersion: config.ruleVersion
  });
  await processRadar();
  assert.equal(sends.length, 2);
  assert.equal(events.has({
    chain: 'bsc', tokenAddress: revivalToken,
    stage: 'radar_public_readiness', reasonCode: 'BSC_RADAR_PUBLIC_READY',
    decisionRuleVersion: config.ruleVersion
  }), false);

  const revivalOutbox = new OutboxRepository(database);
  const revivalPayload = {
    text: 'historical revival radar',
    snapshot: {
      chain: 'bsc', tokenAddress: revivalToken,
      firstSeenAtMs: now.value - 20_000, marketCapUsd: 80_000,
      sampledMaxGain: 0, stage: 'real_pool',
      presentation: {
        name: 'Revival Meme', symbol: 'REV', marketCapUsd: 80_000,
        rank: 7, currentGain: 0, activationReason: 'DUAL_RANK'
      }
    }
  };
  const revivalRow = revivalOutbox.create({
    chain: 'bsc', tokenAddress: revivalToken, messageKind: 'radar',
    channelRole: 'radar', payload: revivalPayload, createdAtMs: now.value
  });
  revivalOutbox.claim(revivalRow.id, now.value);
  revivalOutbox.markRadarSent(
    revivalRow.id, 'historical-revival', now.value,
    config.ruleVersion, 'historical-hash'
  );
  const editsBeforeRevival = edits.length;
  await processRadar();
  assert.equal(edits.length, editsBeforeRevival);
  candidates.transition('bsc', revivalToken, 'REJECTED', {
    atMs: now.value, terminalReason: 'TEST_REJECT'
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    now.value += 3_000;
    await processRadar();
    if (edits.slice(editsBeforeRevival).some((text) => /已停止观察/.test(text))) break;
  }
  assert.ok(edits.slice(editsBeforeRevival).some((text) => /已停止观察/.test(text)));

  const fairTokens = [4, 5, 6, 7].map(
    (suffix) => `0xabcdef000000000000000000000000000000000${suffix}`
  );
  now.value += 1_200;
  for (const [index, tokenAddress] of fairTokens.entries()) {
    candidates.findOrCreate({
      chain: 'bsc',
      tokenAddress,
      firstSeenAtMs: now.value + index,
      firstSeenPriceUsd: 0.001,
      firstSeenRank: index + 6,
      firstSeenMarketCapUsd: 80_000,
      firstSeenLiquidityUsd: 12_000,
      discoveryRuleVersion: config.ruleVersion
    });
    candidates.transition('bsc', tokenAddress, 'RADAR', { atMs: now.value });
    snapshots.insert({
      chain: 'bsc',
      interval: '1m',
      fetchedAtMs: now.value,
      tokenAddress,
      rank: index + 6,
      priceUsd: 0.001,
      marketCapUsd: 80_000,
      liquidityUsd: 12_000,
      raw: { name: `Fair Meme ${index + 1}`, symbol: `F${index + 1}` }
    });
    for (const [interval, offset] of [['1m', -3_000], ['5m', -2_000]] as const) {
      snapshots.insert({
        chain: 'bsc', interval, fetchedAtMs: now.value + offset,
        tokenAddress, rank: index + 6, priceUsd: 0.001,
        marketCapUsd: 80_000, liquidityUsd: 12_000,
        raw: { name: `Fair Meme ${index + 1}`, symbol: `F${index + 1}` }
      });
    }
    recordEvent(tokenAddress, 'activation', 'DUAL_RANK_BONDING_CURVE', now.value + index);
    recordEvent(tokenAddress, 'radar_public_readiness', 'BSC_RADAR_PUBLIC_READY', now.value + index);
  }
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value - 3_000,
    itemCount: fairTokens.length, discoveryRuleVersion: config.ruleVersion
  });
  fetches.insert({
    chain: 'bsc', interval: '5m', fetchedAtMs: now.value - 2_000,
    itemCount: fairTokens.length, discoveryRuleVersion: config.ruleVersion
  });
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value,
    itemCount: fairTokens.length, discoveryRuleVersion: config.ruleVersion
  });
  for (const tokenAddress of fairTokens) {
    await processRadar();
    assert.match(sends.at(-1)!, new RegExp(tokenAddress));
    now.value += 1_200;
  }
  assert.equal(sends.length, 2 + fairTokens.length);

  const solToken = 'So11111111111111111111111111111111111111112';
  candidates.findOrCreate({
    chain: 'sol', tokenAddress: solToken, firstSeenAtMs: now.value - 20_000,
    firstSeenPriceUsd: 0.001, firstSeenRank: 15,
    firstSeenMarketCapUsd: 80_000, firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.transition('sol', solToken, 'PREHEAT', { atMs: now.value });
  const solPayload = {
    text: 'legacy SOL pending radar',
    snapshot: {
      chain: 'sol', tokenAddress: solToken, firstSeenAtMs: now.value - 20_000,
      marketCapUsd: 80_000, sampledMaxGain: 0, stage: 'real_pool',
      presentation: {
        name: 'Legacy SOL', symbol: 'LSOL', marketCapUsd: 80_000,
        rank: 15, currentGain: 0, activationReason: 'DUAL_RANK'
      }
    }
  };
  new OutboxRepository(database).create({
    chain: 'sol', tokenAddress: solToken, messageKind: 'radar',
    channelRole: 'radar', payload: solPayload, createdAtMs: now.value
  });
  snapshots.insert({
    chain: 'sol', interval: '1m', fetchedAtMs: now.value,
    tokenAddress: solToken, rank: 15, priceUsd: 0.001,
    marketCapUsd: 80_000, liquidityUsd: 12_000,
    raw: { name: 'Legacy SOL', symbol: 'LSOL' }
  });
  fetches.insert({
    chain: 'sol', interval: '1m', fetchedAtMs: now.value,
    itemCount: 1, discoveryRuleVersion: config.ruleVersion
  });
  await processRadar();
  assert.equal(sends.length, 2 + fairTokens.length);

  const staleSolToken = '11111111111111111111111111111111';
  now.value += 1_200;
  candidates.findOrCreate({
    chain: 'sol', tokenAddress: staleSolToken, firstSeenAtMs: now.value - 20_000,
    firstSeenPriceUsd: 0.001, firstSeenRank: 15,
    firstSeenMarketCapUsd: 80_000, firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.transition('sol', staleSolToken, 'PREHEAT', { atMs: now.value });
  new OutboxRepository(database).create({
    chain: 'sol', tokenAddress: staleSolToken, messageKind: 'radar',
    channelRole: 'radar', createdAtMs: now.value,
    payload: {
      text: 'legacy omitted SOL pending radar',
      snapshot: {
        chain: 'sol', tokenAddress: staleSolToken,
        firstSeenAtMs: now.value - 20_000, marketCapUsd: 80_000,
        sampledMaxGain: 0, stage: 'real_pool',
        presentation: {
          name: 'Omitted SOL', symbol: 'OMIT', marketCapUsd: 80_000,
          rank: 15, currentGain: 0, activationReason: 'DUAL_RANK'
        }
      }
    }
  });
  await processRadar();
  assert.equal(sends.length, 2 + fairTokens.length);
  database.close();
});

test('SOL rollback sends bonding, direct new-pool and revival first cards', async () => {
  const now = { value: 20_000_000 };
  const bondingToken = 'So11111111111111111111111111111111111111112';
  const directToken = '11111111111111111111111111111111';
  const revivalToken = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const legacyToken = 'SysvarRent111111111111111111111111111111111';
  const database = openDatabase(':memory:');
  const config = parseConfig({
    NODE_ENV: 'test', GMGN_API_KEY: 'gmgn-test', COINGECKO_PRO_API_KEY: 'cg-test',
    TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'telegram-test',
    TELEGRAM_RADAR_CHAT_ID: '-1001', TELEGRAM_VALIDATION_CHAT_ID: '-1002',
    TELEGRAM_FORMAL_CHAT_ID: '-1003'
  });
  new RuleVersionRepository(database).save(config.ruleVersion, {
    thresholds: config.thresholds,
    discoveryPolicy: config.discoveryPolicy,
    sourcePolicy: config.sourcePolicy
  });
  const candidates = new CandidateRepository(database);
  const snapshots = new RankSnapshotRepository(database);
  const fetches = new RankSnapshotFetchRepository(database);
  const events = new QualificationEventRepository(database);
  const createCandidate = (tokenAddress: string, rank: number) =>
    candidates.findOrCreate({
      chain: 'sol', tokenAddress, firstSeenAtMs: now.value - 20_000,
      firstSeenPriceUsd: 0.001, firstSeenRank: rank,
      firstSeenMarketCapUsd: 80_000, firstSeenLiquidityUsd: 12_000,
      discoveryRuleVersion: config.ruleVersion
    });
  const record = (tokenAddress: string, reasonCode: string, stage = 'activation') =>
    events.record({
      chain: 'sol', tokenAddress, stage, outcome: stage === 'activation' ? 'WAIT' : 'PASS',
      reasonCode, source: 'gmgn', observedAtMs: now.value,
      raw: {}, normalized: {}, thresholds: {}, decisionRuleVersion: config.ruleVersion
    });
  const insertBatch = (
    interval: '1m' | '5m',
    fetchedAtMs: number,
    rows: readonly { token: string; rank: number; liquidity?: number }[]
  ) => {
    for (const row of rows) {
      snapshots.insert({
        chain: 'sol', interval, fetchedAtMs, tokenAddress: row.token,
        rank: row.rank, priceUsd: 0.001, marketCapUsd: 80_000,
        liquidityUsd: row.liquidity ?? 12_000,
        raw: { name: `SOL ${row.rank}`, symbol: `S${row.rank}` }
      });
    }
    fetches.insert({
      chain: 'sol', interval, fetchedAtMs, itemCount: rows.length,
      discoveryRuleVersion: config.ruleVersion
    });
  };

  createCandidate(bondingToken, 5);
  candidates.transition('sol', bondingToken, 'RADAR', { atMs: now.value });
  record(bondingToken, 'DUAL_RANK_BONDING_CURVE');
  record(bondingToken, 'SOL_RADAR_PUBLIC_READY', 'radar_public_readiness');
  insertBatch('1m', now.value - 3_000, [{ token: bondingToken, rank: 5 }]);
  insertBatch('5m', now.value - 2_000, [{ token: bondingToken, rank: 5 }]);
  insertBatch('1m', now.value, [{ token: bondingToken, rank: 5 }]);

  const sends: string[] = [];
  const edits: string[] = [];
  const telegram: TelegramTransportLike = {
    async sendMessage(_chatId, text) {
      sends.push(text);
      return { messageId: 'sol-radar' };
    },
    async editMessage(_chatId, _messageId, text) {
      edits.push(text);
    }
  };
  const runtime = new BotRuntime(database, config, {
    gmgn: {} as never, coinGecko: {} as never, telegram,
    now: () => now.value, log: () => undefined
  });
  const processRadar = async (
    items = candidates.listRadarCandidates()
  ) => {
    await (runtime as unknown as {
      processRadar(items: ReturnType<CandidateRepository['listRadarCandidates']>): Promise<void>;
    }).processRadar(items);
  };

  await processRadar();
  assert.equal(sends.length, 1);
  assert.equal(
    (new OutboxRepository(database).find('sol', bondingToken, 'radar')!
      .initialPayload!.payload.snapshot as { stage: string }).stage,
    'bonding'
  );

  candidates.activate({
    chain: 'sol', tokenAddress: bondingToken, opportunityType: 'new_pool',
    priceUsd: 0.001, ruleVersion: config.ruleVersion, atMs: now.value
  });
  events.record({
    chain: 'sol', tokenAddress: bondingToken, stage: 'activation', outcome: 'PASS',
    reasonCode: 'RADAR_OPENED_REAL_POOL', source: 'gmgn', observedAtMs: now.value,
    raw: {}, normalized: {}, thresholds: {}, decisionRuleVersion: config.ruleVersion
  });
  candidates.transition('sol', bondingToken, 'PREHEAT', { atMs: now.value });
  now.value += 3_000;
  insertBatch('1m', now.value, [{ token: bondingToken, rank: 15 }]);
  await processRadar();
  assert.equal(edits.length, 1);
  assert.match(edits[0]!, /真实池验证中/);

  for (const [tokenAddress, opportunityType] of [
    [directToken, 'new_pool'],
    [revivalToken, 'revival']
  ] as const) {
    now.value += 3_000;
    createCandidate(tokenAddress, 10);
    candidates.activate({
      chain: 'sol', tokenAddress, opportunityType,
      priceUsd: 0.001, ruleVersion: config.ruleVersion, atMs: now.value
    });
    events.record({
      chain: 'sol', tokenAddress, stage: 'activation', outcome: 'PASS',
      reasonCode: `DUAL_RANK_${opportunityType === 'new_pool' ? 'REAL_POOL' : 'REVIVAL_POOL'}`,
      source: 'gmgn', observedAtMs: now.value, raw: {}, normalized: {}, thresholds: {},
      decisionRuleVersion: config.ruleVersion
    });
    candidates.transition('sol', tokenAddress, 'PREHEAT', { atMs: now.value });
    insertBatch('1m', now.value, [
      { token: bondingToken, rank: 15 }, { token: tokenAddress, rank: 10 }
    ]);
    await processRadar();
  }
  assert.equal(sends.length, 3);
  assert.equal(edits.length, 1);
  assert.equal(new OutboxRepository(database).find('sol', directToken, 'radar')!.status, 'SENT');
  assert.equal(new OutboxRepository(database).find('sol', revivalToken, 'radar')!.status, 'SENT');
  for (const tokenAddress of [directToken, revivalToken]) {
    assert.equal(events.has({
      chain: 'sol', tokenAddress, stage: 'bonding_shortcut_readiness',
      reasonCode: 'BONDING_POOL_OPEN_SHORTCUT_READY'
    }), false);
  }

  now.value += 3_000;
  createCandidate(legacyToken, 12);
  candidates.activate({
    chain: 'sol', tokenAddress: legacyToken, opportunityType: 'new_pool',
    priceUsd: 0.001, ruleVersion: config.ruleVersion, atMs: now.value
  });
  events.record({
    chain: 'sol', tokenAddress: legacyToken, stage: 'activation', outcome: 'PASS',
    reasonCode: 'DUAL_RANK_REAL_POOL', source: 'gmgn', observedAtMs: now.value,
    raw: {}, normalized: {}, thresholds: {}, decisionRuleVersion: config.ruleVersion
  });
  candidates.transition('sol', legacyToken, 'PREHEAT', { atMs: now.value });
  const legacyPayload = {
    text: 'legacy SOL radar',
    snapshot: {
      chain: 'sol', tokenAddress: legacyToken, firstSeenAtMs: now.value - 20_000,
      marketCapUsd: 80_000, sampledMaxGain: 0, stage: 'real_pool',
      presentation: {
        name: 'Legacy SOL', symbol: 'LSOL', marketCapUsd: 80_000,
        rank: 12, currentGain: 0, activationReason: 'DUAL_RANK'
      }
    }
  };
  const legacyOutbox = new OutboxRepository(database).create({
    chain: 'sol', tokenAddress: legacyToken, messageKind: 'radar',
    channelRole: 'radar', payload: legacyPayload, createdAtMs: now.value
  });
  database.prepare(`
    UPDATE message_outbox
    SET status = 'SENT', receipt_at_ms = ?, telegram_message_id = 'legacy-sol'
    WHERE id = ?
  `).run(now.value, legacyOutbox.id);
  insertBatch('1m', now.value, [
    { token: bondingToken, rank: 15 }, { token: legacyToken, rank: 12 }
  ]);
  await processRadar();
  assert.equal(edits.length, 1);
  candidates.transition('sol', legacyToken, 'REJECTED', {
    atMs: now.value, terminalReason: 'TEST_REJECT'
  });
  now.value += 3_000;
  await processRadar();
  assert.equal(edits.length, 2);
  assert.match(edits[1]!, /已停止观察/);
  assert.equal(
    new OutboxRepository(database).find('sol', legacyToken, 'radar')!.initialPayload,
    null
  );

  now.value += 3_000;
  candidates.findOrCreate({
    chain: 'bsc', tokenAddress: TOKEN, firstSeenAtMs: now.value - 20_000,
    firstSeenPriceUsd: 0.001, firstSeenRank: 7,
    firstSeenMarketCapUsd: 80_000, firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.activate({
    chain: 'bsc', tokenAddress: TOKEN, opportunityType: 'new_pool',
    priceUsd: 0.001, ruleVersion: config.ruleVersion, atMs: now.value
  });
  events.record({
    chain: 'bsc', tokenAddress: TOKEN, stage: 'activation', outcome: 'PASS',
    reasonCode: 'DUAL_RANK_REAL_POOL', source: 'gmgn', observedAtMs: now.value,
    raw: {}, normalized: {}, thresholds: {}, decisionRuleVersion: config.ruleVersion
  });
  candidates.transition('bsc', TOKEN, 'PREHEAT', { atMs: now.value });
  const futureBscFetchAt = now.value + 1_000;
  snapshots.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: futureBscFetchAt, tokenAddress: TOKEN,
    rank: 7, priceUsd: 0.001, marketCapUsd: 80_000, liquidityUsd: 12_000,
    raw: { name: 'BSC Direct', symbol: 'BDIR' }
  });
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: futureBscFetchAt, itemCount: 1,
    discoveryRuleVersion: config.ruleVersion
  });
  await processRadar([candidates.find('bsc', TOKEN)!]);
  assert.equal(sends.length, 3);
  now.value += 3_000;
  await processRadar([candidates.find('bsc', TOKEN)!]);
  assert.equal(sends.length, 4);
  assert.match(sends[3]!, /BNB CHAIN/);
  assert.equal(events.has({
    chain: 'bsc', tokenAddress: TOKEN, stage: 'radar_public_readiness',
    reasonCode: 'BSC_RADAR_PUBLIC_READY', decisionRuleVersion: config.ruleVersion
  }), true);
  database.close();
});
