import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIngest, type IngestOptions } from '../../src/ingest/ingest.ts';
import { acquireLock, LockHeldError, lockPath } from '../../src/ingest/lock.ts';
import type { Db } from '../../src/store/db.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { dump, openAndMigrate, SOURCE_FILES_DUMP_SQL, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';
import { removeTemp } from '../unit/helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'src', 'cli.ts');

let env: TempEnv;
let work: string;
let dbCounter = 0;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-ingest-')));
});
afterEach(() => {
  env.restore();
  removeTemp(work);
});

// ---------------------------------------------------------------- synthetic transcripts

const unknownLine = (v = '9.9.9'): string => JSON.stringify({ type: 'future-thing', version: v, payload: 'SECRET' });
const costLine = (sid: string, dur: number, tokens: number): string =>
  JSON.stringify({
    type: 'cost-state',
    sessionId: sid,
    startTime: 1,
    totalCostUSD: 1,
    totalDuration: dur,
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1 } },
  });
const compactLine = (sid: string, id: string, ts: number): string =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: id, sessionId: sid, timestamp: new Date(Date.UTC(2026, 9, 1, 11, 0, 0) + ts * 1000).toISOString(), compactMetadata: { trigger: 'auto', preTokens: 5 } });

const SID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SID_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const SID_C = 'cccccccc-0000-0000-0000-000000000003';

// Main file A: streaming lines, tool uses, a compaction in the middle, bad lines, a title, a cost-state.
function mainA(): string[] {
  const lines: string[] = [userLine(SID_A, 'u1', 0), unknownLine(), 'this is not json {'];
  for (let n = 1; n <= 6; n++) {
    lines.push(usageLine(SID_A, n, { out: 3, ts: n * 10, tools: [`tool_${n}`] }));
    lines.push(usageLine(SID_A, n, { out: 40 + n, stop: true, ts: n * 10 + 1 }));
    if (n === 3) lines.push(compactLine(SID_A, 'c1', 35), userLine(SID_A, 'u-compact', 36, { isCompactSummary: true }));
  }
  lines.push(JSON.stringify({ type: 'ai-title', sessionId: SID_A, aiTitle: 'A title' }), costLine(SID_A, 5000, 9999), costLine(SID_A, 9000, 10 + 1 + 10 + 2));
  return lines;
}

function buildTree(root: string): { mainA: string; subA: string; mainB: string; empty: string } {
  const mainAPath = join(root, '-work-demo', `${SID_A}.jsonl`);
  const subPath = join(root, '-work-demo', SID_A, 'subagents', 'agent-x1.jsonl');
  const mainBPath = join(root, '-work-other', `${SID_B}.jsonl`);
  const emptyPath = join(root, '-work-demo', `${SID_C}.jsonl`);
  put(mainAPath, mainA());
  // The subagent file holds its own events and a fork copy of A's key 2.
  put(subPath, [usageLine(SID_A, 100, { out: 7, stop: true, subagent: true, tools: ['tool_sub'] }), usageLine(SID_A, 2, { out: 42, stop: true, ts: 21, subagent: true }), unknownLine('1.0.0')]);
  put(mainBPath, [userLine(SID_B, 'ub1', 1, {}, '/work/other'), usageLine(SID_B, 200, { out: 11, stop: true, cwd: '/work/other' }), JSON.stringify({ type: 'mode' })]);
  writeFileSync(emptyPath, '');
  return { mainA: mainAPath, subA: subPath, mainB: mainBPath, empty: emptyPath };
}

// ---------------------------------------------------------------- helpers

function openDb(): Db {
  dbCounter += 1;
  return openAndMigrate(join(env.dir, `ingest-${dbCounter}.db`)).db;
}

const NOW = () => 1_000;

function opts(roots: string[], over: Partial<IngestOptions> = {}): IngestOptions {
  return { roots, full: false, trigger: 'test', now: NOW, ...over };
}

const FACT_TABLES = ['usage_events', 'tool_calls', 'messages', 'api_errors', 'compactions', 'sessions', 'projects', 'session_titles', 'cost_snapshots'];
const COUNTER_SQL = [
  'SELECT * FROM unknown_types ORDER BY type, version, source_file_id',
  'SELECT * FROM missing_fields ORDER BY field, version, source_file_id',
  'SELECT source_file_id, line_no, byte_offset, line_length, error FROM ingest_errors ORDER BY source_file_id, line_no',
];

// `noIds` drops the source file id columns, which depend on the order files were first seen.
function factsDump(db: Db, noIds = false): string[] {
  const order: Record<string, string> = { usage_events: 'event_key', tool_calls: 'tool_use_id', messages: 'uuid', api_errors: 'uuid', compactions: 'uuid', sessions: 'session_id', projects: 'project_key', session_titles: 'session_id', cost_snapshots: 'session_id' };
  return FACT_TABLES.map((t) => {
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY ${order[t]}`).all() as Array<Record<string, unknown>>;
    if (noIds) for (const r of rows) { delete r['source_file_id']; delete r['captured_from_file_id']; }
    return JSON.stringify(rows);
  });
}

function everything(db: Db): string[] {
  return [
    ...factsDump(db),
    ...COUNTER_SQL.map((q) => dump(db, q)),
    dump(db, 'SELECT * FROM project_aliases ORDER BY alias_dir'),
    dump(db, SOURCE_FILES_DUMP_SQL),
  ];
}

function n(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function totals(db: Db): { rows: number; sum: number } {
  const r = db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS sum FROM usage_events').get() as { rows: number; sum: number };
  return r;
}

// ---------------------------------------------------------------- tests

describe('basic pass', () => {
  it('writes sessions, events, messages and diagnostics, never any content', async () => {
    const root = join(work, 'projects');
    buildTree(root);
    const db = openDb();
    const sum = await runIngest(db, opts([root]));
    expect(sum.filesScanned).toBe(4);
    expect(sum.errors).toBe(1);
    // 7 distinct keys in A (1..6 plus 2 shared with the subagent copy), 100 in the subagent file, 200 in B
    expect(n(db, 'SELECT COUNT(*) AS n FROM usage_events')).toBe(8);
    expect(n(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(2);
    expect(n(db, `SELECT has_subagents AS n FROM sessions WHERE session_id = '${SID_A}'`)).toBe(1);
    expect(n(db, `SELECT has_subagents AS n FROM sessions WHERE session_id = '${SID_B}'`)).toBe(0);
    expect(db.prepare('SELECT line_no, error FROM ingest_errors').all()).toEqual([{ line_no: 3, error: 'invalid json' }]);
    expect(n(db, 'SELECT COUNT(*) AS n FROM tool_calls')).toBe(7);
    expect(db.prepare('SELECT trigger, finished_at, files_scanned FROM ingest_runs').all()).toEqual([{ trigger: 'test', finished_at: 1000, files_scanned: 4 }]);
    const all = JSON.stringify(everything(db)) + JSON.stringify(db.prepare('SELECT * FROM ingest_runs').all());
    expect(all).not.toContain('SECRET');
  });

  it('ingesting twice leaves every fact and counter table identical', async () => {
    const root = join(work, 'projects');
    buildTree(root);
    const db = openDb();
    await runIngest(db, opts([root]));
    const before = everything(db);
    const second = await runIngest(db, opts([root]));
    expect(second.filesChanged).toBe(0);
    expect(everything(db)).toEqual(before);
  });

  it('--full twice gives identical tables, and the same facts as a plain pass', async () => {
    const root = join(work, 'projects');
    buildTree(root);
    const plain = openDb();
    await runIngest(plain, opts([root]));
    const db = openDb();
    await runIngest(db, opts([root], { full: true }));
    const once = everything(db);
    expect(factsDump(db)).toEqual(factsDump(plain));
    await runIngest(db, opts([root], { full: true }));
    expect(everything(db)).toEqual(once);
  });

  it('appends are read from the stored offset and a partial last line waits', async () => {
    const root = join(work, 'projects');
    const t = buildTree(root);
    const db = openDb();
    await runIngest(db, opts([root]));
    const base = totals(db).rows;
    const line = usageLine(SID_B, 300, { out: 9, stop: true, cwd: '/work/other' });
    appendFileSync(t.mainB, line.slice(0, 50));
    await runIngest(db, opts([root]));
    expect(totals(db).rows).toBe(base);
    appendFileSync(t.mainB, line.slice(50) + '\n');
    const sum = await runIngest(db, opts([root]));
    expect(totals(db).rows).toBe(base + 1);
    expect(sum.linesRead).toBe(1);
    await runIngest(db, opts([root]));
    expect(totals(db).rows).toBe(base + 1);
  });
});

describe('C16 and C17 truncate or replace a file', () => {
  it('a truncated file is reread, totals stay, diagnostics are not doubled', async () => {
    const root = join(work, 'projects');
    const t = buildTree(root);
    const db = openDb();
    await runIngest(db, opts([root]));
    const before = totals(db);
    const errorsBefore = n(db, 'SELECT COUNT(*) AS n FROM ingest_errors');
    const unknownBefore = n(db, 'SELECT SUM(count) AS n FROM unknown_types');
    // keep the first five lines (they include the unknown type line and the bad line)
    const keep = mainA().slice(0, 5);
    put(t.mainA, keep);
    const sum = await runIngest(db, opts([root]));
    expect(sum.filesChanged).toBe(1);
    expect(totals(db)).toEqual(before);
    expect(n(db, 'SELECT COUNT(*) AS n FROM ingest_errors')).toBe(errorsBefore);
    expect(n(db, 'SELECT SUM(count) AS n FROM unknown_types')).toBe(unknownBefore);
    // the same file, restored, is an append of nothing new beyond the old state: totals still equal
    put(t.mainA, mainA());
    await runIngest(db, opts([root]));
    expect(totals(db)).toEqual(before);
    expect(n(db, 'SELECT COUNT(*) AS n FROM ingest_errors')).toBe(errorsBefore);
    expect(n(db, 'SELECT SUM(count) AS n FROM unknown_types')).toBe(unknownBefore);
  });

  it('a file replaced in place (different first bytes) is reread with the same facts', async () => {
    const root = join(work, 'projects');
    const t = buildTree(root);
    const db = openDb();
    await runIngest(db, opts([root]));
    const before = everything(db).slice(0, 9);
    const errorsBefore = n(db, 'SELECT COUNT(*) AS n FROM ingest_errors');
    const unknownBefore = n(db, 'SELECT SUM(count) AS n FROM unknown_types');
    // same lines, one extra harmless field on every record, so the file is larger and its head differs
    const bigger = mainA().map((l) => (l.startsWith('{') ? l.replace(/^\{/, '{"extra":"zzzzzzzzzzzzzzzzzzzz",') : l));
    put(t.mainA, bigger);
    const sum = await runIngest(db, opts([root]));
    expect(sum.filesChanged).toBe(1);
    expect(sum.linesRead).toBe(bigger.length);
    expect(everything(db).slice(0, 9)).toEqual(before);
    expect(n(db, 'SELECT COUNT(*) AS n FROM ingest_errors')).toBe(errorsBefore);
    expect(n(db, 'SELECT SUM(count) AS n FROM unknown_types')).toBe(unknownBefore);
  });

  it('a file that became empty clears its diagnostics and is not reread again', async () => {
    const root = join(work, 'projects');
    const t = buildTree(root);
    const db = openDb();
    await runIngest(db, opts([root]));
    const rows = totals(db).rows;
    truncateSync(t.mainA, 0);
    await runIngest(db, opts([root]));
    expect(totals(db).rows).toBe(rows);
    const id = (db.prepare('SELECT id FROM source_files WHERE path = ?').get(t.mainA) as { id: number }).id;
    expect(n(db, `SELECT COUNT(*) AS n FROM ingest_errors WHERE source_file_id = ${id}`)).toBe(0);
    expect(n(db, `SELECT byte_offset AS n FROM source_files WHERE id = ${id}`)).toBe(0);
    const again = await runIngest(db, opts([root]));
    expect(again.filesChanged).toBe(0);
  });
});

describe('C20 interrupted pass', () => {
  it('a throw inside the transaction after N batches, then a rerun, equals an uninterrupted run', async () => {
    const root = join(work, 'projects');
    buildTree(root);
    const read = { batchBytes: 700, blockBytes: 300 };
    const clean = openDb();
    const cleanSum = await runIngest(clean, opts([root], { read }));
    expect(cleanSum.filesChanged).toBe(4);

    for (const failAt of [1, 2, 5, 9]) {
      const db = openDb();
      let batches = 0;
      await expect(
        runIngest(db, opts([root], { read, faultInTransaction: (info) => { batches = info.batchNo; if (info.batchNo === failAt) throw new Error('simulated crash'); } })),
      ).rejects.toThrow('simulated crash');
      expect(batches).toBe(failAt);
      // the failed run is closed out
      expect(n(db, 'SELECT COUNT(*) AS n FROM ingest_runs WHERE finished_at IS NOT NULL')).toBe(1);
      // earlier batches are kept, the failed one left nothing behind
      expect(totals(db).rows).toBeLessThan(totals(clean).rows);
      await runIngest(db, opts([root], { read }));
      expect(everything(db)).toEqual(everything(clean));
    }
  });

  it('a throw right after a commit (between two chunks) also recovers', async () => {
    const root = join(work, 'projects');
    buildTree(root);
    const read = { batchBytes: 700, blockBytes: 300 };
    const clean = openDb();
    await runIngest(clean, opts([root], { read }));
    const db = openDb();
    await expect(runIngest(db, opts([root], { read, onBatchCommitted: (info) => { if (info.batchNo === 3) throw new Error('killed'); } }))).rejects.toThrow('killed');
    await runIngest(db, opts([root], { read }));
    expect(everything(db)).toEqual(everything(clean));
  });
});

describe('C22 fork copy', () => {
  it('the same key in a main and a subagent file counts once, with main file attribution', async () => {
    const root = join(work, 'projects');
    const t = buildTree(root);
    const db = openDb();
    await runIngest(db, opts([root]));
    const row = db.prepare("SELECT is_subagent_file, source_file_id, session_id, output_tokens FROM usage_events WHERE event_key = 'msg_2|req_2'").get() as Record<string, number | string>;
    expect(row['is_subagent_file']).toBe(0);
    expect(row['output_tokens']).toBe(42);
    const mainId = (db.prepare('SELECT id FROM source_files WHERE path = ?').get(t.mainA) as { id: number }).id;
    expect(row['source_file_id']).toBe(mainId);
    expect(n(db, "SELECT COUNT(*) AS n FROM usage_events WHERE event_key = 'msg_2|req_2'")).toBe(1);
  });

  it('attribution moves to the main file when it shows up after the subagent copy', async () => {
    const root = join(work, 'projects');
    const t = buildTree(root);
    const hidden = join(work, 'hidden-main.jsonl');
    cpSync(t.mainA, hidden);
    rmSync(t.mainA);
    const db = openDb();
    await runIngest(db, opts([root]));
    expect(db.prepare("SELECT is_subagent_file AS s FROM usage_events WHERE event_key = 'msg_2|req_2'").get()).toEqual({ s: 1 });
    expect(n(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1); // only B: subagent files never create a session
    cpSync(hidden, t.mainA);
    await runIngest(db, opts([root]));
    expect(db.prepare("SELECT is_subagent_file AS s FROM usage_events WHERE event_key = 'msg_2|req_2'").get()).toEqual({ s: 0 });
    const clean = openDb();
    rmSync(t.mainA);
    cpSync(hidden, t.mainA);
    await runIngest(clean, opts([root]));
    expect(factsDump(db, true)).toEqual(factsDump(clean, true));
  });
});

describe('C23 compaction mid file', () => {
  it('lines before and after the compaction are counted once each, across batches', async () => {
    const root = join(work, 'projects');
    buildTree(root);
    const db = openDb();
    await runIngest(db, opts([root], { read: { batchBytes: 500, blockBytes: 200 } }));
    expect(n(db, 'SELECT COUNT(*) AS n FROM compactions')).toBe(1);
    expect(n(db, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'compact_summary'")).toBe(1);
    for (const key of ['msg_1|req_1', 'msg_3|req_3', 'msg_4|req_4', 'msg_6|req_6']) {
      expect(n(db, `SELECT COUNT(*) AS n FROM usage_events WHERE event_key = '${key}'`), key).toBe(1);
    }
    const before = everything(db);
    await runIngest(db, opts([root], { read: { batchBytes: 500, blockBytes: 200 } }));
    expect(everything(db)).toEqual(before);
  });
});

describe('C24 empty file', () => {
  it('creates no session and no event, and is not reread', async () => {
    const root = join(work, 'projects');
    mkdirSync(join(root, '-work-demo'), { recursive: true });
    writeFileSync(join(root, '-work-demo', `${SID_C}.jsonl`), '');
    writeFileSync(join(root, '-work-demo', `${SID_B}.jsonl`), '\n\n');
    const db = openDb();
    const sum = await runIngest(db, opts([root]));
    expect(sum.filesScanned).toBe(2);
    expect(n(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    expect(n(db, 'SELECT COUNT(*) AS n FROM usage_events')).toBe(0);
    expect(n(db, 'SELECT COUNT(*) AS n FROM source_files')).toBe(2);
    expect(n(db, 'SELECT COUNT(*) AS n FROM ingest_errors')).toBe(0);
  });
});

describe('second root', () => {
  it('a copy of the tree as a second root changes no usage, message, session or tool call', async () => {
    const root = join(work, 'projects');
    buildTree(root);
    const copy = join(work, 'copy', 'projects');
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(root, copy, { recursive: true });
    const one = openDb();
    await runIngest(one, opts([root]));
    const both = openDb();
    const sum = await runIngest(both, opts([root, copy]));
    expect(sum.filesScanned).toBe(8);
    expect(factsDump(both, true)).toEqual(factsDump(one, true));
    // and again on an archive that already holds the first root
    const sum2 = await runIngest(one, opts([root, copy]));
    expect(sum2.filesScanned).toBe(8);
    expect(factsDump(one, true)).toEqual(factsDump(both, true));
    expect(n(one, 'SELECT COUNT(*) AS n FROM source_files')).toBe(8);
  });
});

describe('F41 source files are not touched', () => {
  function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${p} ${createHash('sha256').update(readFileSync(p)).digest('hex')} ${statSync(p).mtimeMs}`);
      }
    };
    walk(dir);
    return out;
  }

  it('SHA 256 and mtime of every source file are unchanged after ingest', async () => {
    const root = join(work, 'projects');
    buildTree(root);
    const before = snapshot(root);
    const db = openDb();
    await runIngest(db, opts([root]));
    await runIngest(db, opts([root], { full: true }));
    await runIngest(db, opts([root], { read: { batchBytes: 300, blockBytes: 100 } }));
    expect(snapshot(root)).toEqual(before);
    expect(before).toHaveLength(4);
  });
});

describe('lock', () => {
  it('a live owner blocks, a dead owner is replaced, release removes the file', () => {
    const release = acquireLock(process.ppid);
    expect(readFileSync(lockPath(), 'utf8').trim()).toBe(String(process.ppid));
    expect(() => acquireLock()).toThrow(LockHeldError);
    release();
    expect(() => readFileSync(lockPath())).toThrow();

    const dead = spawnSync(process.execPath, ['-e', '0']);
    expect(dead.pid).toBeGreaterThan(0);
    writeFileSync(lockPath(), `${dead.pid}\n`);
    const rel2 = acquireLock();
    expect(readFileSync(lockPath(), 'utf8').trim()).toBe(String(process.pid));
    rel2();

    writeFileSync(lockPath(), 'garbage');
    const rel3 = acquireLock();
    rel3();
  });
});

describe('cli', () => {
  function cli(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, LEDGER_DATA_DIR: env.dir, CLAUDE_CONFIG_DIR: join(work, 'cfg'), ...extraEnv },
    });
  }

  it('ingest and verify print short counts only; a second root changes nothing; a live lock gives exit 2', () => {
    const live = join(work, 'cfg', 'projects');
    buildTree(live);
    const copy = join(work, 'copy', 'projects');
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(live, copy, { recursive: true });

    const first = cli(['ingest', '--full']);
    expect(first.status, first.stderr).toBe(0);
    const lines1 = first.stdout.trim().split('\n');
    expect(lines1.length).toBeLessThanOrEqual(12);
    expect(first.stdout).toContain('usage_events rows: 8');
    expect(first.stdout).not.toContain('SECRET');

    const again = cli(['ingest']);
    expect(again.status, again.stderr).toBe(0);
    const withCopy = cli(['ingest', '--root', copy]);
    expect(withCopy.status, withCopy.stderr).toBe(0);
    const sumLine = (s: string): string => s.split('\n').filter((l) => l.startsWith('usage_events rows') || l.startsWith('sum:') || l.startsWith('input:')).join('|');
    expect(sumLine(withCopy.stdout)).toBe(sumLine(first.stdout));

    const v = cli(['verify']);
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout.trim().split('\n').length).toBeLessThanOrEqual(30);
    expect(v.stdout).toContain('Variant A');
    expect(v.stdout).toContain('Variant B');

    const missing = cli(['ingest', '--root', join(work, 'nope')]);
    expect(missing.status).toBe(1);

    writeFileSync(join(env.dir, 'ingest.lock'), `${process.ppid}\n`);
    const blocked2 = cli(['ingest']);
    expect(blocked2.status).toBe(2);
    expect(blocked2.stderr).toContain('already running');
  });
});
