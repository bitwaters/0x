import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  CandidateRepository,
  OutboxRepository,
  QualificationEventRepository,
  RankSnapshotFetchRepository,
  RankSnapshotRepository,
  RuleVersionRepository
} from '../src/db/repositories.js';
import { CandidateDiscoveryEngine } from '../src/discovery/engine.js';
import { DISCOVERY_POLICY } from '../src/discovery/policy.js';
import { BotRuntime } from '../src/runtime/service.js';
import type { GmgnTrendingItem, GmgnTrendingSnapshot } from '../src/providers/gmgn.js';
import type { TelegramTransportLike } from '../src/telegram/transport.js';

const token = (index: number) => `0x${index.toString(16).padStart(40, '0')}`;
const TOP3 = token(3);
const TOP7 = token(7);
const TOP12_REVIVAL = token(12);
const TOP15_NEW = token(15);
const OUTSIDE = token(21);
const TERMINAL = token(22);

function item(tokenAddress: string, rank: number, openAtMs: number | null = null): GmgnTrendingItem {
  return {
    chain: 'bsc', tokenAddress, name: `Rollback ${rank}`, symbol: `R${rank}`,
    rank, priceUsd: 0.001, marketCapUsd: 80_000, liquidityUsd: 15_000,
    openAtMs, createdAtMs: null,
    raw: { name: `Rollback ${rank}`, symbol: `R${rank}` }
  };
}

function snapshot(
  interval: '1m' | '5m',
  fetchedAtMs: number,
  items: readonly GmgnTrendingItem[]
): GmgnTrendingSnapshot {
  return {
    chain: 'bsc', interval, fetchedAtMs,
    filters: ['not_honeypot', 'verified', 'renounced'], items
  };
}

test('compatible rollback restores only old BSC public projection on a copied v7 database', async () => {
  assert.deepEqual(DISCOVERY_POLICY.publicRadar.bsc, {
    bondingRank: { min: 1, max: 5 },
    realPoolRank: { min: 1, max: 20 },
    revivalPublic: true
  });

  const directory = mkdtempSync(join(tmpdir(), 'rollback-v7-'));
  const sourcePath = join(directory, 'source.db');
  const copyPath = join(directory, 'smoke-copy.db');
  const source = openDatabase(sourcePath);
  assert.ok(source.prepare('PRAGMA table_info(message_outbox)').all().some(
    (row) => (row as { name: string }).name === 'initial_payload_json'
  ));
  source.close();
  copyFileSync(sourcePath, copyPath);

  const database = openDatabase(copyPath);
  const now = { value: 10_000_000 };
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
  const events = new QualificationEventRepository(database);
  const ranks = new RankSnapshotRepository(database);
  const fetches = new RankSnapshotFetchRepository(database);
  const outbox = new OutboxRepository(database);
  const discovery = new CandidateDiscoveryEngine(
    database,
    config,
    async (_chain, tokenAddress) => ({
      chain: 'bsc', tokenAddress, biggestPoolAddress: null,
      priceUsd: 0.001, liquidityUsd: 0, openAtMs: null,
      poolCreatedAtMs: null, fetchedAtMs: now.value, raw: {}
    }),
    () => now.value
  );

  await discovery.acceptSnapshot(snapshot('1m', now.value, [item(TOP3, 3)]));
  now.value += 1;
  await discovery.acceptSnapshot(snapshot('5m', now.value, [item(TOP3, 3)]));
  now.value += 10_000;
  await discovery.acceptSnapshot(snapshot('1m', now.value, [item(TOP3, 3)]));
  assert.equal(candidates.find('bsc', TOP3)!.status, 'RADAR');
  assert.equal(events.has({
    chain: 'bsc', tokenAddress: TOP3, stage: 'radar_public_readiness',
    reasonCode: 'BSC_RADAR_PUBLIC_READY', decisionRuleVersion: config.ruleVersion
  }), true);

  const sends: string[] = [];
  const telegram: TelegramTransportLike = {
    async sendMessage(_chatId, text) {
      sends.push(text);
      return { messageId: String(500 + sends.length) };
    },
    async editMessage() {}
  };
  const runtime = new BotRuntime(database, config, {
    gmgn: {} as never, coinGecko: {} as never, telegram,
    now: () => now.value, log: () => undefined
  });
  const processRadar = () => (runtime as unknown as {
    processRadar(items: ReturnType<CandidateRepository['listRadarCandidates']>): Promise<void>;
  }).processRadar(candidates.listRadarCandidates());
  await processRadar();
  assert.equal(sends.length, 1);
  assert.ok(outbox.find('bsc', TOP3, 'radar')!.initialPayload);

  const createReal = (
    tokenAddress: string,
    rank: number,
    opportunityType: 'new_pool' | 'revival',
    terminal = false
  ) => {
    candidates.findOrCreate({
      chain: 'bsc', tokenAddress, firstSeenAtMs: now.value + rank,
      firstSeenPriceUsd: 0.001, firstSeenRank: rank,
      firstSeenMarketCapUsd: 80_000, firstSeenLiquidityUsd: 15_000,
      discoveryRuleVersion: config.ruleVersion
    });
    candidates.activate({
      chain: 'bsc', tokenAddress, opportunityType,
      priceUsd: 0.001, ruleVersion: config.ruleVersion, atMs: now.value
    });
    candidates.transition('bsc', tokenAddress, 'PREHEAT', { atMs: now.value });
    events.record({
      chain: 'bsc', tokenAddress, stage: 'activation', outcome: 'PASS',
      reasonCode: `DUAL_RANK_${opportunityType === 'new_pool' ? 'REAL_POOL' : 'REVIVAL_POOL'}`,
      source: 'gmgn', observedAtMs: now.value, raw: {}, normalized: {}, thresholds: {},
      decisionRuleVersion: config.ruleVersion
    });
    outbox.create({
      chain: 'bsc', tokenAddress, messageKind: 'radar', channelRole: 'radar',
      payload: {
        text: 'legacy pending',
        snapshot: {
          chain: 'bsc', tokenAddress, firstSeenAtMs: now.value + rank,
          marketCapUsd: 80_000, sampledMaxGain: 0, stage: 'real_pool',
          presentation: {
            name: `Rollback ${rank}`, symbol: `R${rank}`, marketCapUsd: 80_000,
            rank, currentGain: 0, activationReason: 'DUAL_RANK'
          }
        }
      },
      createdAtMs: now.value
    });
    if (terminal) {
      candidates.transition('bsc', tokenAddress, 'REJECTED', {
        atMs: now.value, terminalReason: 'SMOKE_TERMINAL'
      });
    }
  };
  now.value += 1_200;
  createReal(TOP15_NEW, 15, 'new_pool');
  createReal(TOP12_REVIVAL, 12, 'revival');
  createReal(OUTSIDE, 21, 'new_pool');
  createReal(TERMINAL, 14, 'new_pool', true);
  for (const ranked of [
    [TOP15_NEW, 15], [TOP12_REVIVAL, 12], [OUTSIDE, 21], [TERMINAL, 14]
  ] as const) {
    ranks.insert({
      chain: 'bsc', interval: '1m', fetchedAtMs: now.value,
      tokenAddress: ranked[0], rank: ranked[1], priceUsd: 0.001,
      marketCapUsd: 80_000, liquidityUsd: 15_000,
      raw: { name: `Rollback ${ranked[1]}`, symbol: `R${ranked[1]}` }
    });
  }
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: now.value,
    itemCount: 4, discoveryRuleVersion: config.ruleVersion
  });

  now.value += 1_200;
  await processRadar();
  now.value += 1_200;
  await processRadar();
  assert.equal(sends.length, 3);
  for (const tokenAddress of [TOP15_NEW, TOP12_REVIVAL]) {
    assert.equal(events.has({
      chain: 'bsc', tokenAddress, stage: 'radar_public_readiness',
      reasonCode: 'BSC_RADAR_PUBLIC_READY', decisionRuleVersion: config.ruleVersion
    }), true);
    assert.equal(outbox.find('bsc', tokenAddress, 'radar')!.status, 'SENT');
    assert.ok(outbox.find('bsc', tokenAddress, 'radar')!.initialPayload);
  }
  for (const tokenAddress of [OUTSIDE, TERMINAL]) {
    assert.equal(events.has({
      chain: 'bsc', tokenAddress, stage: 'radar_public_readiness',
      reasonCode: 'BSC_RADAR_PUBLIC_READY', decisionRuleVersion: config.ruleVersion
    }), false);
    assert.equal(outbox.find('bsc', tokenAddress, 'radar')!.status, 'PENDING');
  }

  candidates.findOrCreate({
    chain: 'bsc', tokenAddress: TOP7, firstSeenAtMs: now.value,
    firstSeenPriceUsd: 0.001, firstSeenRank: 7,
    firstSeenMarketCapUsd: 80_000, firstSeenLiquidityUsd: 15_000,
    discoveryRuleVersion: config.ruleVersion
  });
  candidates.transition('bsc', TOP7, 'RADAR', { atMs: now.value });
  events.recordOnce({
    chain: 'bsc', tokenAddress: TOP7, stage: 'radar_public_readiness', outcome: 'PASS',
    reasonCode: 'BSC_RADAR_PUBLIC_READY', source: 'gmgn', observedAtMs: now.value,
    raw: {}, normalized: { rank: 7 }, thresholds: {},
    decisionRuleVersion: config.ruleVersion
  });
  now.value += 10_000;
  await discovery.acceptSnapshot(
    snapshot('1m', now.value, [item(TOP7, 7, now.value - 60_000)])
  );
  assert.equal(candidates.find('bsc', TOP7)!.status, 'RADAR');
  assert.equal(events.has({
    chain: 'bsc', tokenAddress: TOP7, stage: 'bonding_shortcut_readiness',
    reasonCode: 'BONDING_POOL_OPEN_SHORTCUT_READY'
  }), false);
  database.close();
});
