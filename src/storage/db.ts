import Database from 'better-sqlite3';
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError, DatabaseError } from '../types/errors.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const createDatabase = (dbPath: string = ''): Database.Database => {
  if (!dbPath || typeof dbPath !== 'string' || dbPath.trim().length === 0) {
    throw new ValidationError('Database path must be a non-empty string.');
  }

  const normalizedPath = dbPath.trim();

  if (normalizedPath !== ':memory:') {
    const fullPath = resolve(normalizedPath);
    const parentDir = dirname(fullPath);

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const schemaPath = resolve(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new DatabaseError(`Database schema file not found at: ${schemaPath}`);
  }

  let db: Database.Database;
  try {
    db = new Database(normalizedPath);
  } catch (err: unknown) {
    throw new DatabaseError(
      `Failed to connect to SQLite database at '${normalizedPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);

  return db;
};

export default createDatabase;
