import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { normalizeAddress } from '../src/domain/address.js';
import { openDatabase } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import {
  CandidateRepository,
  OutboxRepository,
  PoolBindingRepository,
  QualificationEventRepository,
  RankSnapshotFetchRepository,
  RankSnapshotRepository,
  RuleVersionRepository
} from '../src/db/repositories.js';

const BSC_TOKEN = '0xAbCdEf0000000000000000000000000000000001';
const BSC_POOL = '0xAbCdEf0000000000000000000000000000000002';
const BSC_COUNTER = '0xAbCdEf0000000000000000000000000000000003';
const SOL_TOKEN = 'So11111111111111111111111111111111111111112';

function radarPayload(stage = 'bonding') {
  return {
    text: 'radar fixture',
    snapshot: {
      chain: 'bsc', tokenAddress: BSC_TOKEN.toLowerCase(),
      firstSeenAtMs: 100, marketCapUsd: 30_000, sampledMaxGain: 0.2,
      stage,
      presentation: {
        name: 'Fixture', symbol: 'FIX', marketCapUsd: 30_000,
        rank: 7, currentGain: 0.1, activationReason: 'DUAL_RANK'
      }
    }
  };
}

function seedBscCandidate(database = openDatabase(':memory:')) {
  const rules = new RuleVersionRepository(database);
  rules.save('rules-a', { threshold: 1 }, 1);
  const candidates = new CandidateRepository(database);
  const candidate = candidates.findOrCreate({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    firstSeenAtMs: 100,
    firstSeenPriceUsd: 0.001,
    firstSeenRank: 7,
    firstSeenMarketCapUsd: 30_000,
    firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: 'rules-a'
  }).candidate;
  return { database, rules, candidates, candidate };
}

function openVersionDatabase(path: string, maximumVersion: number): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
  const insert = database.prepare(
    'INSERT INTO _migrations(version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)'
  );
  for (const migration of MIGRATIONS.filter((item) => item.version <= maximumVersion)) {
    database.exec(migration.sql);
    insert.run(
      migration.version,
      migration.name,
      createHash('sha256').update(migration.sql).digest('hex'),
      migration.version
    );
  }
  return database;
}

function openV6Database(path: string): DatabaseSync {
  return openVersionDatabase(path, 6);
}

test('creates all migrations and enables WAL for file databases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-db-'));
  const database = openDatabase(join(directory, 'state.db'));
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);

  assert.equal(database.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  assert.equal(database.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  for (const table of [
    'rule_versions',
    'candidates',
    'rank_snapshots',
    'rank_snapshot_fetches',
    'pool_bindings',
    'qualification_events',
    'message_outbox',
    'evaluation_points'
  ]) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
  const fetchColumns = database
    .prepare('PRAGMA table_info(rank_snapshot_fetches)')
    .all()
    .map((row) => (row as { name: string }).name);
  assert.equal(fetchColumns.includes('items_json'), false);
  database.close();
});

test('normalizes BSC addresses and validates decoded SOL address length', () => {
  assert.equal(
    normalizeAddress('bsc', BSC_TOKEN),
    '0xabcdef0000000000000000000000000000000001'
  );
  assert.equal(normalizeAddress('sol', SOL_TOKEN), SOL_TOKEN);
  assert.throws(() => normalizeAddress('bsc', '0x1234'), /20-byte/);
  assert.throws(() => normalizeAddress('sol', '0OIl'), /non-base58/);
  assert.throws(() => normalizeAddress('sol', '1111'), /exactly 32 bytes/);
});

test('persistent trigger evidence fails closed on missing or out-of-range batches', () => {
  const database = openDatabase(':memory:');
  new RuleVersionRepository(database).save('rules-evidence', {}, 1);
  const snapshots = new RankSnapshotRepository(database);
  const fetches = new RankSnapshotFetchRepository(database);
  const insert = (
    interval: '1m' | '5m',
    fetchedAtMs: number,
    rank: number,
    marketCapUsd = 80_000
  ) => {
    snapshots.insert({
      chain: 'sol', interval, fetchedAtMs, tokenAddress: SOL_TOKEN,
      rank, priceUsd: 0.001, marketCapUsd, liquidityUsd: 12_000, raw: {}
    });
    fetches.insert({
      chain: 'sol', interval, fetchedAtMs, itemCount: 1,
      discoveryRuleVersion: 'rules-evidence'
    });
  };

  insert('1m', 1_000, 5);
  insert('5m', 2_000, 5);
  insert('1m', 4_000, 4);
  assert.equal(
    snapshots.hasCurrentTriggerEvidence('sol', SOL_TOKEN, ['DUAL_RANK'], 4_000),
    true
  );

  fetches.insert({
    chain: 'sol', interval: '5m', fetchedAtMs: 4_500, itemCount: 0,
    discoveryRuleVersion: 'rules-evidence'
  });
  assert.equal(
    snapshots.hasCurrentTriggerEvidence('sol', SOL_TOKEN, ['DUAL_RANK'], 5_000),
    false
  );

  insert('5m', 11_000, 4, 300_001);
  insert('1m', 12_000, 4);
  insert('1m', 15_000, 3);
  assert.equal(
    snapshots.hasCurrentTriggerEvidence('sol', SOL_TOKEN, ['DUAL_RANK'], 15_000),
    false
  );

  insert('1m', 50_000, 5);
  insert('5m', 53_000, 5);
  insert('5m', 60_000, 4);
  insert('1m', 61_000, 4);
  assert.equal(
    snapshots.hasCurrentTriggerEvidence('sol', SOL_TOKEN, ['DUAL_RANK'], 61_000),
    true
  );

  insert('1m', 70_000, 5);
  insert('1m', 73_000, 4);
  insert('5m', 73_000, 4);
  assert.equal(
    snapshots.hasCurrentTriggerEvidence('sol', SOL_TOKEN, ['DUAL_RANK'], 73_000),
    false
  );

  insert('1m', 80_000, 9);
  insert('1m', 83_000, 7);
  insert('1m', 86_000, 5);
  assert.equal(
    snapshots.hasCurrentTriggerEvidence('sol', SOL_TOKEN, ['THREE_RISING_1M'], 86_000),
    true
  );
  assert.equal(
    snapshots.hasCurrentTriggerEvidence('sol', SOL_TOKEN, ['THREE_RISING_1M'], 85_000),
    false
  );
  fetches.insert({
    chain: 'sol', interval: '1m', fetchedAtMs: 89_000, itemCount: 0,
    discoveryRuleVersion: 'rules-evidence'
  });
  assert.equal(
    snapshots.hasCurrentTriggerEvidence('sol', SOL_TOKEN, ['THREE_RISING_1M'], 89_000),
    false
  );
  database.close();
});

test('keeps first-seen values immutable and permanently rejects chase-limit candidates', () => {
  const { database, candidates, candidate } = seedBscCandidate();
  const duplicate = candidates.findOrCreate({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN.toLowerCase(),
    firstSeenAtMs: 999,
    firstSeenPriceUsd: 9,
    firstSeenRank: 1,
    firstSeenMarketCapUsd: 99_999,
    firstSeenLiquidityUsd: null,
    discoveryRuleVersion: 'rules-a'
  });

  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.candidate, candidate);
  candidates.activate({
    chain: 'bsc', tokenAddress: BSC_TOKEN, opportunityType: 'new_pool',
    priceUsd: 0.001, ruleVersion: 'rules-a', atMs: 150
  });
  const rejected = candidates.updateHighWater({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    observedPriceUsd: 0.00181,
    maxGainRatio: 0.8,
    decisionRuleVersion: 'rules-a',
    observedAtMs: 200,
    raw: { price: '0.00181' }
  });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.terminalReason, 'CHASE_LIMIT_EXCEEDED');
  assert.ok(rejected.sampledMaxGain > 0.8);
  const pulledBack = candidates.updateHighWater({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    observedPriceUsd: 0.0011,
    maxGainRatio: 0.8,
    decisionRuleVersion: 'rules-a',
    observedAtMs: 300,
    raw: { price: '0.0011' }
  });
  assert.equal(pulledBack.status, 'REJECTED');
  assert.equal(pulledBack.highPriceUsd, 0.00181);
  assert.throws(() => candidates.transition('bsc', BSC_TOKEN, 'MONITORING'), /invalid/);
  assert.throws(
    () => candidates.setDecisionRuleVersion('bsc', BSC_TOKEN, 'rules-a'),
    /cannot be requalified/
  );
  const rejectionEvidence = database
    .prepare("SELECT * FROM qualification_events WHERE reason_code = 'CHASE_LIMIT_EXCEEDED'")
    .all();
  assert.equal(rejectionEvidence.length, 1);
  database.close();
});

test('rolls back high-water rejection when its evidence cannot be persisted', () => {
  const { database, candidates } = seedBscCandidate();
  candidates.activate({
    chain: 'bsc', tokenAddress: BSC_TOKEN, opportunityType: 'new_pool',
    priceUsd: 0.001, ruleVersion: 'rules-a', atMs: 150
  });
  assert.throws(
    () =>
      candidates.updateHighWater({
        chain: 'bsc',
        tokenAddress: BSC_TOKEN,
        observedPriceUsd: 0.00181,
        maxGainRatio: 0.8,
        decisionRuleVersion: 'rules-a',
        observedAtMs: 200,
        raw: 1n
      }),
    /BigInt/
  );
  const candidate = candidates.find('bsc', BSC_TOKEN)!;
  assert.equal(candidate.status, 'DISCOVERED');
  assert.equal(candidate.highPriceUsd, 0.001);
  assert.equal(
    database.prepare('SELECT count(*) AS count FROM qualification_events').get()!.count,
    0
  );
  database.close();
});

test('persists stable rule versions, snapshots, immutable pool binding and evidence', () => {
  const { database, rules, candidates } = seedBscCandidate();
  rules.save('rules-stable', { beta: 2, alpha: 1 }, 2);
  assert.doesNotThrow(() => rules.save('rules-stable', { alpha: 1, beta: 2 }, 3));
  assert.throws(() => rules.save('rules-stable', { alpha: 2, beta: 2 }), /different config/);

  new RankSnapshotRepository(database).insert({
    chain: 'bsc',
    interval: '1m',
    fetchedAtMs: 150,
    tokenAddress: BSC_TOKEN,
    rank: 4,
    priceUsd: 0.0012,
    marketCapUsd: 36_000,
    liquidityUsd: 13_000,
    raw: { z: 2, a: 1 }
  });
  const fetches = new RankSnapshotFetchRepository(database);
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: 150,
    itemCount: 1, discoveryRuleVersion: 'rules-a'
  });
  fetches.insert({
    chain: 'bsc', interval: '1m', fetchedAtMs: 160,
    itemCount: 0, discoveryRuleVersion: 'rules-a'
  });
  const rankSnapshots = new RankSnapshotRepository(database);
  assert.equal(rankSnapshots.findLatestSuccessfulFetchAt('bsc', '1m'), 160);
  assert.notEqual(
    rankSnapshots.findLatest('bsc', BSC_TOKEN)!.fetchedAtMs,
    rankSnapshots.findLatestSuccessfulFetchAt('bsc', '1m')
  );
  assert.throws(
    () =>
      new RankSnapshotRepository(database).insert({
        chain: 'bsc',
        interval: '1m',
        fetchedAtMs: 151,
        tokenAddress: BSC_TOKEN,
        rank: 0,
        priceUsd: 0.0012,
        marketCapUsd: 36_000,
        liquidityUsd: 13_000,
        raw: {}
      }),
    /CHECK constraint/
  );
  const pools = new PoolBindingRepository(database);
  candidates.transition('bsc', BSC_TOKEN, 'PREHEAT', { atMs: 155 });
  pools.bind({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    poolAddress: BSC_POOL,
    candidateSide: 'base',
    counterTokenAddress: BSC_COUNTER,
    boundAtMs: 160
  });
  assert.doesNotThrow(() =>
    pools.bind({
      chain: 'bsc',
      tokenAddress: BSC_TOKEN,
      poolAddress: BSC_POOL.toLowerCase(),
      candidateSide: 'base',
      counterTokenAddress: BSC_COUNTER
    })
  );
  assert.throws(
    () =>
      pools.bind({
        chain: 'bsc',
        tokenAddress: BSC_TOKEN,
        poolAddress: BSC_COUNTER,
        candidateSide: 'base',
        counterTokenAddress: BSC_POOL
      }),
    /immutable/
  );

  candidates.setDecisionRuleVersion('bsc', BSC_TOKEN, 'rules-stable', 170);
  const eventId = new QualificationEventRepository(database).record({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    stage: 'security',
    outcome: 'PASS',
    reasonCode: 'WITHIN_LIMITS',
    source: 'gmgn',
    observedAtMs: 180,
    raw: { top10: '0.2' },
    normalized: { top10Ratio: 0.2 },
    thresholds: { top10MaxRatio: 0.25 },
    decisionRuleVersion: 'rules-stable'
  });
  const event = database
    .prepare('SELECT * FROM qualification_events WHERE id = ?')
    .get(eventId) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(event.raw_json as string), { top10: '0.2' });
  assert.deepEqual(JSON.parse(event.normalized_json as string), { top10Ratio: 0.2 });
  assert.deepEqual(JSON.parse(event.thresholds_json as string), {
    top10MaxRatio: 0.25
  });
  database.close();
});

test('pool binding and qualification start roll back unless candidate is PREHEAT', () => {
  const { database, candidates } = seedBscCandidate();
  assert.throws(
    () =>
      new PoolBindingRepository(database).bind({
        chain: 'bsc',
        tokenAddress: BSC_TOKEN,
        poolAddress: BSC_POOL,
        candidateSide: 'base',
        counterTokenAddress: BSC_COUNTER,
        boundAtMs: 500
      }),
    /must be PREHEAT/
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM pool_bindings').get()!.count, 0);
  assert.equal(candidates.find('bsc', BSC_TOKEN)!.qualificationStartedAtMs, null);
  database.close();
});

test('rejects an applied migration whose stored checksum no longer matches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-migration-'));
  const path = join(directory, 'state.db');
  const database = openDatabase(path);
  database.prepare("UPDATE _migrations SET checksum = 'corrupt' WHERE version = 1").run();
  database.close();

  assert.throws(() => openDatabase(path), /definition does not match database/);
});

test('upgrades legacy migration metadata without changing application data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-legacy-'));
  const path = join(directory, 'state.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
  const insertMigration = legacy.prepare(
    'INSERT INTO _migrations(version, name, applied_at_ms) VALUES (?, ?, ?)'
  );
  for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
    legacy.exec(migration.sql);
    insertMigration.run(migration.version, migration.name, migration.version);
  }
  new RuleVersionRepository(legacy).save('rules-a', { threshold: 1 }, 1);
  new CandidateRepository(legacy).findOrCreate({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    firstSeenAtMs: 100,
    firstSeenPriceUsd: 0.001,
    firstSeenRank: 7,
    firstSeenMarketCapUsd: 30_000,
    firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: 'rules-a'
  });
  legacy.close();

  const upgraded = openDatabase(path);
  const columns = upgraded
    .prepare('PRAGMA table_info(_migrations)')
    .all()
    .map((row) => (row as { name: string }).name);
  assert.ok(columns.includes('checksum'));
  assert.match(
    upgraded.prepare('SELECT checksum FROM _migrations WHERE version = 1').get()!
      .checksum as string,
    /^[a-f0-9]{64}$/
  );
  assert.equal(new CandidateRepository(upgraded).find('bsc', BSC_TOKEN)!.firstSeenAtMs, 100);
  upgraded.close();
});

test('upgrades an applied v2 rank-fetch table without losing state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-v2-upgrade-'));
  const path = join(directory, 'state.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
  const insertMigration = legacy.prepare(
    'INSERT INTO _migrations(version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)'
  );
  for (const migration of MIGRATIONS.filter((item) => item.version <= 2)) {
    legacy.exec(migration.sql);
    insertMigration.run(
      migration.version,
      migration.name,
      createHash('sha256').update(migration.sql).digest('hex'),
      migration.version
    );
  }
  new RuleVersionRepository(legacy).save('rules-v2', { version: 2 }, 1);
  new CandidateRepository(legacy).findOrCreate({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    firstSeenAtMs: 100,
    firstSeenPriceUsd: 0.001,
    firstSeenRank: 3,
    firstSeenMarketCapUsd: 30_000,
    firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: 'rules-v2'
  });
  legacy
    .prepare(`
      INSERT INTO rank_snapshot_fetches(
        chain, interval, fetched_at_ms, item_count, items_json, discovery_rule_version
      ) VALUES ('bsc', '1m', 100, 1, '[]', 'rules-v2')
    `)
    .run();
  legacy.close();

  const upgraded = openDatabase(path);
  const columns = upgraded
    .prepare('PRAGMA table_info(rank_snapshot_fetches)')
    .all()
    .map((row) => (row as { name: string }).name);
  assert.equal(columns.includes('items_json'), false);
  assert.equal(
    upgraded.prepare('SELECT item_count FROM rank_snapshot_fetches').get()!.item_count,
    1
  );
  assert.equal(new CandidateRepository(upgraded).find('bsc', BSC_TOKEN)!.firstSeenAtMs, 100);
  upgraded.close();
  assert.doesNotThrow(() => openDatabase(path).close());
});

test('v7 upgrades a v6 file atomically and bridges only pre-upgrade BSC bonding radar facts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-v7-'));
  const path = join(directory, 'state.db');
  const v6 = openV6Database(path);
  new RuleVersionRepository(v6).save('rules-old', { version: 'old' }, 1);
  const candidates = new CandidateRepository(v6);
  candidates.findOrCreate({
    chain: 'bsc', tokenAddress: BSC_TOKEN, firstSeenAtMs: 100,
    firstSeenPriceUsd: 0.001, firstSeenRank: 3,
    firstSeenMarketCapUsd: 30_000, firstSeenLiquidityUsd: 0,
    discoveryRuleVersion: 'rules-old'
  });
  candidates.transition('bsc', BSC_TOKEN, 'RADAR', { atMs: 120 });
  const events = new QualificationEventRepository(v6);
  events.record({
    chain: 'bsc', tokenAddress: BSC_TOKEN, stage: 'activation', outcome: 'WAIT',
    reasonCode: 'THREE_RISING_1M_BONDING_CURVE', source: 'gmgn', observedAtMs: 130,
    raw: { source: 'earliest' }, normalized: { rank: 3 }, thresholds: { rankMax: 5 },
    decisionRuleVersion: 'rules-old'
  });
  events.record({
    chain: 'bsc', tokenAddress: BSC_TOKEN, stage: 'activation', outcome: 'WAIT',
    reasonCode: 'DUAL_RANK_BONDING_CURVE', source: 'gmgn', observedAtMs: 140,
    raw: { source: 'later' }, normalized: { rank: 3 }, thresholds: { rankMax: 5 },
    decisionRuleVersion: 'rules-old'
  });
  v6.prepare(`
    INSERT INTO message_outbox(
      chain, token_address, message_kind, channel_role, status, payload_json,
      receipt_at_ms, telegram_message_id, created_at_ms, updated_at_ms
    ) VALUES ('bsc', ?, 'radar', 'radar', 'SENT', '{}', 150, 'old-message', 145, 150)
  `).run(BSC_TOKEN.toLowerCase());
  v6.close();

  const upgraded = openDatabase(path);
  const shortcut = upgraded.prepare(`
    SELECT source, observed_at_ms, raw_json, normalized_json, thresholds_json,
           decision_rule_version
    FROM qualification_events
    WHERE stage = 'bonding_shortcut_readiness'
  `).get() as Record<string, unknown>;
  assert.deepEqual({ ...shortcut }, {
    source: 'gmgn', observed_at_ms: 130,
    raw_json: '{"source":"earliest"}', normalized_json: '{"rank":3}',
    thresholds_json: '{"rankMax":5}', decision_rule_version: 'rules-old'
  });
  assert.equal(
    upgraded.prepare('SELECT initial_payload_json FROM message_outbox').get()!
      .initial_payload_json,
    null
  );
  assert.equal(upgraded.prepare('SELECT count(*) AS count FROM _migrations WHERE version = 7').get()!.count, 1);

  const top7 = '0x0000000000000000000000000000000000000007';
  new RuleVersionRepository(upgraded).save('rules-new', { version: 'new' }, 200);
  const upgradedCandidates = new CandidateRepository(upgraded);
  upgradedCandidates.findOrCreate({
    chain: 'bsc', tokenAddress: top7, firstSeenAtMs: 200,
    firstSeenPriceUsd: 0.001, firstSeenRank: 7,
    firstSeenMarketCapUsd: 30_000, firstSeenLiquidityUsd: 0,
    discoveryRuleVersion: 'rules-new'
  });
  upgradedCandidates.transition('bsc', top7, 'RADAR', { atMs: 210 });
  new QualificationEventRepository(upgraded).record({
    chain: 'bsc', tokenAddress: top7, stage: 'activation', outcome: 'WAIT',
    reasonCode: 'DUAL_RANK_BONDING_CURVE', source: 'gmgn', observedAtMs: 220,
    raw: {}, normalized: { rank: 7 }, thresholds: {}, decisionRuleVersion: 'rules-new'
  });
  assert.equal(
    upgraded.prepare(`
      SELECT count(*) AS count FROM qualification_events
      WHERE token_address = ? AND stage = 'bonding_shortcut_readiness'
    `).get(top7)!.count,
    0
  );
  upgraded.close();

  const failedPath = join(directory, 'failed.db');
  const failedV6 = openV6Database(failedPath);
  new RuleVersionRepository(failedV6).save('rules-old', {}, 1);
  const failedCandidates = new CandidateRepository(failedV6);
  failedCandidates.findOrCreate({
    chain: 'bsc', tokenAddress: BSC_TOKEN, firstSeenAtMs: 100,
    firstSeenPriceUsd: 0.001, firstSeenRank: 3,
    firstSeenMarketCapUsd: 30_000, firstSeenLiquidityUsd: 0,
    discoveryRuleVersion: 'rules-old'
  });
  failedCandidates.transition('bsc', BSC_TOKEN, 'RADAR', { atMs: 120 });
  new QualificationEventRepository(failedV6).record({
    chain: 'bsc', tokenAddress: BSC_TOKEN, stage: 'activation', outcome: 'WAIT',
    reasonCode: 'DUAL_RANK_BONDING_CURVE', source: 'gmgn', observedAtMs: 130,
    raw: {}, normalized: {}, thresholds: {}, decisionRuleVersion: 'rules-old'
  });
  failedV6.exec(`
    CREATE TRIGGER fail_v7_bridge BEFORE INSERT ON qualification_events
    WHEN NEW.stage = 'bonding_shortcut_readiness'
    BEGIN SELECT RAISE(ABORT, 'fixture migration failure'); END;
  `);
  failedV6.close();
  assert.throws(() => openDatabase(failedPath), /fixture migration failure/);
  const failed = new DatabaseSync(failedPath);
  assert.equal(
    failed.prepare('PRAGMA table_info(message_outbox)').all()
      .some((row) => (row as { name: string }).name === 'initial_payload_json'),
    false
  );
  assert.equal(failed.prepare('SELECT count(*) AS count FROM _migrations WHERE version = 7').get()!.count, 0);
  failed.close();
});

test('v8 atomically bridges only current unactivated SOL bonding radar facts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-v8-'));
  const path = join(directory, 'state.db');
  const v7 = openVersionDatabase(path, 7);
  new RuleVersionRepository(v7).save('rules-old', {}, 1);
  const candidates = new CandidateRepository(v7);
  const events = new QualificationEventRepository(v7);
  const activatedToken = '11111111111111111111111111111111';
  const resetToken = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  for (const tokenAddress of [SOL_TOKEN, activatedToken, resetToken]) {
    candidates.findOrCreate({
      chain: 'sol', tokenAddress, firstSeenAtMs: 100,
      firstSeenPriceUsd: 0.001, firstSeenRank: 5,
      firstSeenMarketCapUsd: 30_000, firstSeenLiquidityUsd: 0,
      discoveryRuleVersion: 'rules-old'
    });
    candidates.transition('sol', tokenAddress, 'RADAR', { atMs: 120 });
    events.record({
      chain: 'sol', tokenAddress, stage: 'activation', outcome: 'WAIT',
      reasonCode: 'DUAL_RANK_BONDING_CURVE', source: 'gmgn', observedAtMs: 130,
      raw: { tokenAddress }, normalized: {}, thresholds: {},
      decisionRuleVersion: 'rules-old'
    });
  }
  candidates.activate({
    chain: 'sol', tokenAddress: activatedToken, opportunityType: 'new_pool',
    priceUsd: 0.001, ruleVersion: 'rules-old', atMs: 140
  });
  candidates.transition('sol', activatedToken, 'PREHEAT', { atMs: 140 });
  const pools = new PoolBindingRepository(v7);
  pools.bind({
    chain: 'sol', tokenAddress: activatedToken, poolAddress: SOL_TOKEN,
    candidateSide: 'base', counterTokenAddress: resetToken, boundAtMs: 150
  });
  pools.setQualificationReference({
    chain: 'sol', tokenAddress: activatedToken, priceUsd: 0.001, atMs: 160
  });
  v7.prepare(`
    UPDATE candidates SET legacy_reopened_at_ms = 200
    WHERE chain = 'sol' AND token_address = ?
  `).run(resetToken);
  events.record({
    chain: 'sol', tokenAddress: resetToken, stage: 'bonding_shortcut_readiness',
    outcome: 'PASS', reasonCode: 'BONDING_POOL_OPEN_SHORTCUT_READY', source: 'gmgn',
    observedAtMs: 130, raw: { source: 'before-reset' }, normalized: {}, thresholds: {},
    decisionRuleVersion: 'rules-old'
  });
  events.record({
    chain: 'sol', tokenAddress: resetToken, stage: 'activation', outcome: 'WAIT',
    reasonCode: 'THREE_RISING_1M_BONDING_CURVE', source: 'gmgn', observedAtMs: 230,
    raw: { source: 'after-reset' }, normalized: {}, thresholds: {},
    decisionRuleVersion: 'rules-old'
  });
  const terminalToken = 'SysvarRent111111111111111111111111111111111';
  candidates.findOrCreate({
    chain: 'sol', tokenAddress: terminalToken, firstSeenAtMs: 100,
    firstSeenPriceUsd: 0.001, firstSeenRank: 20,
    firstSeenMarketCapUsd: 30_000, firstSeenLiquidityUsd: 12_000,
    discoveryRuleVersion: 'rules-old'
  });
  candidates.transition('sol', terminalToken, 'REJECTED', {
    atMs: 170, terminalReason: 'SECURITY_REJECTED'
  });
  const outbox = new OutboxRepository(v7);
  const signal = outbox.create({
    chain: 'sol', tokenAddress: activatedToken, messageKind: 'signal',
    channelRole: 'validation', payload: { text: 'preserved signal' }, createdAtMs: 180
  });
  outbox.claim(signal.id, 181);
  outbox.markSent(signal.id, 'preserved-message', 182);
  const sample = v7.prepare(`
    INSERT INTO delivered_signal_samples(
      outbox_id, chain, token_address, delivery_stage, receipt_at_ms,
      pre_send_price_usd, pre_send_trade_at_ms, entry_status,
      discovery_rule_version, decision_rule_version,
      validation_epoch, validation_seq, snapshot_json, created_at_ms, updated_at_ms
    ) VALUES (?, 'sol', ?, 'validation', 182, 0.001, 181, 'PENDING',
      'rules-old', 'rules-old', 3, 7, '{}', 182, 182)
  `).run(signal.id, activatedToken);
  v7.prepare(`
    INSERT INTO signal_evaluation_points(
      sample_id, horizon_seconds, scheduled_at_ms, next_attempt_at_ms,
      status, retry_count, details_json, updated_at_ms
    ) VALUES (?, 900, 1082, 1082, 'PENDING', 0, '{}', 182)
  `).run(Number(sample.lastInsertRowid));
  v7.prepare(`
    INSERT INTO evaluation_reports(
      chain, decision_rule_version, kind, boundary_count, generated_at_ms, snapshot_json
    ) VALUES ('sol', 'rules-old', 'MILESTONE', 5, 183, '{}')
  `).run();
  v7.prepare(`
    UPDATE chain_release_state
    SET state = 'BETA', validation_epoch = 3, next_validation_seq = 8, updated_at_ms = 184
    WHERE chain = 'sol'
  `).run();
  const preservedTables = [
    'candidates', 'pool_bindings', 'message_outbox', 'delivered_signal_samples',
    'signal_evaluation_points', 'evaluation_reports', 'chain_release_state'
  ] as const;
  const preservedBefore = new Map(preservedTables.map((table) => [
    table,
    JSON.stringify(v7.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  ]));
  v7.close();

  const upgraded = openDatabase(path);
  const bridges = upgraded.prepare(`
    SELECT token_address, observed_at_ms, raw_json
    FROM qualification_events
    WHERE chain = 'sol' AND stage = 'bonding_shortcut_readiness'
    ORDER BY token_address, observed_at_ms
  `).all() as Array<Record<string, unknown>>;
  assert.deepEqual(bridges.map((row) => ({ ...row })), [
    {
      token_address: SOL_TOKEN,
      observed_at_ms: 130,
      raw_json: `{"tokenAddress":"${SOL_TOKEN}"}`
    },
    {
      token_address: resetToken,
      observed_at_ms: 130,
      raw_json: '{"source":"before-reset"}'
    },
    {
      token_address: resetToken,
      observed_at_ms: 230,
      raw_json: '{"source":"after-reset"}'
    }
  ]);
  assert.equal(
    upgraded.prepare('SELECT count(*) AS count FROM _migrations WHERE version = 8').get()!.count,
    1
  );
  new RuleVersionRepository(upgraded).save('rules-new', {
    discoveryPolicy: 'sol-public-only-change',
    qualificationPolicy: 'unchanged',
    evaluationPolicy: 'unchanged'
  }, 500);
  assert.equal(new CandidateRepository(upgraded).reopenEligibleLegacy('rules-new', 500), 0);
  for (const table of preservedTables) {
    assert.equal(
      JSON.stringify(upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      preservedBefore.get(table),
      `${table} changed during v8 upgrade`
    );
  }
  assert.equal(
    upgraded.prepare('SELECT count(*) AS count FROM rule_versions').get()!.count,
    2
  );
  upgraded.close();
  const reopened = openDatabase(path);
  assert.equal(reopened.prepare(`
    SELECT count(*) AS count FROM qualification_events
    WHERE chain = 'sol' AND stage = 'bonding_shortcut_readiness'
  `).get()!.count, 3);
  reopened.close();

  const failedPath = join(directory, 'failed.db');
  const failedV7 = openVersionDatabase(failedPath, 7);
  new RuleVersionRepository(failedV7).save('rules-old', {}, 1);
  const failedCandidates = new CandidateRepository(failedV7);
  failedCandidates.findOrCreate({
    chain: 'sol', tokenAddress: SOL_TOKEN, firstSeenAtMs: 100,
    firstSeenPriceUsd: 0.001, firstSeenRank: 5,
    firstSeenMarketCapUsd: 30_000, firstSeenLiquidityUsd: 0,
    discoveryRuleVersion: 'rules-old'
  });
  failedCandidates.transition('sol', SOL_TOKEN, 'RADAR', { atMs: 120 });
  new QualificationEventRepository(failedV7).record({
    chain: 'sol', tokenAddress: SOL_TOKEN, stage: 'activation', outcome: 'WAIT',
    reasonCode: 'DUAL_RANK_BONDING_CURVE', source: 'gmgn', observedAtMs: 130,
    raw: {}, normalized: {}, thresholds: {}, decisionRuleVersion: 'rules-old'
  });
  failedV7.exec(`
    CREATE TRIGGER fail_v8_bridge BEFORE INSERT ON qualification_events
    WHEN NEW.stage = 'bonding_shortcut_readiness'
    BEGIN SELECT RAISE(ABORT, 'fixture migration failure'); END;
  `);
  failedV7.close();
  assert.throws(() => openDatabase(failedPath), /fixture migration failure/);
  const failed = new DatabaseSync(failedPath);
  assert.equal(failed.prepare(
    'SELECT count(*) AS count FROM _migrations WHERE version = 8'
  ).get()!.count, 0);
  assert.equal(failed.prepare(`
    SELECT count(*) AS count FROM qualification_events
    WHERE stage = 'bonding_shortcut_readiness'
  `).get()!.count, 0);
  failed.close();
});

test('outbox retries explicit failures but quarantines unknown or interrupted sends', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-outbox-'));
  const path = join(directory, 'state.db');
  const seeded = seedBscCandidate(openDatabase(path));
  const outbox = new OutboxRepository(seeded.database);
  const signal = outbox.create({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    messageKind: 'signal',
    channelRole: 'validation',
    payload: { text: 'safe test' },
    createdAtMs: 200
  });
  assert.equal(outbox.claim(signal.id, 210).status, 'SENDING');
  assert.equal(outbox.markExplicitFailure(signal.id, 'http_400', 220).status, 'PENDING');
  assert.equal(outbox.claim(signal.id, 230).attemptCount, 2);
  assert.equal(outbox.markSent(signal.id, '42', 240).status, 'SENT');
  assert.throws(
    () =>
      outbox.create({
        chain: 'bsc',
        tokenAddress: BSC_TOKEN,
        messageKind: 'signal',
        channelRole: 'formal',
        payload: {}
      }),
    /UNIQUE constraint/
  );

  const radar = outbox.create({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    messageKind: 'radar',
    channelRole: 'radar',
    payload: {}
  });
  outbox.claim(radar.id, 250);
  assert.equal(outbox.markUncertain(radar.id, 'timeout_unknown', 260).status, 'UNCERTAIN');
  assert.throws(() => outbox.claim(radar.id), /not claimable/);
  seeded.database.close();

  const second = openDatabase(path);
  assert.equal(new OutboxRepository(second).recoverInterruptedSends(300), 0);
  second.close();
});

test('radar SENT transition atomically stores one immutable initial envelope', () => {
  const { database } = seedBscCandidate();
  const outbox = new OutboxRepository(database);
  const row = outbox.create({
    chain: 'bsc', tokenAddress: BSC_TOKEN, messageKind: 'radar',
    channelRole: 'radar', payload: radarPayload(), createdAtMs: 200
  });
  outbox.claim(row.id, 210);
  assert.throws(() => outbox.markSent(row.id, 'radar-bypass', 220), /signal outbox/);
  const sent = outbox.markRadarSent(row.id, 'radar-42', 220, 'rules-a', 'hash-a');
  assert.equal(sent.status, 'SENT');
  assert.deepEqual(sent.initialPayload, {
    payload: radarPayload(),
    sendRequestedAtMs: 210,
    receiptAtMs: 220,
    ruleVersion: 'rules-a'
  });
  const editedPayload = { ...radarPayload('real_pool'), text: 'edited radar fixture' };
  outbox.updateRadarPayload(row.id, editedPayload, 230);
  outbox.markPayloadApplied(row.id, 'hash-b', 240);
  const edited = outbox.find('bsc', BSC_TOKEN, 'radar')!;
  assert.deepEqual(edited.payload, editedPayload);
  assert.deepEqual(edited.initialPayload, sent.initialPayload);
  assert.throws(
    () => outbox.markRadarSent(row.id, 'radar-43', 250, 'rules-a', 'hash-c'),
    /not sending/
  );
  database.prepare(`
    UPDATE message_outbox SET initial_payload_json = '{"payload":{}}' WHERE id = ?
  `).run(row.id);
  assert.throws(
    () => outbox.find('bsc', BSC_TOKEN, 'radar'),
    /initial payload text is required/
  );
  database.close();
});

test('restart converts a crash-after-send window to non-retryable UNCERTAIN', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-signal-crash-'));
  const path = join(directory, 'state.db');
  const seeded = seedBscCandidate(openDatabase(path));
  const outbox = new OutboxRepository(seeded.database);
  const row = outbox.create({
    chain: 'bsc',
    tokenAddress: BSC_TOKEN,
    messageKind: 'signal',
    channelRole: 'validation',
    payload: {}
  });
  outbox.claim(row.id, 400);
  seeded.database.close();

  const restarted = openDatabase(path);
  const restartedOutbox = new OutboxRepository(restarted);
  assert.equal(restartedOutbox.recoverInterruptedSends(500), 1);
  const recovered = restartedOutbox.find('bsc', BSC_TOKEN, 'signal')!;
  assert.equal(recovered.status, 'UNCERTAIN');
  assert.equal(recovered.lastError, 'process_interrupted_while_sending');
  assert.throws(() => restartedOutbox.claim(recovered.id), /not claimable/);
  restarted.close();
});

test('legacy migration resets only unsent candidates that must establish a fresh activation', () => {
  const { database, candidates } = seedBscCandidate();
  const token = (index: number) => `0x${index.toString(16).padStart(40, '0')}`;
  const create = (address: string) => {
    candidates.findOrCreate({
      chain: 'bsc',
      tokenAddress: address,
      firstSeenAtMs: 100,
      firstSeenPriceUsd: 0.001,
      firstSeenRank: 5,
      firstSeenMarketCapUsd: 30_000,
      firstSeenLiquidityUsd: 12_000,
      discoveryRuleVersion: 'rules-a'
    });
  };

  const active = token(101);
  create(active);
  candidates.transition('bsc', active, 'PREHEAT', { atMs: 110 });
  new PoolBindingRepository(database).bind({
    chain: 'bsc',
    tokenAddress: active,
    poolAddress: token(201),
    candidateSide: 'base',
    counterTokenAddress: token(202),
    boundAtMs: 120
  });

  const oldTerminal = token(102);
  create(oldTerminal);
  candidates.transition('bsc', oldTerminal, 'REJECTED', {
    atMs: 120,
    terminalReason: 'POOL_TOO_OLD'
  });

  const sentTerminal = token(103);
  create(sentTerminal);
  candidates.transition('bsc', sentTerminal, 'REJECTED', {
    atMs: 120,
    terminalReason: 'POOL_TOO_OLD'
  });
  const sentOutbox = new OutboxRepository(database);
  const sentRecord = sentOutbox.create({
    chain: 'bsc',
    tokenAddress: sentTerminal,
    messageKind: 'signal',
    channelRole: 'validation',
    payload: {},
    createdAtMs: 125
  });
  sentOutbox.claim(sentRecord.id, 126);
  sentOutbox.markSent(sentRecord.id, '103', 127);

  const pendingActive = token(105);
  create(pendingActive);
  candidates.transition('bsc', pendingActive, 'PREHEAT', { atMs: 128 });
  new OutboxRepository(database).create({
    chain: 'bsc',
    tokenAddress: pendingActive,
    messageKind: 'signal',
    channelRole: 'validation',
    payload: {},
    createdAtMs: 129
  });

  const currentChase = token(104);
  create(currentChase);
  candidates.activate({
    chain: 'bsc',
    tokenAddress: currentChase,
    opportunityType: 'revival',
    priceUsd: 0.001,
    ruleVersion: 'rules-a',
    atMs: 130
  });
  candidates.updateHighWater({
    chain: 'bsc',
    tokenAddress: currentChase,
    observedPriceUsd: 0.00181,
    maxGainRatio: 0.8,
    decisionRuleVersion: 'rules-a',
    observedAtMs: 140,
    raw: {}
  });

  assert.equal(candidates.reopenEligibleLegacy('rules-a', 200), 3);
  assert.equal(candidates.find('bsc', active)!.status, 'DISCOVERED');
  assert.equal(new PoolBindingRepository(database).find('bsc', active), undefined);
  assert.equal(candidates.find('bsc', oldTerminal)!.status, 'DISCOVERED');
  assert.equal(candidates.find('bsc', sentTerminal)!.status, 'REJECTED');
  assert.equal(candidates.find('bsc', pendingActive)!.status, 'DISCOVERED');
  assert.equal(
    new OutboxRepository(database).find('bsc', pendingActive, 'signal')!.status,
    'PENDING'
  );
  assert.equal(candidates.find('bsc', currentChase)!.status, 'REJECTED');
  assert.equal(candidates.reopenEligibleLegacy('rules-a', 300), 0);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM qualification_events WHERE reason_code IN ('LEGACY_ACTIVE_RESET', 'LEGACY_TERMINAL_REOPENED')").get()!.count,
    3
  );
  database.close();
});
