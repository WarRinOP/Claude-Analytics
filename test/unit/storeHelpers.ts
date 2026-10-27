import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageFact, UsageFact } from '../../src/ingest/facts.ts';
import { openDb as openDbRaw, type Db } from '../../src/store/db.ts';
import { openAndMigrate as openAndMigrateRaw, type MigrateOptions, type MigrateResult } from '../../src/store/migrate.ts';
import { upsertSourceFile } from '../../src/store/repo.ts';
import { removeTemp } from './helpers.ts';

export interface TempEnv {
  dir: string;
  restore: () => void;
}

// Every database a test opens through these wrappers is remembered and closed before its temp folder is removed,
// because Windows cannot delete a folder that holds an open database (or its -wal and -shm files).
const opened: Db[] = [];

// Test databases skip the disk sync on commit. Windows syncs on every commit and macOS does not really, so a test that
// commits dozens of times was the slow one there (repo order independence, partial). The tests check what is written,
// never what survives a power cut; the production setting in src/store/db.ts is unchanged.
function fast(db: Db): Db {
  db.exec('PRAGMA synchronous = OFF');
  opened.push(db);
  return db;
}

export function openDb(path: string): Db {
  return fast(openDbRaw(path));
}

export function openAndMigrate(path: string, opts?: MigrateOptions): { db: Db; result: MigrateResult } {
  const r = openAndMigrateRaw(path, opts);
  fast(r.db);
  return r;
}

// Closes every database still open. A database the test already closed is skipped.
export function closeTracked(): void {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
}

// Points LEDGER_DATA_DIR at a fresh folder under the real temp dir.
export function useTempDataDir(): TempEnv {
  const saved = process.env['LEDGER_DATA_DIR'];
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'ledger-store-'))), 'data');
  mkdirSync(dir);
  process.env['LEDGER_DATA_DIR'] = dir;
  return {
    dir,
    restore: () => {
      if (saved === undefined) delete process.env['LEDGER_DATA_DIR'];
      else process.env['LEDGER_DATA_DIR'] = saved;
      closeTracked();
      removeTemp(join(dir, '..'));
    },
  };
}

let counter = 0;

// A fresh migrated database in the temp data dir, plus a main and a subagent source file row.
export function freshDb(dir: string): { db: Db; mainFile: number; subFile: number } {
  counter += 1;
  const { db } = openAndMigrate(join(dir, `ledger-${counter}.db`));
  const base = { projectDir: '-work-demo', sessionId: 's1', size: 1, mtimeMs: 1, now: 1 };
  const mainFile = upsertSourceFile(db, { ...base, dev: 1n, ino: 1n, path: '/src/main.jsonl', agentId: null, isSubagent: false });
  const subFile = upsertSourceFile(db, { ...base, dev: 1n, ino: 2n, path: '/src/agent-a.jsonl', agentId: 'a', isSubagent: true });
  return { db, mainFile, subFile };
}

export function usage(over: Partial<UsageFact> = {}): UsageFact {
  return {
    kind: 'usage',
    sessionId: 's1',
    ts: 1_000,
    isSidechain: false,
    cwd: '/work/demo',
    gitBranch: 'main',
    version: '9.9.9',
    entrypoint: 'cli',
    key: 'msg_1|req_1',
    uuid: 'u1',
    agentId: null,
    isSubagentFile: false,
    model: 'claude-sonnet-5-5',
    input: 10,
    output: 100,
    cacheRead: 1000,
    cacheWrite: 50,
    cacheWrite5m: 20,
    cacheWrite1h: 30,
    thinking: 5,
    webSearch: 0,
    webFetch: 0,
    stopReason: 'end_turn',
    serviceTier: 'standard',
    speed: 'standard',
    inferenceGeo: null,
    rank: 1_000_000_000_000 + 100,
    toolUses: [],
    missingFields: [],
    ...over,
  };
}

export function message(over: Partial<MessageFact> = {}): MessageFact {
  return {
    kind: 'message',
    sessionId: 's1',
    ts: 1_000,
    isSidechain: false,
    cwd: '/work/demo',
    gitBranch: 'main',
    version: '9.9.9',
    entrypoint: 'cli',
    uuid: 'm1',
    messageKind: 'prompt',
    ...over,
  };
}

// All columns of source_files in a form JSON can hold: dev and ino as exact decimal text (a number read from SQLite throws
// above 2^53, and NTFS file ids are 64 bit).
export const SOURCE_FILES_DUMP_SQL =
  'SELECT id, CAST(dev AS TEXT) AS dev, CAST(ino AS TEXT) AS ino, path, project_dir, session_id, agent_id, is_subagent, size, mtime_ms, ' +
  'byte_offset, lines_read, head_hash, status, first_seen_at, last_ingested_at, deleted_detected_at FROM source_files ORDER BY id';

export function dump(db: Db, sql: string): string {
  return JSON.stringify(db.prepare(sql).all());
}

// Small seeded generator so a failing order can be reproduced.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
