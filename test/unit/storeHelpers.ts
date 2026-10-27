import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageFact, UsageFact } from '../../src/ingest/facts.ts';
import type { Db } from '../../src/store/db.ts';
import { openAndMigrate } from '../../src/store/migrate.ts';
import { upsertSourceFile } from '../../src/store/repo.ts';

export interface TempEnv {
  dir: string;
  restore: () => void;
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
      rmSync(join(dir, '..'), { recursive: true, force: true });
    },
  };
}

let counter = 0;

// A fresh migrated database in the temp data dir, plus a main and a subagent source file row.
export function freshDb(dir: string): { db: Db; mainFile: number; subFile: number } {
  counter += 1;
  const { db } = openAndMigrate(join(dir, `ledger-${counter}.db`));
  const base = { projectDir: '-work-demo', sessionId: 's1', size: 1, mtimeMs: 1, now: 1 };
  const mainFile = upsertSourceFile(db, { ...base, dev: 1, ino: 1, path: '/src/main.jsonl', agentId: null, isSubagent: false });
  const subFile = upsertSourceFile(db, { ...base, dev: 1, ino: 2, path: '/src/agent-a.jsonl', agentId: 'a', isSubagent: true });
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
