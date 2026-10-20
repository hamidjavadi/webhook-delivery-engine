import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const sqliteMigration = readFileSync(
  new URL('./migrations/sql/sqlite/001_initial_schema.sql', import.meta.url),
  'utf8',
);
const postgresMigration = readFileSync(
  new URL('./migrations/sql/postgres/001_initial_schema.sql', import.meta.url),
  'utf8',
);
const mysqlMigration = readFileSync(
  new URL('./migrations/sql/mysql/001_initial_schema.sql', import.meta.url),
  'utf8',
);

describe('initial database schema migrations', () => {
  it('applies the SQLite schema to a fresh database and tracks the migration', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(
      `PRAGMA foreign_keys = ON;
       CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`,
    );
    database.exec(
      `BEGIN IMMEDIATE;
       ${sqliteMigration}
       INSERT INTO schema_migrations (version, applied_at)
       VALUES ('001_initial_schema', '2026-10-20T12:00:00.000Z');
       COMMIT;`,
    );
    database.exec(sqliteMigration);

    const trackedMigration = database.prepare('SELECT version FROM schema_migrations').get() as {
      version: string;
    };
    const migrationCount = database
      .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
      .get();
    const eventColumns = database.prepare("PRAGMA table_info('webhook_events')").all() as {
      name: string;
    }[];
    const attemptColumns = database
      .prepare("PRAGMA table_info('webhook_event_attempts')")
      .all() as { name: string }[];
    const eventIndexes = database.prepare("PRAGMA index_list('webhook_events')").all() as {
      name: string;
      unique: number;
    }[];
    const attemptIndexes = database
      .prepare("PRAGMA index_list('webhook_event_attempts')")
      .all() as { name: string; unique: number }[];
    const dueIndexColumns = database
      .prepare("PRAGMA index_info('idx_webhook_events_due')")
      .all() as { name: string }[];
    const attemptIndexColumns = database
      .prepare("PRAGMA index_info('uq_webhook_event_attempts_event_number')")
      .all() as { name: string }[];
    const eventForeignKeys = database
      .prepare("PRAGMA foreign_key_list('webhook_event_attempts')")
      .all() as { table: string; from: string; to: string; on_delete: string }[];

    expect(trackedMigration.version).toBe('001_initial_schema');
    expect(migrationCount).toMatchObject({ count: 1 });
    expect(eventColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'id',
        'idempotency_key',
        'client_id',
        'destination_url',
        'payload',
        'metadata',
        'headers',
        'status',
        'attempt_count',
        'next_retry_at',
        'locked_at',
        'locked_by',
        'created_at',
        'updated_at',
      ]),
    );
    expect(attemptColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'id',
        'event_id',
        'attempt_number',
        'attempted_at',
        'status_code',
        'response_snippet',
        'error',
        'latency_ms',
        'outcome',
      ]),
    );
    expect(eventIndexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'idx_webhook_events_due' })]),
    );
    expect(attemptIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'uq_webhook_event_attempts_event_number',
          unique: 1,
        }),
      ]),
    );
    expect(dueIndexColumns.map(({ name }) => name)).toEqual(['status', 'next_retry_at']);
    expect(attemptIndexColumns.map(({ name }) => name)).toEqual(['event_id', 'attempt_number']);
    expect(eventForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'webhook_events',
          from: 'event_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      ]),
    );

    database.close();
  });

  it('enforces tenant idempotency and unique attempt ordinals in SQLite', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(
      `PRAGMA foreign_keys = ON;
       ${sqliteMigration}`,
    );
    database
      .prepare(
        `INSERT INTO webhook_events (
          id, idempotency_key, client_id, destination_url, payload, metadata,
          headers, status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'event-1',
        'key-1',
        'client-1',
        'https://consumer.example/hooks',
        '{}',
        '{}',
        '{}',
        'pending',
        0,
        '2026-10-20T12:00:00.000Z',
        '2026-10-20T12:00:00.000Z',
      );

    expect(() =>
      database
        .prepare(
          `INSERT INTO webhook_events (
            id, idempotency_key, client_id, destination_url, payload, metadata,
            headers, status, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'event-2',
          'key-1',
          'client-1',
          'https://consumer.example/hooks',
          '{}',
          '{}',
          '{}',
          'pending',
          0,
          '2026-10-20T12:00:00.000Z',
          '2026-10-20T12:00:00.000Z',
        ),
    ).toThrow();
    database
      .prepare(
        `INSERT INTO webhook_events (
          id, idempotency_key, client_id, destination_url, payload, metadata,
          headers, status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'event-other-client',
        'key-1',
        'client-2',
        'https://consumer.example/hooks',
        '{}',
        '{}',
        '{}',
        'pending',
        0,
        '2026-10-20T12:00:00.000Z',
        '2026-10-20T12:00:00.000Z',
      );
    expect(() =>
      database
        .prepare("UPDATE webhook_events SET status = 'completed' WHERE id = ?")
        .run('event-1'),
    ).toThrow();
    expect(() =>
      database
        .prepare("UPDATE webhook_events SET payload = 'not-json' WHERE id = ?")
        .run('event-1'),
    ).toThrow();

    const insertAttempt = database.prepare(
      `INSERT INTO webhook_event_attempts (
        id, event_id, attempt_number, attempted_at, outcome
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    insertAttempt.run('attempt-1', 'event-1', 1, '2026-10-20T12:00:00.000Z', 'retry_scheduled');
    expect(() =>
      insertAttempt.run('attempt-2', 'event-1', 1, '2026-10-20T12:01:00.000Z', 'retry_scheduled'),
    ).toThrow();
    expect(() =>
      insertAttempt.run(
        'attempt-orphan',
        'missing-event',
        1,
        '2026-10-20T12:01:00.000Z',
        'retry_scheduled',
      ),
    ).toThrow();
    database.prepare('DELETE FROM webhook_events WHERE id = ?').run('event-1');
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM webhook_event_attempts WHERE event_id = ?')
        .get('event-1'),
    ).toMatchObject({ count: 0 });

    database.close();
  });

  it.each([
    ['PostgreSQL', postgresMigration],
    ['MySQL', mysqlMigration],
  ])(
    'declares the approved tables, states, and composite indexes for %s',
    (_dialect, migration) => {
      expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS webhook_events/i);
      expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS webhook_event_attempts/i);
      expect(migration).toMatch(/UNIQUE\s*\(\s*client_id\s*,\s*idempotency_key\s*\)/i);
      expect(migration).toMatch(
        /status[\s\S]*pending[\s\S]*processing[\s\S]*delivered[\s\S]*retry[\s\S]*failed/i,
      );
      expect(migration).toMatch(/idx_webhook_events_due[\s\S]*status[\s\S]*next_retry_at/i);
      expect(migration).toMatch(
        /uq_webhook_event_attempts_event_number[\s\S]*event_id[\s\S]*attempt_number/i,
      );
      expect(migration).toMatch(/FOREIGN KEY\s*\(\s*event_id\s*\)[\s\S]*ON DELETE CASCADE/i);
    },
  );

  it('uses bounded tenant-scoped MySQL idempotency columns and native enums', () => {
    expect(mysqlMigration).toMatch(
      /idempotency_key\s+VARCHAR\(255\)\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin\s+NOT NULL/i,
    );
    expect(mysqlMigration).toMatch(
      /client_id\s+VARCHAR\(255\)\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin\s+NOT NULL/i,
    );
    expect(mysqlMigration).toMatch(
      /CONSTRAINT\s+uq_client_idempotency\s+UNIQUE\s*\(\s*client_id\s*,\s*idempotency_key\s*\)/i,
    );
    expect(mysqlMigration).toMatch(
      /status\s+ENUM\('pending',\s*'processing',\s*'delivered',\s*'retry',\s*'failed'\)/i,
    );
  });
});
