import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS } from './migrations.js';

export type SqliteDatabase = DatabaseSync;

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  ) STRICT;
`;

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function ensureParentDirectory(databasePath: string): string {
  if (databasePath === ':memory:') return databasePath;
  const resolved = resolve(databasePath);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function applyMigrations(database: SqliteDatabase): void {
  database.exec(CREATE_MIGRATIONS_TABLE.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));

  const migrationColumns = database.prepare('PRAGMA table_info(_migrations)').all() as Array<{
    name: string;
  }>;
  if (!migrationColumns.some((column) => column.name === 'checksum')) {
    const legacyRows = database
      .prepare('SELECT version, name, applied_at_ms FROM _migrations')
      .all() as Array<{ version: number; name: string; applied_at_ms: number }>;
    const definitions = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
    for (const row of legacyRows) {
      const definition = definitions.get(row.version);
      if (definition === undefined || definition.name !== row.name) {
        throw new Error(`legacy migration ${row.version} does not match current definitions`);
      }
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('ALTER TABLE _migrations RENAME TO _migrations_legacy');
      database.exec(CREATE_MIGRATIONS_TABLE);
      const insert = database.prepare(
        'INSERT INTO _migrations(version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)'
      );
      for (const row of legacyRows) {
        const definition = definitions.get(row.version)!;
        insert.run(
          row.version,
          row.name,
          migrationChecksum(definition.sql),
          row.applied_at_ms
        );
      }
      database.exec('DROP TABLE _migrations_legacy');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  const applied = database.prepare('SELECT version, name, checksum FROM _migrations').all() as Array<{
    version: number;
    name: string;
    checksum: string;
  }>;
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const insertMigration = database.prepare(
    'INSERT INTO _migrations(version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)'
  );

  for (const migration of MIGRATIONS) {
    const checksum = migrationChecksum(migration.sql);
    const existing = appliedByVersion.get(migration.version);
    if (existing !== undefined) {
      if (existing.name !== migration.name || existing.checksum !== checksum) {
        throw new Error(`migration ${migration.version} definition does not match database`);
      }
      continue;
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, checksum, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase(databasePath: string): SqliteDatabase {
  const database = new DatabaseSync(ensureParentDirectory(databasePath));
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA synchronous = NORMAL');
  if (databasePath !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  applyMigrations(database);
  return database;
}

export function withTransaction<T>(database: SqliteDatabase, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
