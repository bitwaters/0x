import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  CandidateRepository,
  PoolBindingRepository,
  RankSnapshotFetchRepository,
  RankSnapshotRepository,
  RuleVersionRepository
} from '../src/db/repositories.js';
import { BotRuntime } from '../src/runtime/service.js';
import type { TelegramTransportLike } from '../src/telegram/transport.js';

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
    firstSeenRank: 5,
    firstSeenMarketCapUsd: 80_000,
    firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.transition('bsc', TOKEN, 'RADAR', { atMs: now.value });
  const snapshots = new RankSnapshotRepository(database);
  const fetches = new RankSnapshotFetchRepository(database);
  const insertCurrent = (fetchedAtMs: number) => {
    snapshots.insert({
      chain: 'bsc',
      interval: '1m',
      fetchedAtMs,
      tokenAddress: TOKEN,
      rank: 5,
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

  const sends: string[] = [];
  const edits: string[] = [];
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
  await processRadar();
  assert.match(edits[0]!, /热度暂时不足/);

  now.value += 3_000;
  insertCurrent(now.value);
  candidates.activate({
    chain: 'bsc', tokenAddress: TOKEN, opportunityType: 'new_pool',
    priceUsd: 0.001, ruleVersion: config.ruleVersion, atMs: now.value
  });
  candidates.transition('bsc', TOKEN, 'PREHEAT', { atMs: now.value });
  await processRadar();
  assert.match(edits[1]!, /真实池验证中/);

  new PoolBindingRepository(database).bind({
    chain: 'bsc', tokenAddress: TOKEN, poolAddress: POOL,
    candidateSide: 'base', counterTokenAddress: COUNTER, boundAtMs: now.value
  });
  candidates.transition('bsc', TOKEN, 'MONITORING', { atMs: now.value });
  candidates.transition('bsc', TOKEN, 'SIGNAL_SENT', { atMs: now.value });
  now.value += 3_000;
  await processRadar();
  assert.match(edits[2]!, /已通过正式资格/);
  assert.equal(sends.length, 1);
  assert.equal(edits.length, 3);
  database.close();
});
