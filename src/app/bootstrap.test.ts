import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapApplication } from './bootstrap.js';

describe('application bootstrap', () => {
  let directory: string | undefined;
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it('runs migrations before starting the application', async () => {
    directory = mkdtempSync(join(tmpdir(), 'webhook-bootstrap-'));
    database = new DatabaseSync(':memory:');
    writeFileSync(
      join(directory, '001_create_probe.sql'),
      'CREATE TABLE bootstrap_probe (id INTEGER PRIMARY KEY);',
    );
    let started = false;

    await bootstrapApplication({
      dialect: 'sqlite',
      connection: database,
      migrationDirectory: directory,
      start: () => {
        expect(
          database?.prepare("SELECT name FROM sqlite_master WHERE name = 'bootstrap_probe'").get(),
        ).toBeDefined();
        started = true;
      },
    });

    expect(started).toBe(true);
  });

  it('does not start the application when migrations fail', async () => {
    directory = mkdtempSync(join(tmpdir(), 'webhook-bootstrap-'));
    database = new DatabaseSync(':memory:');
    writeFileSync(
      join(directory, '001_failed.sql'),
      'INSERT INTO table_that_does_not_exist VALUES (1);',
    );
    let started = false;

    await expect(
      bootstrapApplication({
        dialect: 'sqlite',
        connection: database,
        migrationDirectory: directory,
        start: () => {
          started = true;
        },
      }),
    ).rejects.toThrow();

    expect(started).toBe(false);
  });
});
