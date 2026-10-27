import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWritablePath } from '../config/pathGuard.ts';
import { ensureCosts } from './costs.ts';
import { openDb, transaction, type Db } from './db.ts';

export const BACKUPS_KEPT = 3;

export interface MigrateOptions {
  // Folder holding NNNN_name.sql files. Defaults to the folder next to this module.
  migrationsDir?: string;
  // Clock for applied_at and the backup date. Injectable for tests.
  now?: () => number;
  // Make a VACUUM INTO backup first when migrations are pending. Set false for a file that did not exist before.
  backup?: boolean;
}

export interface MigrateResult {
  applied: number[];
  backupPath: string | null;
}

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

const FILE_RE = /^(\d{4})_[A-Za-z0-9_]+\.sql$/;

export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'migrations');
}

export function readMigrations(dir: string): MigrationFile[] {
  const out: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const name of readdirSync(dir).sort()) {
    const m = FILE_RE.exec(name);
    if (m === null) continue;
    const version = Number(m[1]);
    if (seen.has(version)) throw new Error(`migrations: duplicate version ${version}`);
    seen.add(version);
    out.push({ version, name, sql: readFileSync(join(dir, name), 'utf8') });
  }
  return out.sort((a, b) => a.version - b.version);
}

function ymd(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function appliedVersions(db: Db): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(
    (r) => r.version,
  );
}

const BACKUP_RE = /^ledger\.db\.bak-(\d+)-(\d{8})$/;

// Keeps the newest backups by (date, version), deleting the rest. Only names this module creates are touched.
export function pruneBackups(dbFile: string, keep: number = BACKUPS_KEPT): string[] {
  const dir = dirname(dbFile);
  const found = readdirSync(dir)
    .map((name) => ({ name, m: BACKUP_RE.exec(name) }))
    .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
    .map((e) => ({
      name: e.name,
      date: e.m[2] as string,
      version: Number(e.m[1]),
      mtime: statSync(join(dir, e.name)).mtimeMs,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.version - a.version || b.mtime - a.mtime);
  const removed: string[] = [];
  for (const old of found.slice(keep)) {
    const p = assertWritablePath(join(dir, old.name));
    rmSync(p, { force: true });
    removed.push(p);
  }
  return removed;
}

// Applies every pending migration, each in its own transaction. A second run applies nothing.
// When `backup` is true and something is pending, the database is first copied with VACUUM INTO.
export function migrate(db: Db, opts: MigrateOptions = {}): MigrateResult {
  const now = opts.now ?? Date.now;
  const files = readMigrations(opts.migrationsDir ?? defaultMigrationsDir());
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(appliedVersions(db));
  const pending = files.filter((f) => !done.has(f.version));
  const result: MigrateResult = { applied: [], backupPath: null };
  if (pending.length === 0) return result;

  if (opts.backup === true) {
    const location = db.location();
    if (location === null || location === undefined || location === '') throw new Error('migrate: cannot back up an in memory database');
    const heldVersion = done.size === 0 ? 0 : Math.max(...done);
    const target = assertWritablePath(join(dirname(location), `${basename(location)}.bak-${heldVersion}-${ymd(now())}`));
    rmSync(target, { force: true });
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    chmodSync(target, 0o600);
    result.backupPath = target;
    pruneBackups(location);
  }

  for (const f of pending) {
    transaction(db, () => {
      db.exec(f.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f.version, now());
    });
    result.applied.push(f.version);
  }
  return result;
}

// Opens the database at `path` and migrates it. A file that already existed is backed up first when needed.
// Stored costs are then brought up to the price table in the code (first start after migration 3, or a changed table).
export function openAndMigrate(path: string, opts: MigrateOptions = {}): { db: Db; result: MigrateResult } {
  const real = assertWritablePath(path);
  const existed = existsSync(real) && statSync(real).size > 0;
  const db = openDb(path);
  try {
    const result = migrate(db, { ...opts, backup: opts.backup ?? existed });
    ensureCosts(db);
    return { db, result };
  } catch (err) {
    db.close();
    throw err;
  }
}
