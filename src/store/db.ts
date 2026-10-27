// The only module that imports node:sqlite. Every other module gets the database through this adapter.
import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { assertWritablePath, guardedMkdir } from '../config/pathGuard.ts';

export type Db = DatabaseSync;
export type Stmt = StatementSync;

// Loads node:sqlite while swallowing only its own ExperimentalWarning. Any other warning, including
// an ExperimentalWarning about something else, still goes through the original emitWarning.
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  const filtered = ((warning: string | Error, ...rest: unknown[]) => {
    const first = rest[0];
    const type =
      typeof first === 'string'
        ? first
        : first !== null && typeof first === 'object' && 'type' in first
          ? String((first as { type: unknown }).type)
          : warning instanceof Error
            ? warning.name
            : '';
    const text = warning instanceof Error ? warning.message : String(warning);
    if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  process.emitWarning = filtered;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

const sqlite = loadSqlite();

const SIDE_FILES = ['', '-wal', '-shm'];

// Opens (creating when needed) the archive database. The path must be inside the app data folder.
export function openDb(path: string): Db {
  const real = assertWritablePath(path);
  guardedMkdir(dirname(real));
  if (!existsSync(real)) closeSync(openSync(real, 'a', 0o600));
  const db = new sqlite.DatabaseSync(real);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    restrictDbFiles(real);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// Owner only permissions for the database file and its WAL side files, when present.
export function restrictDbFiles(dbFile: string): void {
  for (const suffix of SIDE_FILES) {
    const f = dbFile + suffix;
    if (existsSync(f)) chmodSync(f, 0o600);
  }
}

// Runs fn inside BEGIN IMMEDIATE. Commits on success, rolls back and rethrows on any error.
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn();
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the original error is the useful one
    }
    throw err;
  }
  db.exec('COMMIT');
  return result;
}

const cache = new WeakMap<Db, Map<string, Stmt>>();

// Prepared statements are cached per database, keyed by their SQL text.
export function stmt(db: Db, sql: string): Stmt {
  let m = cache.get(db);
  if (m === undefined) {
    m = new Map();
    cache.set(db, m);
  }
  let s = m.get(sql);
  if (s === undefined) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}
