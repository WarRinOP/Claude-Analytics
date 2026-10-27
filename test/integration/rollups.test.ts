import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIngest, type RunSummary } from '../../src/ingest/ingest.ts';
import { afterPass, ensureRollups, getMeta, rebuildAll, refreshDays, resolvePromptModels, rollupMatchesFacts } from '../../src/metrics/rollups.ts';
import { dayBounds } from '../../src/metrics/time.ts';
import { recomputeAllCosts } from '../../src/store/costs.ts';
import { openDb } from '../../src/store/db.ts';
import type { Db } from '../../src/store/db.ts';
import { migrate, openAndMigrate } from '../../src/store/migrate.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { HOUR, MIN, seeder } from '../unit/metricsHelpers.ts';
import { dump, rng, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
let work: string;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-rollup-')));
});
afterEach(() => {
  env.restore();
  rmSync(work, { recursive: true, force: true });
});

const DHAKA = 'Asia/Dhaka';
const NY = 'America/New_York';
const local = (day: string, hh: number, mm = 0, tz = DHAKA): number => dayBounds(day, tz)[0] + hh * HOUR + mm * MIN;

describe('migration 0002', () => {
  it('replaces the old rollup tables with activity_rollup and its day index', () => {
    const { db } = openAndMigrate(join(env.dir, 'a.db'));
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('activity_rollup');
    expect(names).toContain('ix_activity_day');
    expect(names).not.toContain('daily_rollup');
    expect(names).not.toContain('hourly_rollup');
    const cols = (db.prepare('PRAGMA table_info(activity_rollup)').all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    expect(cols.map((c) => c.name)).toEqual(['day', 'hour', 'project_key', 'model', 'is_subagent_file']);
    const all = (db.prepare('PRAGMA table_info(activity_rollup)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(all).toEqual(['day', 'hour', 'project_key', 'model', 'is_subagent_file', 'prompts', 'responses', 'tool_calls', 'input', 'output', 'cache_read', 'cache_write', 'cost_nanos', 'unpriced']);
    db.close();
  });

  it('upgrades a database that was at version 1, with a backup, keeping every fact row', () => {
    const file = join(env.dir, 'old.db');
    const db1 = openDb(file);
    migrate(db1, { migrationsDir: join(import.meta.dirname, '../../src/store/migrations'), backup: false });
    db1.close();
    // Pretend only 0001 was applied: drop version 2 and restore the old tables.
    const raw = openDb(file);
    raw.exec('DROP TABLE activity_rollup; DELETE FROM schema_migrations WHERE version = 2;');
    raw.exec('CREATE TABLE daily_rollup (day TEXT, x INTEGER); CREATE TABLE hourly_rollup (day TEXT, x INTEGER);');
    raw.exec("INSERT INTO meta (key, value) VALUES ('keep', 'me')");
    raw.close();
    const { db, result } = openAndMigrate(file);
    expect(result.applied).toEqual([2]);
    expect(result.backupPath).not.toBeNull();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'keep'").get()).toEqual({ value: 'me' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('daily_rollup', 'hourly_rollup')").all()).toEqual([]);
    db.close();
  });
});

describe('resolvePromptModels', () => {
  it('gives a prompt the model of the first main thread response at or after it', () => {
    const s = seeder(env.dir, DHAKA);
    const t = local('2026-10-20', 10);
    s.prompt('A', t); // answered by the response at the same instant
    s.response('A', t, { model: 'm-same' });
    s.response('A', t + MIN, { model: 'm-later' });
    s.prompt('A', t + 2 * MIN);
    s.response('A', t + 3 * MIN, { model: 'm-side', side: true }); // sidechain: skipped
    s.response('A', t + 3 * MIN, { model: 'm-sub', sub: true }); // subagent file: skipped
    s.response('A', t + 4 * MIN, { model: 'm-next' });
    s.response('B', t - MIN, { model: 'm-other-session' });
    const filled = resolvePromptModels(s.db);
    expect(filled.sort()).toEqual([t, t + 2 * MIN]);
    expect(s.db.prepare("SELECT ts, attributed_model AS m FROM messages WHERE kind = 'prompt' ORDER BY ts").all()).toEqual([
      { ts: t, m: 'm-same' },
      { ts: t + 2 * MIN, m: 'm-next' },
    ]);
  });

  it('leaves a prompt without a later response empty and retries it on every call', () => {
    const s = seeder(env.dir, DHAKA);
    const t = local('2026-10-20', 10);
    s.prompt('A', t);
    s.prompt('A', t + MIN, { side: true });
    s.prompt('A', t + MIN, { kind: 'tool_result' });
    expect(resolvePromptModels(s.db)).toEqual([]);
    expect(s.db.prepare('SELECT attributed_model AS m FROM messages').all().every((r) => (r as { m: unknown }).m === null)).toBe(true);
    s.response('A', t + 5 * MIN, { model: 'm-late' });
    expect(resolvePromptModels(s.db)).toEqual([t]);
    expect(resolvePromptModels(s.db)).toEqual([]);
    expect(s.db.prepare("SELECT attributed_model AS m FROM messages WHERE kind = 'prompt' AND is_sidechain = 0").get()).toEqual({ m: 'm-late' });
    // Only real main thread prompts are filled.
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE attributed_model IS NOT NULL").get()).toEqual({ n: 1 });
  });

  it('never changes a model once it is set', () => {
    const s = seeder(env.dir, DHAKA);
    const t = local('2026-10-20', 10);
    s.prompt('A', t);
    s.response('A', t + 2 * MIN, { model: 'm-first' });
    resolvePromptModels(s.db);
    s.response('A', t + MIN, { model: 'm-earlier-arrival' });
    expect(resolvePromptModels(s.db)).toEqual([]);
    expect(s.db.prepare("SELECT attributed_model AS m FROM messages WHERE kind = 'prompt'").get()).toEqual({ m: 'm-first' });
  });
});

describe('rebuildAll and refreshDays', () => {
  it('fills the rows from the facts and records the zone', () => {
    const s = seeder(env.dir, DHAKA);
    const t = local('2026-10-20', 10);
    s.prompt('A', t, { cwd: '/work/a' });
    s.response('A', t + MIN, { cwd: '/work/a', tools: 2 });
    s.response('A', t + 2 * MIN, { sub: true, tools: 1 });
    s.response('Z', t + 3 * MIN, { sub: true }); // subagent events of a session with no row: project ''
    resolvePromptModels(s.db);
    rebuildAll(s.db, DHAKA);
    expect(getMeta(s.db, 'rollup_tz')).toBe(DHAKA);
    expect(dump(s.db, 'SELECT day, hour, project_key, model, is_subagent_file, prompts, responses, tool_calls, input, output, cache_read, cache_write FROM activity_rollup ORDER BY project_key, is_subagent_file')).toBe(
      JSON.stringify([
        { day: '2026-10-20', hour: 10, project_key: '', model: 'claude-sonnet-5-5', is_subagent_file: 1, prompts: 0, responses: 0, tool_calls: 0, input: 10, output: 100, cache_read: 1000, cache_write: 50 },
        { day: '2026-10-20', hour: 10, project_key: '/work/a', model: 'claude-sonnet-5-5', is_subagent_file: 0, prompts: 1, responses: 1, tool_calls: 2, input: 10, output: 100, cache_read: 1000, cache_write: 50 },
        { day: '2026-10-20', hour: 10, project_key: '/work/a', model: 'claude-sonnet-5-5', is_subagent_file: 1, prompts: 0, responses: 0, tool_calls: 1, input: 10, output: 100, cache_read: 1000, cache_write: 50 },
      ]),
    );
  });

  it('refreshes only the named days and equals a full rebuild', () => {
    const s = seeder(env.dir, DHAKA);
    s.response('A', local('2026-10-20', 10));
    s.response('A', local('2026-10-21', 10));
    s.response('A', local('2026-10-22', 10));
    resolvePromptModels(s.db);
    rebuildAll(s.db, DHAKA);
    // New data on 10-21 only.
    s.response('A', local('2026-10-21', 11), { model: 'm-new' });
    refreshDays(s.db, DHAKA, ['2026-10-21']);
    const incremental = dump(s.db, 'SELECT * FROM activity_rollup ORDER BY day, hour, project_key, model, is_subagent_file');
    rebuildAll(s.db, DHAKA);
    expect(dump(s.db, 'SELECT * FROM activity_rollup ORDER BY day, hour, project_key, model, is_subagent_file')).toBe(incremental);
    // A day that lost its events ends up empty.
    s.db.prepare('DELETE FROM usage_events WHERE ts >= ? AND ts < ?').run(...dayBounds('2026-10-22', DHAKA));
    refreshDays(s.db, DHAKA, ['2026-10-22']);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM activity_rollup WHERE day = '2026-10-22'").get()).toEqual({ n: 0 });
  });

  it('handles scattered days as separate runs and ignores repeats', () => {
    const s = seeder(env.dir, DHAKA);
    for (const d of ['2026-10-01', '2026-10-05', '2026-10-06', '2026-10-20']) s.response('A', local(d, 9));
    rebuildAll(s.db, DHAKA);
    const before = dump(s.db, 'SELECT * FROM activity_rollup ORDER BY day');
    refreshDays(s.db, DHAKA, ['2026-10-20', '2026-10-05', '2026-10-06', '2026-10-05', '2026-10-01']);
    expect(dump(s.db, 'SELECT * FROM activity_rollup ORDER BY day')).toBe(before);
    refreshDays(s.db, DHAKA, []);
    expect(dump(s.db, 'SELECT * FROM activity_rollup ORDER BY day')).toBe(before);
  });

  it('puts the extra hour of a 25 hour day into its own rows without losing or doubling any event', () => {
    const s = seeder(env.dir, NY);
    const [a, b] = dayBounds('2026-11-01', NY);
    for (let ts = a; ts < b; ts += HOUR) s.response('A', ts);
    rebuildAll(s.db, NY);
    const perHour = s.db.prepare("SELECT hour, SUM(responses) AS n FROM activity_rollup WHERE day = '2026-11-01' GROUP BY hour ORDER BY hour").all() as Array<{ hour: number; n: number }>;
    expect(perHour).toHaveLength(24);
    expect(perHour.map((r) => r.n)).toEqual(Array.from({ length: 24 }, (_, i) => (i === 1 ? 2 : 1)));
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM activity_rollup WHERE day <> '2026-11-01'").get()).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------- incremental passes through the real ingest

const SIDS = ['aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-00000000000b', 'cccccccc-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-00000000000d'];
const mainPath = (root: string, i: number): string => join(root, `-work-p${i}`, `${SIDS[i]}.jsonl`);
const subPath = (root: string, i: number): string => join(root, `-work-p${i}`, SIDS[i] as string, 'subagents', 'agent-x.jsonl');

// usageLine and userLine count seconds from 2026-10-01 10:00Z and 09:00Z. These turn an instant into those offsets.
const usageSec = (ms: number): number => Math.round((ms - Date.UTC(2026, 9, 1, 10)) / 1000);
const userSec = (ms: number): number => Math.round((ms - Date.UTC(2026, 9, 1, 9)) / 1000);

function withoutCwd(line: string): string {
  const o = JSON.parse(line) as Record<string, unknown>;
  delete o['cwd'];
  return JSON.stringify(o);
}

function dumpRollup(db: Db): string {
  return dump(db, 'SELECT * FROM activity_rollup ORDER BY day, hour, project_key, model, is_subagent_file');
}

function directSums(db: Db): Record<string, number> {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    input: one('SELECT COALESCE(SUM(input_tokens), 0) AS n FROM usage_events'),
    output: one('SELECT COALESCE(SUM(output_tokens), 0) AS n FROM usage_events'),
    cache_read: one('SELECT COALESCE(SUM(cache_read_tokens), 0) AS n FROM usage_events'),
    cache_write: one('SELECT COALESCE(SUM(cache_write_tokens), 0) AS n FROM usage_events'),
    responses: one('SELECT COUNT(*) AS n FROM usage_events WHERE is_sidechain = 0 AND is_subagent_file = 0'),
    prompts: one("SELECT COUNT(*) AS n FROM messages WHERE kind = 'prompt' AND is_sidechain = 0"),
    tool_calls: one('SELECT COUNT(*) AS n FROM tool_calls'),
    cost_nanos: one('SELECT COALESCE(SUM(cost_nanos), 0) AS n FROM usage_events'),
    unpriced: one('SELECT COUNT(*) AS n FROM usage_events WHERE cost_nanos IS NULL'),
  };
}

function rollupSums(db: Db): Record<string, number> {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS cache_read,
              COALESCE(SUM(cache_write), 0) AS cache_write, COALESCE(SUM(responses), 0) AS responses, COALESCE(SUM(prompts), 0) AS prompts,
              COALESCE(SUM(tool_calls), 0) AS tool_calls, COALESCE(SUM(cost_nanos), 0) AS cost_nanos, COALESCE(SUM(unpriced), 0) AS unpriced FROM activity_rollup`,
    )
    .get() as Record<string, number>;
  return { ...r };
}

// The stored cost of every event after pricing all of them again, computed on a copy so the live database is left alone.
function recomputedCosts(db: Db): string {
  copyCounter += 1;
  const file = join(env.dir, `costs-${copyCounter}.db`);
  db.exec(`VACUUM INTO '${file}'`);
  const copy = openDb(file);
  try {
    copy.exec('UPDATE usage_events SET cost_nanos = NULL');
    recomputeAllCosts(copy);
    return dump(copy, 'SELECT event_key, cost_nanos FROM usage_events ORDER BY event_key');
  } finally {
    copy.close();
  }
}

let copyCounter = 0;
// The rollup a full rebuild would give for the current facts, computed on a copy so the live database is left alone.
function rebuiltCopy(db: Db, tz: string): string {
  copyCounter += 1;
  const file = join(env.dir, `copy-${copyCounter}.db`);
  db.exec(`VACUUM INTO '${file}'`);
  const copy = openDb(file);
  try {
    rebuildAll(copy, tz);
    return dumpRollup(copy);
  } finally {
    copy.close();
  }
}

interface ScenarioResult {
  incremental: number;
  rebuilds: number;
  reprojected: number;
}

// Several rounds of random appends through the real ingest: responses that stream across local midnight between two
// passes, prompts that arrive before their response, sidechain and subagent lines, tool calls, a session whose project is
// unknown at first, and a session whose subagent file is seen before its main file. After every pass the incremental
// rollup must equal a full rebuild, and its sums must equal direct sums over the fact tables.
async function scenario(seed: number, tz: string, base: number): Promise<ScenarioResult> {
  const rand = rng(seed);
  const tag = `${seed}-${tz.replace('/', '_')}`;
  const root = join(work, `projects-${tag}`);
  mkdirSync(root, { recursive: true });
  const { db } = openAndMigrate(join(env.dir, `prop-${tag}.db`));
  const files = new Map<string, string[]>();
  const append = (path: string, lines: string[]): void => {
    const all = files.get(path) ?? [];
    all.push(...lines);
    files.set(path, all);
    put(path, all);
  };
  let n = 100;
  const open: Array<{ i: number; n: number; ts: number }> = [];
  const span = 3 * 24 * 3600 * 1000;
  const randTs = (): number => base + Math.floor(rand() * span);
  const out: ScenarioResult = { incremental: 0, rebuilds: 0, reprojected: 0 };
  ensureRollups(db, tz);

  for (let round = 0; round < 9; round++) {
    for (let i = 0; i < SIDS.length; i++) {
      const sid = SIDS[i] as string;
      if (i === 3 && round < 3) {
        // The main file of session D does not exist yet; only a subagent file does.
        if (round === 1) append(subPath(root, i), [usageLine(sid, ++n, { stop: true, ts: usageSec(randTs()), subagent: true, tools: [`t${n}`] })]);
        continue;
      }
      if (rand() < 0.3) continue;
      const strip = (l: string): string => (i === 1 && round < 3 ? withoutCwd(l) : l); // the project of session B is unknown at first
      const main: string[] = [];
      const sub: string[] = [];
      const count = 1 + Math.floor(rand() * 8);
      for (let k = 0; k < count; k++) {
        const r = rand();
        const ts = randTs();
        if (r < 0.3) {
          main.push(strip(userLine(sid, `u-${++n}`, userSec(ts), {}, `/work/p${i}`)));
        } else if (r < 0.38) {
          main.push(strip(userLine(sid, `tr-${++n}`, userSec(ts), { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'SECRET' }] } }, `/work/p${i}`)));
        } else if (r < 0.62) {
          main.push(strip(usageLine(sid, ++n, { stop: true, out: 5 + Math.floor(rand() * 90), ts: usageSec(ts), tools: rand() < 0.4 ? [`t${n}a`, `t${n}b`] : [], cwd: `/work/p${i}` })));
        } else if (r < 0.74) {
          // Streaming: a partial line now, the final line in a later round, often across local midnight.
          const midnight = dayBounds(new Date(ts).toISOString().slice(0, 10), tz)[1];
          const at = rand() < 0.5 ? midnight - 3_000 : ts;
          main.push(strip(usageLine(sid, ++n, { stop: false, out: 3, ts: usageSec(at), cwd: `/work/p${i}` })));
          open.push({ i, n, ts: at });
        } else if (r < 0.86) {
          sub.push(usageLine(sid, ++n, { stop: true, ts: usageSec(ts), subagent: true, tools: rand() < 0.5 ? [`t${n}`] : [] }));
        } else {
          main.push(strip(usageLine(sid, ++n, { stop: true, ts: usageSec(ts), subagent: true, cwd: `/work/p${i}` }))); // a sidechain line in a main file
        }
      }
      for (let k = open.length - 1; k >= 0; k--) {
        const o = open[k] as (typeof open)[number];
        if (o.i === i && rand() < 0.7) {
          main.push(strip(usageLine(sid, o.n, { stop: true, out: 40, ts: usageSec(o.ts + 8_000), cwd: `/work/p${i}` })));
          open.splice(k, 1);
        }
      }
      if (main.length > 0) append(mainPath(root, i), main);
      if (sub.length > 0) append(subPath(root, i), sub);
    }

    const sum: RunSummary = await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => base });
    if (sum.filesChanged > 0) {
      out.reprojected += sum.sessionsReprojected;
      const days = afterPass(db, tz, sum);
      if (days.changedFrom === null) out.rebuilds += 1;
      else out.incremental += 1;
    }
    const incremental = dumpRollup(db);
    expect(incremental, `seed ${seed} ${tz} round ${round}`).toBe(rebuiltCopy(db, tz));
    expect(rollupSums(db), `sums, seed ${seed} ${tz} round ${round}`).toEqual(directSums(db));
    expect(rollupMatchesFacts(db)).toBe(true);
    // the cost stored event by event equals what pricing every event again gives
    expect(dump(db, 'SELECT event_key, cost_nanos FROM usage_events ORDER BY event_key'), `costs, seed ${seed} ${tz} round ${round}`).toBe(recomputedCosts(db));
  }
  db.close();
  return out;
}

describe('rollup consistency under incremental passes', () => {
  it('equals a full rebuild after every pass, in a daylight saving zone around the clock change', async () => {
    let incremental = 0;
    let rebuilds = 0;
    for (const seed of [1, 2, 3, 4]) {
      const r = await scenario(seed, NY, Date.UTC(2026, 9, 31, 4)); // 2026-10-31 00:00 EDT, three days over 2026-11-01
      incremental += r.incremental;
      rebuilds += r.rebuilds;
    }
    expect(incremental).toBeGreaterThan(10);
    expect(rebuilds).toBeGreaterThan(0);
  }, 60_000);

  it('equals a full rebuild after every pass in a zone without daylight saving', async () => {
    for (const seed of [11, 12]) await scenario(seed, DHAKA, Date.UTC(2026, 9, 20));
  }, 60_000);

  it('sums over the rollup equal direct sums over the fact tables for tokens, responses, prompts and tool calls', async () => {
    const root = join(work, 'projects-sums');
    put(mainPath(root, 0), [
      userLine(SIDS[0] as string, 'u1', 10, {}, '/work/p0'),
      usageLine(SIDS[0] as string, 1, { stop: true, ts: 20, tools: ['a', 'b'], cwd: '/work/p0' }),
      usageLine(SIDS[0] as string, 2, { stop: true, ts: 30, subagent: true, cwd: '/work/p0' }),
    ]);
    put(subPath(root, 0), [usageLine(SIDS[0] as string, 3, { stop: true, ts: 40, subagent: true, tools: ['c'] })]);
    const { db } = openAndMigrate(join(env.dir, 'sums.db'));
    const sum = await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => 1 });
    afterPass(db, DHAKA, sum);
    expect(rollupSums(db)).toEqual(directSums(db));
    expect(directSums(db)).toMatchObject({ responses: 1, prompts: 1, tool_calls: 3 });
    db.close();
  });
});

describe('afterPass', () => {
  const sid = SIDS[0] as string;
  const pass = (db: Db, root: string): Promise<RunSummary> => runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => 1 });
  const rollupProjects = (db: Db): string[] => (db.prepare('SELECT DISTINCT project_key AS k FROM activity_rollup ORDER BY k').all() as Array<{ k: string }>).map((r) => r.k);

  it('refreshes the days of the pass and reports exactly those days', async () => {
    const root = join(work, 'projects-after');
    const { db } = openAndMigrate(join(env.dir, 'after.db'));
    ensureRollups(db, DHAKA);
    put(mainPath(root, 0), [usageLine(sid, 1, { stop: true, ts: usageSec(Date.UTC(2026, 9, 20, 4)), cwd: '/work/p0' })]); // 10:00 in Dhaka
    const first = await pass(db, root);
    expect(first.sessionsReprojected).toBe(0); // a new session with its events in one batch moves nothing
    expect(afterPass(db, DHAKA, first)).toEqual({ changedFrom: '2026-10-20', changedTo: '2026-10-20' });
    expect(rollupSums(db)).toEqual(directSums(db));

    put(mainPath(root, 0), [
      usageLine(sid, 1, { stop: true, ts: usageSec(Date.UTC(2026, 9, 20, 4)), cwd: '/work/p0' }),
      usageLine(sid, 2, { stop: true, ts: usageSec(Date.UTC(2026, 9, 22, 4)), cwd: '/work/p0' }),
    ]);
    const second = await pass(db, root);
    expect(afterPass(db, DHAKA, second)).toEqual({ changedFrom: '2026-10-22', changedTo: '2026-10-22' });
    expect(dumpRollup(db)).toBe(rebuiltCopy(db, DHAKA));
    db.close();
  });

  it('reports the day before when a response that streamed over midnight changed it', async () => {
    const root = join(work, 'projects-straddle');
    const { db } = openAndMigrate(join(env.dir, 'straddle.db'));
    ensureRollups(db, DHAKA);
    const lastSecond = dayBounds('2026-10-20', DHAKA)[1] - 3_000; // 23:59:57 in Dhaka
    put(mainPath(root, 0), [usageLine(sid, 1, { stop: false, out: 3, ts: usageSec(lastSecond), cwd: '/work/p0' })]);
    afterPass(db, DHAKA, await pass(db, root));
    put(mainPath(root, 0), [
      usageLine(sid, 1, { stop: false, out: 3, ts: usageSec(lastSecond), cwd: '/work/p0' }),
      usageLine(sid, 1, { stop: true, out: 90, ts: usageSec(lastSecond + 8_000), cwd: '/work/p0' }),
    ]);
    const second = await pass(db, root);
    expect(second.changedRange).toEqual({ minTs: lastSecond + 8_000, maxTs: lastSecond + 8_000 });
    expect(afterPass(db, DHAKA, second)).toEqual({ changedFrom: '2026-10-20', changedTo: '2026-10-21' });
    expect(dumpRollup(db)).toBe(rebuiltCopy(db, DHAKA));
    expect(rollupSums(db).output).toBe(90);
    db.close();
  });

  it('rebuilds everything when the project of a session becomes known', async () => {
    const root = join(work, 'projects-reproject');
    const { db } = openAndMigrate(join(env.dir, 'reproject.db'));
    ensureRollups(db, DHAKA);
    const line = (n: number, day: number, cwd: boolean): string => {
      const l = usageLine(sid, n, { stop: true, ts: usageSec(Date.UTC(2026, 9, day, 4)), cwd: '/work/p0' });
      return cwd ? l : withoutCwd(l);
    };
    put(mainPath(root, 0), [line(1, 20, false)]);
    const first = await pass(db, root);
    expect(first.sessionsReprojected).toBe(0);
    afterPass(db, DHAKA, first);
    expect(rollupProjects(db)).toEqual(['dir:-work-p0']);

    put(mainPath(root, 0), [line(1, 20, false), line(2, 25, true)]);
    const second = await pass(db, root);
    expect(second.sessionsReprojected).toBe(1);
    expect(afterPass(db, DHAKA, second)).toEqual({ changedFrom: null, changedTo: null });
    expect(rollupProjects(db)).toEqual(['/work/p0']); // the old day moved too, although the pass did not touch it
    expect(dumpRollup(db)).toBe(rebuiltCopy(db, DHAKA));
    db.close();
  });

  it('rebuilds when a main file appears for subagent events that had no session', async () => {
    const root = join(work, 'projects-late-main');
    const { db } = openAndMigrate(join(env.dir, 'late.db'));
    ensureRollups(db, DHAKA);
    put(subPath(root, 0), [usageLine(sid, 1, { stop: true, ts: usageSec(Date.UTC(2026, 9, 20, 4)), subagent: true })]);
    const first = await pass(db, root);
    expect(first.sessionsReprojected).toBe(0);
    afterPass(db, DHAKA, first);
    expect(rollupProjects(db)).toEqual(['']);

    put(mainPath(root, 0), [usageLine(sid, 2, { stop: true, ts: usageSec(Date.UTC(2026, 9, 25, 4)), cwd: '/work/p0' })]);
    const second = await pass(db, root);
    expect(second.sessionsReprojected).toBe(1);
    expect(afterPass(db, DHAKA, second)).toEqual({ changedFrom: null, changedTo: null });
    expect(rollupProjects(db)).toEqual(['/work/p0']);
    db.close();
  });

  it('rebuilds when the zone differs from the stored one', async () => {
    const root = join(work, 'projects-zone');
    const { db } = openAndMigrate(join(env.dir, 'zone.db'));
    ensureRollups(db, DHAKA);
    put(mainPath(root, 0), [usageLine(sid, 1, { stop: true, ts: usageSec(Date.UTC(2026, 9, 20, 20)), cwd: '/work/p0' })]); // 2026-10-21 02:00 in Dhaka
    const first = await pass(db, root);
    expect(afterPass(db, NY, first)).toEqual({ changedFrom: null, changedTo: null });
    expect(getMeta(db, 'rollup_tz')).toBe(NY);
    expect((db.prepare('SELECT day FROM activity_rollup').get() as { day: string }).day).toBe('2026-10-20');
    db.close();
  });

  it('gives a prompt its model on the pass that brings the response, and refreshes that prompt day', async () => {
    const root = join(work, 'projects-prompt');
    const { db } = openAndMigrate(join(env.dir, 'prompt.db'));
    ensureRollups(db, DHAKA);
    const t = Date.UTC(2026, 9, 20, 4);
    put(mainPath(root, 0), [userLine(sid, 'u1', userSec(t), {}, '/work/p0')]);
    afterPass(db, DHAKA, await pass(db, root));
    expect(db.prepare('SELECT model, prompts FROM activity_rollup').all()).toEqual([{ model: '', prompts: 1 }]);
    // The answer comes two days later (a resumed session), so the prompt day is not part of the pass range.
    const answer = t + 2 * 24 * HOUR;
    put(mainPath(root, 0), [userLine(sid, 'u1', userSec(t), {}, '/work/p0'), usageLine(sid, 1, { stop: true, ts: usageSec(answer), cwd: '/work/p0' })]);
    const second = await pass(db, root);
    expect(afterPass(db, DHAKA, second)).toEqual({ changedFrom: '2026-10-20', changedTo: '2026-10-22' });
    expect(db.prepare('SELECT day, model, prompts, responses FROM activity_rollup ORDER BY day').all()).toEqual([
      { day: '2026-10-20', model: 'claude-sonnet-5-5', prompts: 1, responses: 0 },
      { day: '2026-10-22', model: 'claude-sonnet-5-5', prompts: 0, responses: 1 },
    ]);
    db.close();
  });

  it('does nothing for days when a pass changed only something that has no day', async () => {
    const root = join(work, 'projects-title');
    const { db } = openAndMigrate(join(env.dir, 'title.db'));
    ensureRollups(db, DHAKA);
    put(mainPath(root, 0), [JSON.stringify({ type: 'ai-title', sessionId: sid, aiTitle: 'A title' })]);
    const s = await pass(db, root);
    expect(s.filesChanged).toBe(1);
    expect(s.changedRange).toBeNull();
    expect(afterPass(db, DHAKA, s)).toEqual({ changedFrom: null, changedTo: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_rollup').get()).toEqual({ n: 0 });
    db.close();
  });
});
