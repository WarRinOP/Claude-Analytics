import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { migrate, openAndMigrate } from '../../src/store/migrate.ts';
import { useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

const migrationFiles = readdirSync(join(import.meta.dirname, '../../src/store/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f));

function versions(db: ReturnType<typeof openDb>): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
}

describe('B11 migrations', () => {
  it('applies every file on a fresh database, without a backup', () => {
    const { db, result } = openAndMigrate(join(env.dir, 'ledger.db'));
    expect(result.applied).toEqual(migrationFiles.map((_, i) => i + 1));
    expect(result.backupPath).toBeNull();
    expect(versions(db)).toHaveLength(migrationFiles.length);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ['source_files', 'sessions', 'session_titles', 'usage_events', 'tool_calls', 'missing_fields', 'unknown_types', 'cost_snapshots']) {
      expect(tables).toContain(t);
    }
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('title');
    db.close();
  });

  it('a second run on an already migrated database applies nothing and makes no backup', () => {
    const file = join(env.dir, 'ledger.db');
    openAndMigrate(file).db.close();
    const again = openAndMigrate(file);
    expect(again.result.applied).toEqual([]);
    expect(again.result.backupPath).toBeNull();
    expect(versions(again.db)).toEqual(migrationFiles.map((_, i) => i + 1));
    expect(readdirSync(env.dir).filter((f) => f.includes('.bak-'))).toEqual([]);
    expect(migrate(again.db).applied).toEqual([]);
    again.db.close();
  });

  it('enables WAL, foreign keys and a restricted file mode', () => {
    const file = join(env.dir, 'ledger.db');
    const { db } = openAndMigrate(file);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    db.prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();
    for (const side of ['-wal', '-shm']) {
      if (existsSync(file + side)) expect(statSync(file + side).mode & 0o777).toBe(0o600);
    }
    db.close();
  });
});

describe('B13 backups', () => {
  function extraDir(count: number): string {
    const dir = join(env.dir, 'extra-migrations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE a1 (x INTEGER);');
    for (let v = 2; v <= count; v++) {
      writeFileSync(join(dir, `${String(v).padStart(4, '0')}_more.sql`), `CREATE TABLE a${v} (x INTEGER);`);
    }
    return dir;
  }

  it('copies an existing database before a pending migration, and not before a fresh one', () => {
    const file = join(env.dir, 'ledger.db');
    const day = new Date(2026, 9, 27, 12).getTime();
    const first = openAndMigrate(file, { migrationsDir: extraDir(1), now: () => day });
    expect(first.result.backupPath).toBeNull();
    first.db.prepare("INSERT INTO a1 (x) VALUES (7)").run();
    first.db.close();

    const second = openAndMigrate(file, { migrationsDir: extraDir(2), now: () => day });
    expect(second.result.applied).toEqual([2]);
    expect(second.result.backupPath).toBe(join(env.dir, 'ledger.db.bak-1-20261027'));
    const backup = second.result.backupPath as string;
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    const copy = openDb(backup);
    expect(copy.prepare('SELECT x FROM a1').all().map((r) => (r as { x: number }).x)).toEqual([7]);
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'a2'").all()).toEqual([]);
    copy.close();
    second.db.close();
  });

  it('keeps only the newest three backups', () => {
    const file = join(env.dir, 'ledger.db');
    const day = (d: number) => new Date(2026, 9, d, 12).getTime();
    openAndMigrate(file, { migrationsDir: extraDir(1), now: () => day(20) }).db.close();
    for (let v = 2; v <= 6; v++) {
      openAndMigrate(file, { migrationsDir: extraDir(v), now: () => day(20 + v) }).db.close();
    }
    const backups = readdirSync(env.dir).filter((f) => f.startsWith('ledger.db.bak-')).sort();
    expect(backups).toEqual(['ledger.db.bak-3-20261024', 'ledger.db.bak-4-20261025', 'ledger.db.bak-5-20261026']);
  });

  it('rolls a failing migration back and records nothing for it', () => {
    const file = join(env.dir, 'ledger.db');
    openAndMigrate(file, { migrationsDir: extraDir(1) }).db.close();
    const dir = extraDir(1);
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE ok_table (x INTEGER); CREATE TABLE ok_table (y INTEGER);');
    expect(() => openAndMigrate(file, { migrationsDir: dir })).toThrow();
    const db = openDb(file);
    expect(versions(db)).toEqual([1]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_table'").all()).toEqual([]);
    db.close();
  });
});

describe('path guard on openDb', () => {
  it('refuses a path under ~/.claude and creates nothing', () => {
    const target = join(homedir(), '.claude', 'ledger-test-should-not-exist', 'x.db');
    expect(() => openDb(target)).toThrow(/path guard/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(homedir(), '.claude', 'ledger-test-should-not-exist'))).toBe(false);
  });

  it('refuses a path outside the app data folder', () => {
    expect(() => openDb(join(env.dir, '..', 'elsewhere', 'x.db'))).toThrow(/path guard/);
    expect(existsSync(join(env.dir, '..', 'elsewhere'))).toBe(false);
  });
});
