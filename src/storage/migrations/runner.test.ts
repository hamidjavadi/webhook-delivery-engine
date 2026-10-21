import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, runMigrations, type SqliteMigrationConnection } from './runner.js';

describe('SQLite migration runner', () => {
  let directory: string;
  let database: DatabaseSync;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'webhook-migrations-'));
    database = new DatabaseSync(':memory:');
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('applies versioned migrations in order and records checksums', async () => {
    writeFileSync(
      join(directory, '002_add_name.sql'),
      'ALTER TABLE migration_probe ADD COLUMN name TEXT;',
    );
    writeFileSync(
      join(directory, '001_create_probe.sql'),
      'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);',
    );

    const applied = await runMigrations({
      dialect: 'sqlite',
      connection: database,
      migrationDirectory: directory,
    });

    expect(applied).toEqual(['001_create_probe', '002_add_name']);
    expect(
      database
        .prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual([
      expect.objectContaining({
        version: '001_create_probe',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: '002_add_name',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('loads the bundled SQLite migration when no directory is provided', async () => {
    const applied = await runMigrations({
      dialect: 'sqlite',
      connection: database,
    });

    expect(applied).toEqual(['001_initial_schema']);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_events'")
        .get(),
    ).toBeDefined();
  });

  it('skips unchanged migrations when run more than once', async () => {
    writeFileSync(
      join(directory, '001_create_probe.sql'),
      'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);',
    );

    const firstRun = await runMigrations({
      dialect: 'sqlite',
      connection: database,
      migrationDirectory: directory,
    });
    const secondRun = await runMigrations({
      dialect: 'sqlite',
      connection: database,
      migrationDirectory: directory,
    });

    expect(firstRun).toEqual(['001_create_probe']);
    expect(secondRun).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toMatchObject(
      { count: 1 },
    );
  });

  it('rolls back migration DDL and ledger records after a failed statement', async () => {
    writeFileSync(
      join(directory, '001_failed.sql'),
      `CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY);
       INSERT INTO table_that_does_not_exist VALUES (1);`,
    );

    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: directory,
      }),
    ).rejects.toBeInstanceOf(MigrationError);

    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'")
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get(),
    ).toBeUndefined();
  });

  it('rejects a changed file after its version has been applied', async () => {
    const filePath = join(directory, '001_create_probe.sql');
    writeFileSync(filePath, 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);');
    await runMigrations({
      dialect: 'sqlite',
      connection: database,
      migrationDirectory: directory,
    });
    writeFileSync(filePath, 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, name TEXT);');

    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: directory,
      }),
    ).rejects.toThrow(/checksum/i);
  });

  it('rejects an applied migration that is missing from the migration directory', async () => {
    const migrationPath = join(directory, '001_create_probe.sql');
    writeFileSync(migrationPath, 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);');
    await runMigrations({
      dialect: 'sqlite',
      connection: database,
      migrationDirectory: directory,
    });
    rmSync(migrationPath);

    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: directory,
      }),
    ).rejects.toThrow(/missing/i);
  });

  it('rejects migration directories that do not exist', async () => {
    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: join(directory, 'missing'),
      }),
    ).rejects.toThrow(/directory/i);
  });

  it('rejects invalid, ambiguous, and empty migration files', async () => {
    writeFileSync(join(directory, 'not-versioned.sql'), 'SELECT 1;');
    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: directory,
      }),
    ).rejects.toThrow(/filename/i);
    rmSync(join(directory, 'not-versioned.sql'));

    writeFileSync(join(directory, '001_first.sql'), 'SELECT 1;');
    writeFileSync(join(directory, '001_second.sql'), 'SELECT 2;');
    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: directory,
      }),
    ).rejects.toThrow(/sequence/i);
    rmSync(join(directory, '001_first.sql'));
    rmSync(join(directory, '001_second.sql'));

    writeFileSync(join(directory, '001_empty.sql'), '  \n ');
    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: directory,
      }),
    ).rejects.toThrow(/empty/i);
  });

  it('rejects invalid records already stored in the migration ledger', async () => {
    database.exec(
      `CREATE TABLE schema_migrations (version, checksum);
       INSERT INTO schema_migrations (version, checksum) VALUES (1, 'invalid');`,
    );

    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: directory,
      }),
    ).rejects.toThrow(/invalid record/i);
  });

  it('rejects malformed SQLite migration ledger query results', async () => {
    const connection = {
      exec: () => undefined,
      prepare: () => ({
        all: () => undefined,
        get: () => undefined,
        run: () => undefined,
      }),
    } as unknown as SqliteMigrationConnection;

    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection,
        migrationDirectory: directory,
      }),
    ).rejects.toThrow(/invalid result/i);
  });

  it('reports SQLite rollback failures without hiding the migration error', async () => {
    writeFileSync(join(directory, '001_failure.sql'), 'CREATE TABLE probe (id INTEGER);');
    const connection = {
      exec: (sql: string) => {
        if (sql === 'ROLLBACK') throw new Error('Rollback failed');
        if (sql.startsWith('CREATE TABLE probe')) throw new Error('Migration failed');
      },
      prepare: () => ({
        all: () => [],
        get: () => undefined,
        run: () => undefined,
      }),
    } as unknown as SqliteMigrationConnection;

    await expect(
      runMigrations({
        dialect: 'sqlite',
        connection,
        migrationDirectory: directory,
      }),
    ).rejects.toThrow(/rollback also failed/i);
  });
});
