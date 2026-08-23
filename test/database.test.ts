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
  RankSnapshotRepository,
  RuleVersionRepository
} from '../src/db/repositories.js';

const BSC_TOKEN = '0xAbCdEf0000000000000000000000000000000001';
const BSC_POOL = '0xAbCdEf0000000000000000000000000000000002';
const BSC_COUNTER = '0xAbCdEf0000000000000000000000000000000003';
const SOL_TOKEN = 'So11111111111111111111111111111111111111112';

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
  const seeded = seedBscCandidate(openDatabase(path));
  seeded.database.exec(`
    DROP TABLE _migrations;
    CREATE TABLE _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
    INSERT INTO _migrations(version, name, applied_at_ms)
    VALUES
      (1, 'initial_state', 1),
      (2, 'successful_rank_fetches', 2),
      (3, 'compact_rank_fetches', 3),
      (4, 'signal_delivery_followups', 4),
      (5, 'signal_evaluation_and_chain_release', 5);
  `);
  seeded.database.close();

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
