import { Buffer } from 'node:buffer';
import type { SQLInputValue } from 'node:sqlite';
import Database from 'better-sqlite3';
import type {
  AttemptRecord,
  AttemptOutcome,
  EventStatus,
  JsonValue,
  Timestamp,
  WebhookEvent,
} from '../core/types.js';
import type {
  ClaimDueEventsInput,
  DatabaseAdapter,
  EventPage,
  EventUpsertResult,
  ListEventsInput,
  RecordAttemptAndTransitionInput,
  RecoverStaleLeasesInput,
  ReleaseEventLeaseInput,
} from '../core/ports.js';
import {
  runMigrations,
  type SqliteMigrationConnection,
  type SqliteMigrationStatement,
} from './migrations/runner.js';

const MAX_PAGE_SIZE = 1000;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type DatabaseConnection = InstanceType<typeof Database>;
type Row = Record<string, unknown>;

function createMigrationConnection(database: DatabaseConnection): SqliteMigrationConnection {
  return {
    exec: (sql) => {
      database.exec(sql);
    },
    prepare: (sql): SqliteMigrationStatement => {
      const statement = database.prepare<SQLInputValue[]>(sql);
      return {
        all: (...parameters) => statement.all(...parameters),
        get: (...parameters) => statement.get(...parameters),
        run: (...parameters) => statement.run(...parameters),
      };
    },
  };
}

const eventStatuses: readonly EventStatus[] = [
  'pending',
  'processing',
  'delivered',
  'retry',
  'failed',
];
const attemptOutcomes: readonly AttemptOutcome[] = ['success', 'retry_scheduled', 'exhausted'];

/**
 * SQLite implementation of the driver-neutral event persistence contract.
 *
 * Create instances with {@link SqliteDatabaseAdapter.open}; the returned
 * adapter owns its database connection and must be closed by its owner.
 */
export class SqliteDatabaseAdapter implements DatabaseAdapter {
  private constructor(private readonly database: DatabaseConnection) {}

  /**
   * Opens and initializes a SQLite database before exposing the adapter.
   *
   * Initialization enables WAL, a 5-second busy timeout, foreign-key checks,
   * and applies the bundled forward-only migrations. The connection is closed
   * and the original error is propagated if initialization fails.
   *
   * @param filename - SQLite database file path; use a file for WAL support.
   * @returns An initialized adapter implementing {@link DatabaseAdapter}.
   * @throws When the database cannot be opened, configured, or migrated.
   */
  public static async open(filename: string): Promise<SqliteDatabaseAdapter> {
    const database = new Database(filename);
    try {
      const journalMode = database.pragma('journal_mode = WAL', { simple: true });
      if (journalMode !== 'wal') {
        throw new Error('SQLite did not enable the required WAL journal mode.');
      }
      const busyTimeout = database.pragma('busy_timeout = 5000', { simple: true });
      if (busyTimeout !== 5000) {
        throw new Error('SQLite did not apply the required 5-second busy timeout.');
      }
      database.pragma('foreign_keys = ON');
      const foreignKeys = database.pragma('foreign_keys', { simple: true });
      if (foreignKeys !== 1) {
        throw new Error('SQLite did not enable foreign-key enforcement.');
      }
      await runMigrations({
        dialect: 'sqlite',
        connection: createMigrationConnection(database),
      });
      return new SqliteDatabaseAdapter(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /**
   * Closes the SQLite connection owned by this adapter.
   *
   * @returns Nothing.
   * @throws When the underlying database cannot be closed.
   */
  public close(): void {
    this.database.close();
  }

  /** @inheritdoc */
  public async upsertEvent(event: WebhookEvent): Promise<EventUpsertResult> {
    const createdAt = normalizeTimestamp(event.createdAt, 'createdAt');
    const updatedAt = normalizeTimestamp(event.updatedAt, 'updatedAt');
    const nextRetryAt = nullableTimestamp(event.nextRetryAt, 'nextRetryAt');
    const lockedAt = nullableTimestamp(event.lockedAt, 'lockedAt');

    const result = this.database
      .prepare(
        `INSERT INTO webhook_events (
          id, idempotency_key, client_id, destination_url, payload, metadata,
          headers, status, attempt_count, next_retry_at, locked_at, locked_by,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (client_id, idempotency_key) DO NOTHING`,
      )
      .run(
        event.id,
        event.idempotencyKey,
        event.clientId,
        event.destinationUrl,
        serializeJson(event.payload, 'payload'),
        serializeJsonObject(event.metadata, 'metadata'),
        serializeHeaders(event.headers),
        event.status,
        event.attemptCount,
        nextRetryAt,
        lockedAt,
        event.lockedBy,
        createdAt,
        updatedAt,
      );

    const row = this.database
      .prepare('SELECT * FROM webhook_events WHERE client_id = ? AND idempotency_key = ?')
      .get(event.clientId, event.idempotencyKey);
    if (row === undefined) {
      throw new Error('The event upsert completed without a matching event row.');
    }
    const storedEvent = readEvent(row);
    return { event: storedEvent, inserted: result.changes === 1 };
  }

  /** @inheritdoc */
  public async claimDueEvents(input: ClaimDueEventsInput): Promise<readonly WebhookEvent[]> {
    assertPositiveSafeInteger(input.limit, 'limit');
    const now = normalizeTimestamp(input.now, 'now');
    const claimedEvents = this.database
      .prepare(
        `UPDATE webhook_events
         SET status = 'processing', locked_at = ?, locked_by = ?,
             attempt_count = attempt_count + 1, updated_at = ?
         WHERE id IN (
           SELECT id FROM webhook_events
           WHERE status IN ('pending', 'retry')
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY created_at ASC, id ASC
           LIMIT ?
         )
         RETURNING *`,
      )
      .all(now, input.workerId, now, now, input.limit)
      .map(readEvent);

    return claimedEvents.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  }

  /** @inheritdoc */
  public async recoverStaleLeases(input: RecoverStaleLeasesInput): Promise<number> {
    const now = normalizeTimestamp(input.now, 'now');
    if (!Number.isSafeInteger(input.timeoutLimitMs) || input.timeoutLimitMs <= 0) {
      throw new RangeError('timeoutLimitMs must be a positive safe integer.');
    }

    const staleThresholdMs = Math.max(input.timeoutLimitMs + 30_000, 90_000);
    if (!Number.isSafeInteger(staleThresholdMs)) {
      throw new RangeError('timeoutLimitMs produces an unsafe stale lease threshold.');
    }
    const nowMilliseconds = Date.parse(now);
    const staleBefore = normalizeTimestamp(
      new Date(nowMilliseconds - staleThresholdMs).toISOString(),
      'staleBefore',
    );
    const nextRetryAt = normalizeTimestamp(
      new Date(nowMilliseconds + 10_000).toISOString(),
      'nextRetryAt',
    );
    const result = this.database
      .prepare(
        `UPDATE webhook_events
         SET status = 'retry', next_retry_at = ?, locked_at = NULL,
             locked_by = NULL, updated_at = ?
         WHERE status = 'processing' AND locked_at < ?`,
      )
      .run(nextRetryAt, now, staleBefore);
    return result.changes;
  }

  /** @inheritdoc */
  public async releaseEventLease(input: ReleaseEventLeaseInput): Promise<boolean> {
    const releasedAt = normalizeTimestamp(input.releasedAt, 'releasedAt');
    const result = this.database
      .prepare(
        `UPDATE webhook_events
         SET status = 'pending', next_retry_at = NULL, locked_at = NULL,
             locked_by = NULL, attempt_count = attempt_count - 1, updated_at = ?
         WHERE id = ? AND locked_by = ? AND status = 'processing'
           AND attempt_count > 0`,
      )
      .run(releasedAt, input.eventId, input.workerId);
    return result.changes === 1;
  }

  /** @inheritdoc */
  public async recordAttemptAndTransition(
    input: RecordAttemptAndTransitionInput,
  ): Promise<boolean> {
    const { attempt, workerId, nextStatus, nextRetryAt, updatedAt } = input;
    const attemptedAt = normalizeTimestamp(attempt.attemptedAt, 'attemptedAt');
    const normalizedUpdatedAt = normalizeTimestamp(updatedAt, 'updatedAt');
    const normalizedNextRetryAt = nullableTimestamp(nextRetryAt, 'nextRetryAt');
    const transaction = this.database.transaction(() => {
      const event = this.database
        .prepare(
          'SELECT attempt_count FROM webhook_events WHERE id = ? AND locked_by = ? AND status = ?',
        )
        .get(attempt.eventId, workerId, 'processing');
      if (event === undefined) return false;
      const attemptCount = readNumberProperty(event, 'attempt_count');
      if (attempt.attemptNumber !== attemptCount) return false;

      this.database
        .prepare(
          `INSERT INTO webhook_event_attempts (
            id, event_id, attempt_number, attempted_at, status_code,
            response_snippet, error, latency_ms, outcome
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempt.id,
          attempt.eventId,
          attempt.attemptNumber,
          attemptedAt,
          attempt.statusCode,
          attempt.responseSnippet,
          attempt.error,
          attempt.latencyMs,
          attempt.outcome,
        );

      const result = this.database
        .prepare(
          `UPDATE webhook_events
           SET status = ?, next_retry_at = ?, locked_at = NULL, locked_by = NULL,
               updated_at = ?
           WHERE id = ? AND locked_by = ? AND status = 'processing'`,
        )
        .run(nextStatus, normalizedNextRetryAt, normalizedUpdatedAt, attempt.eventId, workerId);
      if (result.changes !== 1) {
        throw new Error('The event lease changed while recording the attempt.');
      }
      return true;
    });
    return transaction.immediate();
  }

  /** @inheritdoc */
  public async findEventById(eventId: string, clientId: string): Promise<WebhookEvent | null> {
    const row = this.database
      .prepare('SELECT * FROM webhook_events WHERE id = ? AND client_id = ?')
      .get(eventId, clientId);
    return row === undefined ? null : readEvent(row);
  }

  /** @inheritdoc */
  public async findEventByIdempotencyKey(
    clientId: string,
    idempotencyKey: string,
  ): Promise<WebhookEvent | null> {
    const row = this.database
      .prepare('SELECT * FROM webhook_events WHERE client_id = ? AND idempotency_key = ?')
      .get(clientId, idempotencyKey);
    return row === undefined ? null : readEvent(row);
  }

  /** @inheritdoc */
  public async listEvents(input: ListEventsInput): Promise<EventPage> {
    assertPositiveSafeInteger(input.limit, 'limit');
    if (input.limit > MAX_PAGE_SIZE) {
      throw new RangeError(`limit must not exceed ${MAX_PAGE_SIZE}.`);
    }
    const parameters: (string | number)[] = [input.clientId];
    const filters = ['client_id = ?'];
    if (input.status !== undefined) {
      filters.push('status = ?');
      parameters.push(input.status);
    }
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor);
      filters.push('(created_at > ? OR (created_at = ? AND id > ?))');
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const rows = this.database
      .prepare(
        `SELECT * FROM webhook_events
         WHERE ${filters.join(' AND ')}
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .all(...parameters, input.limit + 1);
    const hasNextPage = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map(readEvent);
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor: hasNextPage && lastItem !== undefined ? encodeCursor(lastItem) : null,
    };
  }

  /** @inheritdoc */
  public async listAttempts(eventId: string, clientId: string): Promise<readonly AttemptRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT attempts.* FROM webhook_event_attempts AS attempts
         INNER JOIN webhook_events AS events ON events.id = attempts.event_id
         WHERE events.id = ? AND events.client_id = ?
         ORDER BY attempts.attempt_number`,
      )
      .all(eventId, clientId);
    return rows.map(readAttempt);
  }
}

function readEvent(value: unknown): WebhookEvent {
  const row = asRow(value, 'event');
  const status = readStringProperty(row, 'status');
  if (!eventStatuses.includes(status as EventStatus)) {
    throw new Error('The database contains an invalid event status.');
  }
  const payload = parseJson(readStringProperty(row, 'payload'), 'payload');
  const metadata = parseJsonObject(readStringProperty(row, 'metadata'), 'metadata');
  const headers = parseHeaders(readStringProperty(row, 'headers'));
  return {
    id: readStringProperty(row, 'id'),
    idempotencyKey: readStringProperty(row, 'idempotency_key'),
    clientId: readStringProperty(row, 'client_id'),
    destinationUrl: readStringProperty(row, 'destination_url'),
    payload,
    metadata,
    headers,
    status: status as EventStatus,
    attemptCount: readNumberProperty(row, 'attempt_count'),
    nextRetryAt: readNullableTimestamp(row, 'next_retry_at'),
    lockedAt: readNullableTimestamp(row, 'locked_at'),
    lockedBy: readNullableStringProperty(row, 'locked_by'),
    createdAt: normalizeTimestamp(readStringProperty(row, 'created_at'), 'created_at'),
    updatedAt: normalizeTimestamp(readStringProperty(row, 'updated_at'), 'updated_at'),
  };
}

function readAttempt(value: unknown): AttemptRecord {
  const row = asRow(value, 'attempt');
  const outcome = readStringProperty(row, 'outcome');
  if (!attemptOutcomes.includes(outcome as AttemptOutcome)) {
    throw new Error('The database contains an invalid attempt outcome.');
  }
  return {
    id: readStringProperty(row, 'id'),
    eventId: readStringProperty(row, 'event_id'),
    attemptNumber: readNumberProperty(row, 'attempt_number'),
    attemptedAt: normalizeTimestamp(readStringProperty(row, 'attempted_at'), 'attempted_at'),
    statusCode: readNullableNumberProperty(row, 'status_code'),
    responseSnippet: readNullableStringProperty(row, 'response_snippet'),
    error: readNullableStringProperty(row, 'error'),
    latencyMs: readNullableNumberProperty(row, 'latency_ms'),
    outcome: outcome as AttemptOutcome,
  };
}

function asRow(value: unknown, description: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`The database returned an invalid ${description} row.`);
  }
  return value as Row;
}

function readStringProperty(row: unknown, key: string): string {
  const value = asRow(row, 'database')[key];
  if (typeof value !== 'string') {
    throw new Error(`The database returned an invalid "${key}" value.`);
  }
  return value;
}

function readNullableStringProperty(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`The database returned an invalid "${key}" value.`);
  }
  return value;
}

function readNumberProperty(row: unknown, key: string): number {
  const value = asRow(row, 'database')[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`The database returned an invalid "${key}" value.`);
  }
  return value;
}

function readNullableNumberProperty(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`The database returned an invalid "${key}" value.`);
  }
  return value;
}

function readNullableTimestamp(row: Row, key: string): Timestamp | null {
  const value = readNullableStringProperty(row, key);
  return value === null ? null : normalizeTimestamp(value, key);
}

function normalizeTimestamp(value: string, field: string): Timestamp {
  const milliseconds = Date.parse(value);
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be a valid ISO-8601 timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

function nullableTimestamp(value: Timestamp | null, field: string): Timestamp | null {
  return value === null ? null : normalizeTimestamp(value, field);
}

function serializeJson(value: JsonValue, field: string): string {
  if (!isJsonValue(value)) {
    throw new TypeError(`${field} must contain JSON-compatible values.`);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`${field} could not be serialized as JSON.`);
  }
  return serialized;
}

function serializeJsonObject(value: Readonly<Record<string, JsonValue>>, field: string): string {
  if (!isJsonObject(value)) {
    throw new TypeError(`${field} must be a JSON object.`);
  }
  return serializeJson(value, field);
}

function serializeHeaders(headers: Readonly<Record<string, string>>): string {
  if (!isStringRecord(headers)) {
    throw new TypeError('headers must contain only string values.');
  }
  return JSON.stringify(headers);
}

function parseJson(value: string, field: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new TypeError(`The persisted ${field} value is invalid JSON.`, { cause });
  }
  if (!isJsonValue(parsed)) {
    throw new TypeError(`The persisted ${field} value is not JSON-compatible.`);
  }
  return parsed;
}

function parseJsonObject(value: string, field: string): Readonly<Record<string, JsonValue>> {
  const parsed = parseJson(value, field);
  if (!isJsonObject(parsed)) {
    throw new TypeError(`The persisted ${field} value must be a JSON object.`);
  }
  return parsed;
}

function parseHeaders(value: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new TypeError('The persisted headers value is invalid JSON.', { cause });
  }
  if (!isStringRecord(parsed)) {
    throw new TypeError('The persisted headers value must be a string object.');
  }
  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  return validateJsonValue(value, new WeakSet<object>());
}

function validateJsonValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || value === null) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => validateJsonValue(entry, ancestors))
    : isPlainJsonObject(value) &&
      Object.values(value).every((entry) => validateJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value) &&
    isPlainJsonObject(value)
  );
}

function isPlainJsonObject(value: object): value is Readonly<Record<string, JsonValue>> {
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
}

function encodeCursor(event: WebhookEvent): string {
  return Buffer.from(JSON.stringify([event.createdAt, event.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { readonly createdAt: Timestamp; readonly id: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new TypeError('cursor must be a valid event page cursor.', { cause });
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== 'string' ||
    typeof decoded[1] !== 'string'
  ) {
    throw new TypeError('cursor must be a valid event page cursor.');
  }
  return { createdAt: normalizeTimestamp(decoded[0], 'cursor'), id: decoded[1] };
}
