import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RANK_STOP_BONUS, type CostSnapshotFact, type UsageFact } from '../../src/ingest/facts.ts';
import { mergeUsage } from '../../src/ingest/merge.ts';
import { transaction, type Db } from '../../src/store/db.ts';
import {
  bumpMissingField,
  bumpUnknownType,
  clearFileDiagnostics,
  insertIngestError,
  getSourceFile,
  insertApiError,
  insertCompaction,
  insertMessage,
  markDeleted,
  setOffset,
  setSessionTitle,
  upsertAlias,
  upsertCostSnapshot,
  upsertSession,
  upsertSourceFile,
  upsertUsage,
} from '../../src/store/repo.ts';
import { dump, freshDb, message, rng, shuffled, SOURCE_FILES_DUMP_SQL, usage, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

const USAGE_SQL = 'SELECT * FROM usage_events ORDER BY event_key';
const TOOLS_SQL = 'SELECT * FROM tool_calls ORDER BY tool_use_id';

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('B12 same key from a main and a subagent file', () => {
  const sub = usage({
    isSubagentFile: true,
    isSidechain: true,
    agentId: 'agent-1',
    sessionId: 'sess-sub',
    ts: 500,
    output: 40,
    rank: 40,
    stopReason: null,
    cacheRead: 7,
    toolUses: [{ id: 't_sub', name: 'Read' }],
  });
  const main = usage({ ts: 900, toolUses: [{ id: 't_main', name: 'Bash' }] });

  for (const order of ['sub then main', 'main then sub'] as const) {
    it(`one row, higher rank values, main attribution, earliest ts (${order})`, () => {
      const { db, mainFile, subFile } = freshDb(env.dir);
      const steps: Array<[UsageFact, number]> = order === 'sub then main' ? [[sub, subFile], [main, mainFile]] : [[main, mainFile], [sub, subFile]];
      for (const [f, id] of steps) upsertUsage(db, f, id);
      const rows = db.prepare(USAGE_SQL).all() as Array<Record<string, number | string | null>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        output_tokens: 100,
        cache_read_tokens: 1000,
        stop_reason: 'end_turn',
        rank: main.rank,
        is_subagent_file: 0,
        is_sidechain: 0,
        agent_id: null,
        session_id: 's1',
        source_file_id: mainFile,
        ts: 500,
      });
      expect((db.prepare(TOOLS_SQL).all() as Array<{ tool_use_id: string }>).map((t) => t.tool_use_id)).toEqual(['t_main', 't_sub']);
    });
  }

  it('a subagent line never takes attribution from a main line, and a lower rank never overwrites a higher one', () => {
    const { db, mainFile, subFile } = freshDb(env.dir);
    upsertUsage(db, main, mainFile);
    upsertUsage(db, sub, subFile);
    const row = db.prepare(USAGE_SQL).get() as Record<string, unknown>;
    expect(row).toMatchObject({ source_file_id: mainFile, output_tokens: 100, ts: 500 });
  });
});

describe('idempotence', () => {
  it('the same facts applied twice leave one row in every table', () => {
    const { db, mainFile } = freshDb(env.dir);
    const apply = () => {
      transaction(db, () => {
        upsertUsage(db, usage({ toolUses: [{ id: 't1', name: 'Read' }, { id: 't2', name: 'Bash' }] }), mainFile);
        insertMessage(db, message());
        insertApiError(db, { kind: 'api_error', uuid: 'e1', sessionId: 's1', ts: 5 });
        insertCompaction(db, { kind: 'compaction', uuid: 'c1', sessionId: 's1', ts: 6, trigger: 'auto', preTokens: 123 });
        upsertSession(db, message(), '-work-demo', 10);
        upsertSession(db, usage(), '-work-demo', 10);
        setSessionTitle(db, 's1', 'ai', 'A title', 10);
        upsertCostSnapshot(db, cost(5, 1.5), mainFile);
        bumpUnknownType(db, mainFile, 'future', null, 1, 10);
        bumpMissingField(db, mainFile, 'cache_creation', '1.2.3', 1, 10);
        upsertAlias(db, 'alias-dir', 'real-dir', 10);
        upsertSourceFile(db, { dev: 1n, ino: 1n, path: '/src/main.jsonl', projectDir: '-work-demo', sessionId: 's1', agentId: null, isSubagent: false, size: 1, mtimeMs: 1, now: 1 });
      });
    };
    apply();
    const before = ['usage_events', 'tool_calls', 'messages', 'api_errors', 'compactions', 'sessions', 'projects', 'session_titles', 'cost_snapshots', 'unknown_types', 'missing_fields', 'project_aliases', 'source_files'].map((t) => dump(db, t === 'source_files' ? SOURCE_FILES_DUMP_SQL : `SELECT * FROM ${t}`));
    apply();
    const tables = ['usage_events', 'tool_calls', 'messages', 'api_errors', 'compactions', 'sessions', 'projects', 'session_titles', 'cost_snapshots', 'unknown_types', 'missing_fields', 'project_aliases', 'source_files'];
    for (const t of tables) expect(count(db, t), t).toBe(t === 'tool_calls' ? 2 : 1 + (t === 'source_files' ? 1 : 0));
    // counters are the only tables that add up on purpose
    const after = tables.map((t) => dump(db, t === 'source_files' ? SOURCE_FILES_DUMP_SQL : `SELECT * FROM ${t}`));
    for (let i = 0; i < tables.length; i++) {
      if (tables[i] === 'unknown_types' || tables[i] === 'missing_fields') continue;
      expect(after[i], tables[i]).toBe(before[i]);
    }
  });

  it('a lower rank never overwrites a higher one', () => {
    const { db, mainFile } = freshDb(env.dir);
    upsertUsage(db, usage(), mainFile);
    upsertUsage(db, usage({ output: 5, rank: 5, stopReason: null, model: 'other', input: 1 }), mainFile);
    expect(db.prepare(USAGE_SQL).get()).toMatchObject({ output_tokens: 100, model: 'claude-sonnet-5-5', input_tokens: 10, stop_reason: 'end_turn' });
    upsertUsage(db, usage({ output: 200, rank: RANK_STOP_BONUS + 200, input: 11 }), mainFile);
    expect(db.prepare(USAGE_SQL).get()).toMatchObject({ output_tokens: 200, input_tokens: 11 });
  });
});

interface Line {
  fact: UsageFact;
  file: 'main' | 'sub';
}

// 3 keys, 2 to 4 lines each. Every key has at least one top rank line, some have tied top lines that differ
// only in ts, file and tool ids. Lower lines carry different numbers and values.
function buildLines(rand: () => number): Line[] {
  const lines: Line[] = [];
  let tool = 0;
  for (let k = 0; k < 3; k++) {
    const total = 2 + Math.floor(rand() * 3);
    const tops = 1 + (rand() < 0.6 ? 1 : 0) + (rand() < 0.3 ? 1 : 0);
    for (let i = 0; i < total; i++) {
      const isTop = i < tops;
      const isSub = rand() < 0.5;
      const ts = 1_000 + Math.floor(rand() * 50) * 1000 + k;
      const base = {
        key: `msg_${k}|req_${k}`,
        ts,
        isSubagentFile: isSub,
        isSidechain: isSub,
        agentId: isSub ? `agent-${k}` : null,
        toolUses: [{ id: `tool_${tool++}`, name: ['Read', 'Bash', 'Edit'][tool % 3] as string }],
      };
      const top = { output: 300 + k, rank: RANK_STOP_BONUS + 300 + k, stopReason: 'tool_use', cacheRead: 5000 + k, input: 11 + k };
      const low = {
        output: 20 + i,
        rank: 20 + i,
        stopReason: null,
        cacheRead: 100 + i,
        input: 1 + i,
        version: 'old',
        model: 'claude-low',
      };
      lines.push({ fact: usage({ ...base, ...(isTop ? top : low) }), file: isSub ? 'sub' : 'main' });
    }
  }
  return lines;
}

// Two databases serve all the orders of a round: the rows of the previous order are wiped inside the transaction of the next
// one. (One database per order made this test create and migrate 300 databases, and every upsert was its own commit; Windows
// syncs the disk on each commit and macOS does not, so it took about 30 s there against 1.6 s here.)
function wipeUsage(db: Db): void {
  db.exec('DELETE FROM tool_calls');
  db.exec('DELETE FROM usage_events');
}

describe('order independence', () => {
  it('50 random orders give byte identical rows, equal to folding mergeUsage', () => {
    for (let round = 0; round < 3; round++) {
      const lines = buildLines(rng(1000 + round));
      expect(lines.length).toBeGreaterThanOrEqual(6);
      expect(lines.length).toBeLessThanOrEqual(12);
      let reference: string | null = null;
      let referenceTools: string | null = null;
      const run1 = freshDb(env.dir);
      const run2 = freshDb(env.dir);
      for (let run = 0; run < 50; run++) {
        const order = shuffled(lines, rng(round * 100 + run));
        const { db, mainFile, subFile } = run1;
        transaction(db, () => {
          wipeUsage(db);
          for (const l of order) upsertUsage(db, l.fact, l.file === 'sub' ? subFile : mainFile);
        });
        const rows = dump(db, USAGE_SQL);
        const tools = dump(db, TOOLS_SQL);
        reference ??= rows;
        referenceTools ??= tools;
        expect(rows).toBe(reference);
        expect(tools).toBe(referenceTools);

        // Expected: fold mergeUsage in the same order, then store each folded fact with a single insert.
        const folded = new Map<string, UsageFact>();
        for (const l of order) {
          const have = folded.get(l.fact.key);
          folded.set(l.fact.key, have === undefined ? l.fact : mergeUsage(have, l.fact));
        }
        const expected = run2;
        transaction(expected.db, () => {
          wipeUsage(expected.db);
          for (const f of folded.values()) upsertUsage(expected.db, f, f.isSubagentFile ? expected.subFile : expected.mainFile);
        });
        expect(rows).toBe(dump(expected.db, USAGE_SQL));
        expect(tools).toBe(dump(expected.db, TOOLS_SQL));
      }
      run1.db.close();
      run2.db.close();
      const parsed = JSON.parse(reference as string) as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(3);
      for (const r of parsed) expect(r['rank']).toBeGreaterThanOrEqual(RANK_STOP_BONUS);
    }
  });

  it('keeps the earliest ts and every tool id of tied top lines', () => {
    const { db, mainFile, subFile } = freshDb(env.dir);
    upsertUsage(db, usage({ ts: 300, toolUses: [{ id: 'a', name: 'Read' }] }), mainFile);
    upsertUsage(db, usage({ ts: 100, isSubagentFile: true, agentId: 'x', toolUses: [{ id: 'b', name: 'Read' }] }), subFile);
    upsertUsage(db, usage({ ts: 200, toolUses: [{ id: 'a', name: 'Read' }, { id: 'c', name: 'Bash' }] }), mainFile);
    expect(db.prepare(USAGE_SQL).get()).toMatchObject({ ts: 100, source_file_id: mainFile, is_subagent_file: 0 });
    expect(count(db, 'tool_calls')).toBe(3);
  });
});

describe('sessions', () => {
  const events = [
    message({ uuid: 'a', ts: 1000, cwd: null, entrypoint: 'sdk', version: '1.0.0', gitBranch: null }),
    message({ uuid: 'b', ts: 2000, cwd: '/work/b', entrypoint: 'cli', version: '1.1.0', gitBranch: 'dev' }),
    usage({ ts: 3000, cwd: '/work/c', entrypoint: 'cli', version: '1.2.0', gitBranch: 'main' }),
    usage({ ts: 4000, cwd: '/work/d', entrypoint: 'cli', version: '1.3.0', gitBranch: 'main', key: 'k2|r2' }),
  ];

  it('is the same row and project set in every order of arrival', () => {
    let reference: string | null = null;
    for (let run = 0; run < 24; run++) {
      const { db } = freshDb(env.dir);
      for (const e of shuffled(events, rng(run + 7))) upsertSession(db, e, '-work-demo', 50 + run);
      const snapshot = dump(db, 'SELECT * FROM sessions') + dump(db, 'SELECT project_key, project_dir, display_name FROM projects ORDER BY project_key');
      reference ??= snapshot;
      expect(snapshot).toBe(reference);
      db.close();
    }
    const parsed = JSON.parse((reference as string).split('][')[0] + ']') as Array<Record<string, unknown>>;
    expect(parsed[0]).toMatchObject({
      session_id: 's1',
      project_key: '/work/b',
      first_ts: 1000,
      last_ts: 4000,
      entrypoint: 'sdk',
      first_version: '1.0.0',
      last_version: '1.3.0',
      git_branch: null,
    });
    expect(reference).toContain('"display_name":"b"');
  });

  it('falls back to dir:<project folder> when no event has a cwd', () => {
    const { db } = freshDb(env.dir);
    upsertSession(db, message({ cwd: null }), '-Users-me-proj', 1);
    upsertSession(db, message({ cwd: null, ts: 5000 }), '-Users-me-proj', 2);
    expect(db.prepare('SELECT project_key FROM sessions').get()).toMatchObject({ project_key: 'dir:-Users-me-proj' });
    expect(db.prepare('SELECT project_key, display_name FROM projects').all()).toEqual([
      expect.objectContaining({ project_key: 'dir:-Users-me-proj', display_name: '-Users-me-proj' }),
    ]);
  });

  it('refuses facts that come from a subagent file', () => {
    const { db } = freshDb(env.dir);
    expect(() => upsertSession(db, usage({ isSubagentFile: true }), 'x', 1)).toThrow(/subagent/);
    expect(count(db, 'sessions')).toBe(0);
  });
});

describe('titles', () => {
  it('a custom title is never replaced by an ai title, and the latest call wins within a source', () => {
    const { db } = freshDb(env.dir);
    const title = () => db.prepare('SELECT source, title FROM session_titles WHERE session_id = ?').get('zz');
    setSessionTitle(db, 'zz', 'ai', 'first ai', 1);
    expect(title()).toMatchObject({ source: 'ai', title: 'first ai' });
    setSessionTitle(db, 'zz', 'ai', 'second ai', 2);
    expect(title()).toMatchObject({ title: 'second ai' });
    setSessionTitle(db, 'zz', 'custom', 'mine', 3);
    setSessionTitle(db, 'zz', 'ai', 'late ai', 4);
    expect(title()).toMatchObject({ source: 'custom', title: 'mine' });
    setSessionTitle(db, 'zz', 'custom', 'mine again', 5);
    expect(title()).toMatchObject({ title: 'mine again' });
    expect(count(db, 'sessions')).toBe(0);
  });
});

function cost(duration: number, usd: number): CostSnapshotFact {
  return {
    kind: 'cost_snapshot',
    sessionId: 's1',
    startTime: 1,
    totalDuration: duration,
    totalCostUSD: usd,
    modelUsage: { 'claude-x': { inputTokens: 1, outputTokens: 2, thinkingTokens: 3, cacheReadInputTokens: 4, cacheCreationInputTokens: 5, webSearchRequests: 6, costUSD: usd } },
  };
}

describe('cost snapshots', () => {
  it('keeps the larger duration in either order and stores numbers only', () => {
    for (const order of [[10, 20], [20, 10]] as const) {
      const { db, mainFile } = freshDb(env.dir);
      for (const d of order) upsertCostSnapshot(db, cost(d, d / 10), mainFile);
      const row = db.prepare('SELECT * FROM cost_snapshots').get() as Record<string, unknown>;
      expect(row['total_duration_ms']).toBe(20);
      expect(row['total_cost_usd']).toBe(2);
      expect(JSON.parse(row['model_usage_json'] as string)).toEqual({
        'claude-x': { inputTokens: 1, outputTokens: 2, thinkingTokens: 3, cacheReadInputTokens: 4, cacheCreationInputTokens: 5, webSearchRequests: 6, costUSD: 2 },
      });
      db.close();
    }
  });

  it('an equal duration keeps the stored snapshot', () => {
    const { db, mainFile } = freshDb(env.dir);
    upsertCostSnapshot(db, cost(10, 1), mainFile);
    upsertCostSnapshot(db, cost(10, 9), mainFile);
    expect(db.prepare('SELECT total_cost_usd AS c FROM cost_snapshots').get()).toMatchObject({ c: 1 });
  });
});

describe('source files, counters, aliases', () => {
  it('upserts by (dev, ino), refreshes path and goes back to active', () => {
    const { db } = freshDb(env.dir);
    const input = { dev: 9n, ino: 99n, path: '/a/one.jsonl', projectDir: 'p', sessionId: 's', agentId: null, isSubagent: false, size: 10, mtimeMs: 20, now: 30 };
    const id = upsertSourceFile(db, input);
    setOffset(db, id, 10, 2, 'abc', 10, 20, 31);
    markDeleted(db, id, 40);
    expect(getSourceFile(db, 9n, 99n)).toMatchObject({ status: 'deleted', deletedDetectedAt: 40, byteOffset: 10, linesRead: 2, headHash: 'abc', lastIngestedAt: 31 });
    const again = upsertSourceFile(db, { ...input, path: '/b/two.jsonl', size: 50, mtimeMs: 60, now: 70 });
    expect(again).toBe(id);
    expect(getSourceFile(db, 9n, 99n)).toMatchObject({ path: '/b/two.jsonl', size: 50, mtimeMs: 60, status: 'active', deletedDetectedAt: null, byteOffset: 10, firstSeenAt: 30 });
    expect(getSourceFile(db, 1n, 12345n)).toBeUndefined();
  });

  it('counts add up per file, a null version is stored as an empty string, clearing is per file', () => {
    const { db, mainFile, subFile } = freshDb(env.dir);
    bumpUnknownType(db, mainFile, 'future', null, 2, 10);
    bumpUnknownType(db, mainFile, 'future', null, 3, 5);
    bumpUnknownType(db, subFile, 'future', null, 4, 7);
    bumpMissingField(db, mainFile, 'speed', '1.0', 1, 10);
    bumpMissingField(db, mainFile, 'speed', '1.0', 1, 20);
    bumpMissingField(db, subFile, 'speed', '1.0', 1, 20);
    insertIngestError(db, { runId: 1, sourceFileId: mainFile, lineNo: 3, byteOffset: 9, lineLength: 4, error: 'invalid json', at: 1 });
    insertIngestError(db, { runId: 1, sourceFileId: subFile, lineNo: 1, byteOffset: 0, lineLength: 4, error: 'invalid json', at: 1 });
    expect(db.prepare('SELECT * FROM unknown_types WHERE source_file_id = ?').all(mainFile)).toEqual([expect.objectContaining({ type: 'future', version: '', count: 5, last_seen_at: 10 })]);
    expect(db.prepare('SELECT * FROM missing_fields WHERE source_file_id = ?').all(mainFile)).toEqual([expect.objectContaining({ field: 'speed', version: '1.0', count: 2, last_seen_at: 20 })]);
    clearFileDiagnostics(db, mainFile);
    expect(db.prepare('SELECT source_file_id FROM unknown_types').all()).toEqual([{ source_file_id: subFile }]);
    expect(db.prepare('SELECT source_file_id FROM missing_fields').all()).toEqual([{ source_file_id: subFile }]);
    expect(db.prepare('SELECT source_file_id FROM ingest_errors').all()).toEqual([{ source_file_id: subFile }]);
    upsertAlias(db, 'alias', 'target', 1);
    upsertAlias(db, 'alias', 'target2', 2);
    expect(db.prepare('SELECT * FROM project_aliases').all()).toEqual([expect.objectContaining({ alias_dir: 'alias', target_dir: 'target2', seen_at: 2 })]);
  });
});
