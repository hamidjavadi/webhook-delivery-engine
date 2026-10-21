import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQLInputValue } from 'node:sqlite';

/** A prepared SQLite statement surface shared by supported SQLite drivers. */
export interface SqliteMigrationStatement {
  /** Returns all rows produced by a query; row shape is validated by the runner. */
  all(...parameters: SQLInputValue[]): unknown;
  /** Returns one row produced by a query; row shape is validated by the runner. */
  get(...parameters: SQLInputValue[]): unknown;
  /** Executes a statement without returning rows. */
  run(...parameters: SQLInputValue[]): unknown;
}

/** The minimal synchronous SQLite connection surface needed to apply migrations. */
export interface SqliteMigrationConnection {
  /** Executes one or more SQL statements on the current connection. */
  exec(sql: string): void;
  /** Prepares a SQL statement for parameterized execution. */
  prepare(sql: string): SqliteMigrationStatement;
}

/** Options for applying migrations with a synchronous SQLite connection. */
export interface SqliteMigrationOptions {
  /** Selects the SQLite execution and transaction policy. */
  readonly dialect: 'sqlite';
  /** Connection whose transaction is exclusively controlled during migration. */
  readonly connection: SqliteMigrationConnection;
  /** Directory containing versioned SQLite SQL files; defaults to the bundled directory. */
  readonly migrationDirectory?: string;
}

/** Options for applying the bundled SQLite migrations. */
export type MigrationRunnerOptions = SqliteMigrationOptions;

/** An explicit failure raised when migration discovery, validation, or execution fails. */
export class MigrationError extends Error {
  /**
   * Creates a migration failure with an optional originating error.
   *
   * @param message - Actionable description of the migration failure.
   * @param cause - Original filesystem or database error, when available.
   */
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MigrationError';
  }
}

interface MigrationFile {
  readonly version: string;
  readonly checksum: string;
  readonly sql: string;
}

interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
}

/**
 * Applies the forward-only SQL migrations for SQLite.
 *
 * Migration files are applied in lexical filename order, hashed with SHA-256,
 * and recorded in `schema_migrations`. Existing records must match both the
 * checked-in migration file and checksum. All pending SQLite migrations run
 * in one transaction.
 *
 * @param options - Dialect, connection, and optional migration directory.
 * @returns Versions newly applied by this invocation, in application order.
 * @throws {@link MigrationError} when files are invalid, drift is detected, or execution fails.
 */
export async function runMigrations(options: MigrationRunnerOptions): Promise<readonly string[]> {
  const directory =
    options.migrationDirectory ?? fileURLToPath(new URL('./sql/sqlite/', import.meta.url));
  const files = await loadMigrationFiles(directory);
  return runSqliteMigrations(options.connection, files);
}

async function loadMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    throw new MigrationError(`Unable to read migration directory "${directory}".`, cause);
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  const versions = new Set<string>();
  const ordinals = new Set<string>();
  const files: MigrationFile[] = [];

  for (const name of names) {
    const match = /^(\d+_[a-z0-9][a-z0-9_-]*)\.sql$/.exec(name);
    if (match === null) {
      throw new MigrationError(`Invalid migration filename "${name}".`);
    }
    const version = match[1];
    if (version === undefined || versions.has(version)) {
      throw new MigrationError(`Duplicate or invalid migration version in "${name}".`);
    }
    const ordinal = BigInt(version.slice(0, version.indexOf('_'))).toString();
    if (ordinals.has(ordinal)) {
      throw new MigrationError(`Duplicate migration sequence number in "${name}".`);
    }
    versions.add(version);
    ordinals.add(ordinal);

    let sql: string;
    try {
      sql = await readFile(join(directory, name), 'utf8');
    } catch (cause) {
      throw new MigrationError(`Unable to read migration file "${name}".`, cause);
    }
    if (sql.trim().length === 0) {
      throw new MigrationError(`Migration "${version}" is empty.`);
    }

    files.push({
      version,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
      sql,
    });
  }

  return files.sort((left, right) => {
    const leftOrdinal = BigInt(left.version.slice(0, left.version.indexOf('_')));
    const rightOrdinal = BigInt(right.version.slice(0, right.version.indexOf('_')));
    return leftOrdinal < rightOrdinal ? -1 : leftOrdinal > rightOrdinal ? 1 : 0;
  });
}

function readAppliedMigrations(rows: unknown): readonly AppliedMigration[] {
  if (!Array.isArray(rows)) {
    throw new MigrationError('Migration ledger query returned an invalid result.');
  }

  return rows.map((row: unknown) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('version' in row) ||
      !('checksum' in row) ||
      typeof row.version !== 'string' ||
      typeof row.checksum !== 'string'
    ) {
      throw new MigrationError('Migration ledger contains an invalid record.');
    }
    return { version: row.version, checksum: row.checksum };
  });
}

function getPendingMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): readonly MigrationFile[] {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const appliedVersions = new Set<string>();

  for (const record of applied) {
    const file = byVersion.get(record.version);
    if (file === undefined) {
      throw new MigrationError(
        `Applied migration "${record.version}" is missing from the migration directory.`,
      );
    }
    if (file.checksum !== record.checksum) {
      throw new MigrationError(`Checksum mismatch for applied migration "${record.version}".`);
    }
    appliedVersions.add(record.version);
  }

  return files.filter((file) => !appliedVersions.has(file.version));
}

async function runSqliteMigrations(
  connection: SqliteMigrationConnection,
  files: readonly MigrationFile[],
): Promise<readonly string[]> {
  let transactionStarted = false;
  try {
    connection.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    connection.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    const applied = readAppliedMigrations(
      connection.prepare('SELECT version, checksum FROM schema_migrations').all(),
    );
    const pending = getPendingMigrations(files, applied);

    for (const migration of pending) {
      connection.exec(migration.sql);
      connection
        .prepare('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)')
        .run(migration.version, migration.checksum);
    }

    connection.exec('COMMIT');
    return pending.map((migration) => migration.version);
  } catch (cause) {
    if (transactionStarted) {
      try {
        connection.exec('ROLLBACK');
      } catch (rollbackCause) {
        throw new MigrationError(
          'Migration failed and SQLite rollback also failed.',
          new AggregateError([cause, rollbackCause]),
        );
      }
    }
    throw toMigrationError('SQLite migration failed.', cause);
  }
}

function toMigrationError(message: string, cause: unknown): MigrationError {
  if (cause instanceof MigrationError) return cause;
  return new MigrationError(message, cause);
}
