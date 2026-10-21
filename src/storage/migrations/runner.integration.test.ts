import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './runner.js';

describe('SQLite migration runner integration', () => {
  it('applies the bundled schema to a fresh on-disk database exactly once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'webhook-sqlite-migrations-'));
    const databasePath = join(directory, 'test.db');
    const database = new DatabaseSync(databasePath);

    try {
      expect(await runMigrations({ dialect: 'sqlite', connection: database })).toEqual([
        '001_initial_schema',
      ]);
      expect(await runMigrations({ dialect: 'sqlite', connection: database })).toEqual([]);
      expect(
        database.prepare('SELECT version, checksum FROM schema_migrations').get(),
      ).toMatchObject({
        version: '001_initial_schema',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_events'",
          )
          .get(),
      ).toBeDefined();
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_event_attempts'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
