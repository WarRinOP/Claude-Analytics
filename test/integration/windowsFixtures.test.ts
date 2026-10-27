// Transcripts as Claude Code writes them on Windows: Windows style cwd values in three spellings, project folders named after the
// drive letter as typed (C--Users-me-My-Project and c--Users-me-My-Project), a non ASCII folder name, a subagent file with a fork
// copy, and CRLF line endings. The files in test/fixtures/windows are synthetic and neutral. Only the CRLF file is converted
// at run time (git keeps the repository files LF); the two drive letter folders are one folder on a case insensitive disk and
// two folders on a case sensitive one, and the test holds in both cases.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover } from '../../src/ingest/discover.ts';
import { runIngest } from '../../src/ingest/ingest.ts';
import type { Db } from '../../src/store/db.ts';
import { openAndMigrate, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';
import { removeTemp } from '../unit/helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'windows');
const REFERENCE = join(ROOT, 'scripts', 'reference_totals.py');

const SID_U = 'c0000001-0000-0000-0000-00000000000a';
const SID_L = 'c0000002-0000-0000-0000-00000000000b';
const SID_N = 'c0000003-0000-0000-0000-00000000000c';

const KEY_MY = 'C:\\Users\\me\\My Project';
const KEY_CAFE = 'C:\\Users\\me\\Café Résumé';

let env: TempEnv;
let work: string;
let root: string;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-winfix-')));
  root = join(work, 'projects');
});
afterEach(() => {
  env.restore();
  removeTemp(work);
});

function copyFixture(name: string, to: string, crlf = false): void {
  const text = readFileSync(join(FIXTURES, name), 'utf8');
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, crlf ? text.replace(/\r?\n/g, '\r\n') : text);
}

function buildTree(): void {
  copyFixture('upper.jsonl', join(root, 'C--Users-me-My-Project', `${SID_U}.jsonl`));
  copyFixture('upper-agent.jsonl', join(root, 'C--Users-me-My-Project', SID_U, 'subagents', 'agent-w1.jsonl'));
  copyFixture('lower.jsonl', join(root, 'c--Users-me-My-Project', `${SID_L}.jsonl`));
  copyFixture('unicode.jsonl', join(root, 'C--Users-me-Caf--R-sum-', `${SID_N}.jsonl`), true);
}

let dbCounter = 0;
async function ingested(): Promise<Db> {
  buildTree();
  dbCounter += 1;
  const { db } = openAndMigrate(join(env.dir, `win-${dbCounter}.db`));
  const r = await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => 1_000 });
  expect(r.errors).toBe(0);
  return db;
}

describe('Windows style transcripts', () => {
  it('the fixture set is what the test says it is: CRLF in one file, LF in the others, three cwd spellings', () => {
    buildTree();
    const raw = (p: string): string => readFileSync(p, 'utf8');
    expect(raw(join(root, 'C--Users-me-Caf--R-sum-', `${SID_N}.jsonl`))).toContain('\r\n');
    expect(raw(join(root, 'C--Users-me-Caf--R-sum-', `${SID_N}.jsonl`))).toContain('Café Résumé');
    expect(raw(join(root, 'C--Users-me-My-Project', `${SID_U}.jsonl`))).not.toContain('\r');
    expect(raw(join(root, 'C--Users-me-My-Project', `${SID_U}.jsonl`))).toContain('"cwd":"C:\\\\Users\\\\me\\\\My Project"');
    expect(raw(join(root, 'c--Users-me-My-Project', `${SID_L}.jsonl`))).toContain('"cwd":"c:/Users/me/My Project"');
    const d = discover(root);
    expect(d.skipped).toEqual([]);
    expect(d.files.map((f) => [f.sessionId, f.isSubagent])).toEqual(
      expect.arrayContaining([[SID_U, false], [SID_U, true], [SID_L, false], [SID_N, false]]),
    );
    expect(d.files).toHaveLength(4);
  });

  it('both drive letter spellings are one project, with the folder name as its label, and the non ASCII folder is another', async () => {
    const db = await ingested();
    expect(db.prepare('SELECT project_key, display_name FROM projects ORDER BY project_key').all()).toEqual([
      { project_key: KEY_CAFE, display_name: 'Café Résumé' },
      { project_key: KEY_MY, display_name: 'My Project' },
    ]);
    expect(db.prepare('SELECT session_id, project_key FROM sessions ORDER BY session_id').all()).toEqual([
      { session_id: SID_U, project_key: KEY_MY },
      { session_id: SID_L, project_key: KEY_MY },
      { session_id: SID_N, project_key: KEY_CAFE },
    ]);
  });

  it('reads the CRLF file completely, without a parse error, and a second pass reads nothing', async () => {
    const db = await ingested();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ingest_errors').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE session_id = ?').get(SID_N)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(SID_N)).toEqual({ n: 1 });
    const again = await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => 2_000 });
    expect(again).toMatchObject({ filesScanned: 4, filesChanged: 0, eventsUpserted: 0, errors: 0 });
    const full = await runIngest(db, { roots: [root], full: true, trigger: 'test', now: () => 3_000 });
    expect(full.errors).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 8 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 2 });
  });

  it('counts the fork copy in the subagent file once', async () => {
    const db = await ingested();
    // upper.jsonl: 3 keys, lower.jsonl: 2, unicode.jsonl: 2, the subagent file: its own key plus a copy of msg_1_1|req_1
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 8 });
    expect(db.prepare("SELECT is_subagent_file AS s FROM usage_events WHERE event_key = 'msg_1_1|req_1'").get()).toEqual({ s: 0 });
  });
});

// ---------------------------------------------------------------- the independent Python reference on the same files

interface Python {
  cmd: string;
  args: string[];
}

// The first of python3, python and py -3 that runs, is version 3.9 or newer and has a time zone database (Windows needs the
// tzdata package for that). Null when none does.
function findPython(): Python | null {
  const probe = "import sys; from zoneinfo import ZoneInfo; ZoneInfo('UTC'); sys.exit(0 if sys.version_info >= (3, 9) else 1)";
  for (const cand of [
    { cmd: 'python3', args: [] },
    { cmd: 'python', args: [] },
    { cmd: 'py', args: ['-3'] },
  ] satisfies Python[]) {
    const r = spawnSync(cand.cmd, [...cand.args, '-I', '-c', probe], { encoding: 'utf8', timeout: 20_000 });
    if (r.status === 0) return cand;
  }
  return null;
}

const python = findPython();
const NO_PYTHON = 'skipped: no Python 3.9+ with a time zone database was found as python3, python or py -3';

interface RefGroup {
  events: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_nanos: number;
  unpriced?: number;
}

const SUMS =
  'COUNT(*) AS events, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, ' +
  'SUM(cache_write_tokens) AS cache_write, COALESCE(SUM(cost_nanos), 0) AS cost_nanos';

function groups(db: Db, key: string, withUnpriced = false): Record<string, RefGroup> {
  const extra = withUnpriced ? ', SUM(CASE WHEN cost_nanos IS NULL THEN 1 ELSE 0 END) AS unpriced' : '';
  const rows = db.prepare(`SELECT ${key} AS k, ${SUMS}${extra} FROM usage_events GROUP BY ${key} ORDER BY k`).all() as unknown as Array<RefGroup & { k: string }>;
  return Object.fromEntries(rows.map(({ k, ...rest }) => [k, rest]));
}

function pick(g: Record<string, RefGroup & Record<string, unknown>>, withUnpriced = false): Record<string, RefGroup> {
  const fields = ['events', 'input', 'output', 'cache_read', 'cache_write', 'cost_nanos', ...(withUnpriced ? ['unpriced'] : [])];
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Object.fromEntries(fields.map((f) => [f, v[f]]))])) as unknown as Record<string, RefGroup>;
}

describe.skipIf(python === null)(`the totals equal the Python reference run on the same files${python === null ? ` (${NO_PYTHON})` : ''}`, () => {
  it('agree on events, tokens, cost, models, days, sessions, files, tool calls, messages and parse errors', async () => {
    const db = await ingested();
    const py = python as Python;
    const r = spawnSync(py.cmd, [...py.args, '-I', REFERENCE, '--tz', 'UTC', root], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const ref = JSON.parse(r.stdout) as {
      files: { top_level: number; subagent: number };
      malformed_lines: number;
      usage_events: number;
      unpriced_events: number;
      totals: Record<string, number>;
      per_model: Record<string, RefGroup & Record<string, unknown>>;
      per_day: Record<string, RefGroup & Record<string, unknown>>;
      per_session: Record<string, RefGroup & Record<string, unknown>>;
      tool_calls: { total: number; by_name: Record<string, number> };
      messages: Record<string, { main: number; sidechain: number }>;
      sessions: number;
    };

    // the fixtures are not trivial
    expect(ref.usage_events).toBe(8);
    expect(ref.unpriced_events).toBe(1);
    expect(Object.keys(ref.per_model).length).toBe(3);
    expect(Object.keys(ref.per_day).length).toBe(2);
    expect(ref.totals['cost_nanos']).toBeGreaterThan(0);

    const total = db
      .prepare(
        `SELECT COUNT(*) AS events, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
                SUM(cache_write_tokens) AS cache_write, SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h,
                SUM(thinking_tokens) AS thinking, SUM(web_search_requests) AS web_search, SUM(web_fetch_requests) AS web_fetch,
                COALESCE(SUM(cost_nanos), 0) AS cost_nanos FROM usage_events`,
      )
      .get() as Record<string, number>;
    const { events, ...tokens } = total;
    expect(events).toBe(ref.usage_events);
    expect(tokens).toEqual(ref.totals);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE cost_nanos IS NULL').get()).toEqual({ n: ref.unpriced_events });

    expect(groups(db, 'model', true)).toEqual(pick(ref.per_model, true));
    expect(groups(db, "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')")).toEqual(pick(ref.per_day));
    expect(groups(db, 'session_id')).toEqual(pick(ref.per_session));

    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: ref.sessions });
    const files = db.prepare('SELECT is_subagent AS sub, COUNT(*) AS n FROM source_files GROUP BY is_subagent ORDER BY is_subagent').all();
    expect(files).toEqual([{ sub: 0, n: ref.files.top_level }, { sub: 1, n: ref.files.subagent }]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number }).n).toBe(ref.tool_calls.total);
    const byName = Object.fromEntries((db.prepare('SELECT name, COUNT(*) AS n FROM tool_calls GROUP BY name ORDER BY name').all() as Array<{ name: string; n: number }>).map((x) => [x.name, x.n]));
    expect(byName).toEqual(ref.tool_calls.by_name);
    const msgs = db.prepare('SELECT kind, is_sidechain AS side, COUNT(*) AS n FROM messages GROUP BY kind, is_sidechain').all() as Array<{ kind: string; side: number; n: number }>;
    for (const [kind, v] of Object.entries(ref.messages)) {
      expect(msgs.find((m) => m.kind === kind && m.side === 0)?.n ?? 0, `${kind} main`).toBe(v.main);
      expect(msgs.find((m) => m.kind === kind && m.side === 1)?.n ?? 0, `${kind} sidechain`).toBe(v.sidechain);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM ingest_errors').get() as { n: number }).n).toBe(ref.malformed_lines);
  });
});
