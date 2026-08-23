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

test.skip('runtime edits one radar through current-rank omission and lifecycle changes', async () => {
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
    recordEvent(tokenAddress, 'activation', 'DUAL_RANK_BONDING_CURVE', now.value + index);
    recordEvent(tokenAddress, 'radar_public_readiness', 'BSC_RADAR_PUBLIC_READY', now.value + index);
  }
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
  assert.equal(sends.length, 3 + fairTokens.length);
  assert.match(sends.at(-1)!, /SOLANA/);

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
  assert.equal(sends.length, 4 + fairTokens.length);
  assert.match(sends.at(-1)!, /热度暂时不足/);
  database.close();
});
