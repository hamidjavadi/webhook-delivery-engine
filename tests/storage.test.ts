import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import createDatabase from '../src/storage/db';
import { ValidationError } from '../src/types/errors';

describe('Storage / Database Initialization', () => {
  const testDbDir = path.resolve(process.cwd(), 'tmp_test');
  const testDbPath = path.join(testDbDir, 'test_webhook.db');
  let db: Database.Database | null = null;

  afterEach(() => {
    if (db?.open) {
      db.close();
    }
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  describe('Happy Path', () => {
    beforeEach(() => {
      db = createDatabase(testDbPath);
    });

    it('should create database file and enable WAL mode', () => {
      expect(fs.existsSync(testDbPath)).toBe(true);
      const journalMode = db!.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');
    });

    it('should enable foreign keys', () => {
      const foreignKeys = db!.pragma('foreign_keys', { simple: true });
      expect(foreignKeys).toBe(1);
    });

    it('should create required tables (events, delivery_attempts)', () => {
      const tables = db!
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((row: any) => row.name);

      expect(tables).toContain('events');
      expect(tables).toContain('delivery_attempts');
    });

    it('should create required indexes', () => {
      const indexes = db!
        .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
        .all()
        .map((row: any) => row.name);

      expect(indexes).toContain('idx_events_status_next_attempt');
      expect(indexes).toContain('idx_delivery_attempts_event_id');
    });
  });

  describe('Guard Clauses', () => {
    it('should throw ValidationError when dbPath is empty or whitespace', () => {
      expect(() => createDatabase('')).toThrow(ValidationError);
      expect(() => createDatabase('   ')).toThrow(ValidationError);
      expect(() => createDatabase()).toThrow(ValidationError);
      expect(() => createDatabase(undefined)).toThrow(ValidationError);
    });
  });
});
