// Possibly incomplete days: completeFrom, partialGap and the partial flags,
// and the archive_started_at value that the first ingest pass stores.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Daily, Filters, Heatmap, Hours, Models, Projects, Sessions, Summary } from '../../src/api/types.ts';
import { retentionDays } from '../../src/config/settings.ts';
import { runIngest } from '../../src/ingest/ingest.ts';
import { archiveStartedAt, completeFrom } from '../../src/metrics/queries.ts';
import { getMeta, rebuildAll, resolvePromptModels, setMeta } from '../../src/metrics/rollups.ts';
import { dayBounds } from '../../src/metrics/time.ts';
import { HOUR, MIN, seeder, shapeErrors, type Seeder, type Shape } from '../unit/metricsHelpers.ts';
import { put, usageLine } from '../unit/ingestHelpers.ts';
import { openAndMigrate, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';
import { removeTemp } from '../unit/helpers.ts';

let env: TempEnv;
let work: string;
const savedRetention = process.env['LEDGER_RETENTION_DAYS'];
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-partial-')));
  delete process.env['LEDGER_RETENTION_DAYS'];
});
afterEach(() => {
  env.restore();
  removeTemp(work);
  if (savedRetention === undefined) delete process.env['LEDGER_RETENTION_DAYS'];
  else process.env['LEDGER_RETENTION_DAYS'] = savedRetention;
});

const DHAKA = 'Asia/Dhaka';
const NY = 'America/New_York';
const local = (day: string, hh: number, mm = 0, tz = DHAKA): number => dayBounds(day, tz)[0] + hh * HOUR + mm * MIN;

function finish(s: Seeder): Seeder {
  resolvePromptModels(s.db);
  rebuildAll(s.db, s.ctx.tz);
  return s;
}

function body<T>(s: Seeder, path: string): T {
  const r = s.get(path);
  if (r.status !== 200) throw new Error(`${path} gave ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

// An archive whose earliest event is 2026-09-01 (Dhaka) and whose first ingest was 2026-10-27 at 12:00 Dhaka, with a few more
// active days after. completeFrom is then 2026-09-27: 1 Sep to 26 Sep are possibly incomplete.
function aged(zone = DHAKA, ingestAt = local('2026-10-27', 12, 0, zone)): Seeder {
  const s = seeder(env.dir, zone, local('2026-10-28', 8, 0, zone));
  for (const [day, hh] of [['2026-09-01', 9], ['2026-09-10', 14], ['2026-09-26', 22], ['2026-09-27', 9], ['2026-10-05', 10], ['2026-10-27', 11]] as const) {
    s.prompt('A', local(day, hh, 0, zone), { cwd: '/work/a' });
    s.response('A', local(day, hh, 1, zone), { cwd: '/work/a' });
  }
  setMeta(s.db, 'archive_started_at', String(ingestAt));
  return finish(s);
}

describe('completeFrom', () => {
  it('is the local day of the first ingest minus 30 days, so 1 to 26 Sep are partial', () => {
    const s = aged();
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.range).toMatchObject({ archiveStart: '2026-09-01', completeFrom: '2026-09-27', coverageGap: false, partialGap: true });
    expect(body<Filters>(s, '/api/filters')).toMatchObject({ archiveStart: '2026-09-01', completeFrom: '2026-09-27' });
  });

  it('never goes before the archive start', () => {
    // The first ingest was 5 days after the earliest event: 30 days before it is long before the archive.
    const s = seeder(env.dir, DHAKA, local('2026-10-28', 8));
    s.response('A', local('2026-10-20', 10));
    setMeta(s.db, 'archive_started_at', String(local('2026-10-25', 10)));
    finish(s);
    expect(completeFrom(s.ctx)).toBe('2026-10-20');
    const sum = body<Summary>(s, '/api/summary?from=2026-10-01');
    expect(sum.range).toMatchObject({ archiveStart: '2026-10-20', completeFrom: '2026-10-20', coverageGap: true, partialGap: false });
    expect(body<Heatmap>(s, '/api/heatmap').cells.some((c) => c.partial)).toBe(false);
  });

  it('is null when nothing is archived', () => {
    const s = finish(seeder(env.dir, DHAKA));
    expect(completeFrom(s.ctx)).toBeNull();
    expect(body<Filters>(s, '/api/filters').completeFrom).toBeNull();
    expect(body<Summary>(s, '/api/summary').range).toMatchObject({ completeFrom: null, partialGap: false });
  });

  it('follows LEDGER_RETENTION_DAYS', () => {
    const s = aged();
    process.env['LEDGER_RETENTION_DAYS'] = '10';
    expect(body<Summary>(s, '/api/summary').range.completeFrom).toBe('2026-10-17');
    process.env['LEDGER_RETENTION_DAYS'] = '60';
    // 60 days before the first ingest is before the earliest event: clamped to the archive start, nothing is partial.
    expect(body<Summary>(s, '/api/summary').range).toMatchObject({ completeFrom: '2026-09-01', partialGap: false });
    delete process.env['LEDGER_RETENTION_DAYS'];
    expect(body<Summary>(s, '/api/summary').range.completeFrom).toBe('2026-09-27');
  });

  it('lets the context override the environment (tests and embedding)', () => {
    const s = aged();
    process.env['LEDGER_RETENTION_DAYS'] = '10';
    s.ctx.retentionDays = 20;
    expect(body<Summary>(s, '/api/summary').range.completeFrom).toBe('2026-10-07');
  });

  it('falls back to the oldest source file row when archive_started_at is absent', () => {
    const s = aged();
    s.db.prepare("DELETE FROM meta WHERE key = 'archive_started_at'").run();
    s.db.prepare('UPDATE source_files SET first_seen_at = ?').run(local('2026-10-12', 8));
    s.db.prepare('UPDATE source_files SET first_seen_at = ? WHERE ino = 2').run(local('2026-10-13', 8));
    expect(archiveStartedAt(s.ctx)).toBe(local('2026-10-12', 8));
    expect(completeFrom(s.ctx)).toBe('2026-09-12');
    expect(body<Summary>(s, '/api/summary').range).toMatchObject({ completeFrom: '2026-09-12', partialGap: true });
  });

  it('prefers archive_started_at over the source file rows', () => {
    const s = aged();
    s.db.prepare('UPDATE source_files SET first_seen_at = ?').run(local('2026-10-12', 8));
    expect(completeFrom(s.ctx)).toBe('2026-09-27');
  });

  it('ignores a broken archive_started_at value and uses the fallback', () => {
    const s = aged();
    setMeta(s.db, 'archive_started_at', 'not a number');
    s.db.prepare('UPDATE source_files SET first_seen_at = ?').run(local('2026-10-12', 8));
    expect(completeFrom(s.ctx)).toBe('2026-09-12');
  });

  it('changes on the stroke of local midnight, in the configured zone', () => {
    // 30 days before 2026-10-27 00:00:00.000 Dhaka is 2026-09-27 00:00:00.000: that day.
    // One millisecond earlier it is still 2026-10-26, so 30 days back is 2026-09-26.
    const midnight = local('2026-10-27', 0);
    const at = (ms: number): string | null => {
      const s = aged(DHAKA, ms);
      return completeFrom(s.ctx);
    };
    expect(at(midnight)).toBe('2026-09-27');
    expect(at(midnight - 1)).toBe('2026-09-26');
    expect(at(midnight + 1)).toBe('2026-09-27');
    // The same instants read in another zone give another day: 18:00 UTC on the 26th is midnight in Dhaka.
    const utcZone = aged('UTC', Date.UTC(2026, 9, 26, 18, 0, 0));
    expect(completeFrom(utcZone.ctx)).toBe('2026-09-26');
    const dhakaZone = aged(DHAKA, Date.UTC(2026, 9, 26, 18, 0, 0));
    expect(completeFrom(dhakaZone.ctx)).toBe('2026-09-27');
  });

  it('counts elapsed time, so a daylight saving change inside the window moves the cut by that hour', () => {
    // New York leaves standard time on 2026-11-01 and enters daylight time on 2026-03-08.
    // First ingest 2026-04-07 00:00 EDT: 30 x 24 h earlier is 2026-03-07 23:00 EST.
    const ingest = local('2026-04-07', 0, 0, NY);
    const s = seeder(env.dir, NY, local('2026-04-08', 8, 0, NY));
    s.response('A', local('2026-03-01', 10, 0, NY));
    setMeta(s.db, 'archive_started_at', String(ingest));
    finish(s);
    expect(completeFrom(s.ctx)).toBe('2026-03-07');
    // The same wall clock time one day later is not near the change: plain 30 days.
    setMeta(s.db, 'archive_started_at', String(local('2026-04-08', 0, 0, NY)));
    expect(completeFrom(s.ctx)).toBe('2026-03-09');
  });
});

describe('partialGap and the partial flags', () => {
  it('partialGap is true only when the range touches a day before completeFrom (and not before the archive alone)', () => {
    const s = aged();
    const gap = (q: string): boolean => body<Summary>(s, `/api/summary${q}`).range.partialGap;
    expect(gap('')).toBe(true); // 1 Sep to today
    expect(gap('?from=2026-09-26&to=2026-09-26')).toBe(true);
    expect(gap('?from=2026-09-27')).toBe(false);
    expect(gap('?from=2026-10-01')).toBe(false);
    expect(gap('?from=2026-09-20&to=2026-09-27')).toBe(true);
    // A range that ends before the archive starts holds only unknown days, none partial.
    expect(gap('?from=2026-08-01&to=2026-08-31')).toBe(false);
    // A range that starts before the archive and reaches into the partial days has both gaps.
    const both = body<Summary>(s, '/api/summary?from=2026-08-15&to=2026-09-05').range;
    expect(both).toMatchObject({ coverageGap: true, partialGap: true });
  });

  it('marks exactly the days from the archive start up to the day before completeFrom in the heatmap', () => {
    const s = aged();
    const m = body<Heatmap>(s, '/api/heatmap?from=2026-08-20');
    const partial = m.cells.filter((c) => c.partial).map((c) => c.day);
    expect(partial[0]).toBe('2026-09-01');
    expect(partial[partial.length - 1]).toBe('2026-09-26');
    expect(partial).toHaveLength(26);
    for (const c of m.cells) {
      if (c.day < '2026-09-01') expect(c, c.day).toMatchObject({ beforeArchive: true, partial: false });
      else if (c.day < '2026-09-27') expect(c, c.day).toMatchObject({ beforeArchive: false, partial: true });
      else expect(c, c.day).toMatchObject({ beforeArchive: false, partial: false });
    }
    // The values stay: a partial day keeps what the archive holds.
    expect(m.cells.find((c) => c.day === '2026-09-10')?.value).toBe(2);
    expect(m.cells.find((c) => c.day === '2026-09-26')?.value).toBe(2);
    expect(m.cells.find((c) => c.day === '2026-09-02')?.value).toBe(0);
    // Cells before `from` keep their flag too (the grid is a context window).
    expect(body<Heatmap>(s, '/api/heatmap?from=2026-10-01').cells.find((c) => c.day === '2026-09-10')?.partial).toBe(true);
  });

  it('marks the same days in the daily chart, for every metric, with the values unchanged', () => {
    const s = aged();
    for (const metric of ['messages', 'tokens', 'sessions']) {
      const d = body<Daily>(s, `/api/daily?metric=${metric}&from=2026-08-28&to=2026-10-02`);
      expect(d.days).toHaveLength(36);
      for (const x of d.days) expect(x.partial, `${metric} ${x.day}`).toBe(x.day >= '2026-09-01' && x.day < '2026-09-27');
      expect(d.days.find((x) => x.day === '2026-09-10')?.total, metric).toBeGreaterThan(0);
    }
  });

  it('does not change a single value: the same days read the same with and without the marking', () => {
    const s = aged();
    const before = body<Daily>(s, '/api/daily?metric=messages').days.map((x) => [x.day, x.total]);
    setMeta(s.db, 'archive_started_at', String(local('2026-09-02', 9))); // nothing partial any more
    const after = body<Daily>(s, '/api/daily?metric=messages').days.map((x) => [x.day, x.total]);
    expect(after).toEqual(before);
  });
});

describe('every endpoint carries the two range fields', () => {
  const range: Shape = { from: 'string', to: 'string', days: 'int', tz: 'string', archiveStart: { nullable: 'string' }, coverageGap: 'boolean', completeFrom: { nullable: 'string' }, partialGap: 'boolean' };
  it('summary, heatmap, daily, hours, models, projects and sessions', () => {
    const s = aged();
    const paths = ['/api/summary', '/api/heatmap', '/api/daily', '/api/hours', '/api/models', '/api/projects', '/api/sessions'];
    for (const path of paths) {
      const r = s.get(path);
      expect(r.status, path).toBe(200);
      const got = (r.body as { range: unknown }).range;
      expect(shapeErrors(got, range), path).toEqual([]);
      expect(got, path).toMatchObject({ archiveStart: '2026-09-01', completeFrom: '2026-09-27', partialGap: true });
    }
    // typed access, so a change of the contract breaks this file at compile time too
    const typed: Array<Hours | Models | Projects | Sessions> = [body<Hours>(s, '/api/hours'), body<Models>(s, '/api/models'), body<Projects>(s, '/api/projects'), body<Sessions>(s, '/api/sessions')];
    for (const t of typed) expect(t.range.completeFrom).toBe('2026-09-27');
  });
});

describe('retentionDays setting', () => {
  it('defaults to 30 and accepts whole days from 1 to 3650', () => {
    expect(retentionDays()).toBe(30);
    process.env['LEDGER_RETENTION_DAYS'] = ' 45 ';
    expect(retentionDays()).toBe(45);
    process.env['LEDGER_RETENTION_DAYS'] = '1';
    expect(retentionDays()).toBe(1);
    process.env['LEDGER_RETENTION_DAYS'] = '3650';
    expect(retentionDays()).toBe(3650);
    process.env['LEDGER_RETENTION_DAYS'] = '';
    expect(retentionDays()).toBe(30);
  });

  it('refuses anything else with a plain sentence', () => {
    for (const bad of ['0', '-5', '3651', '2.5', 'abc', '30d', '1e2', '99999']) {
      process.env['LEDGER_RETENTION_DAYS'] = bad;
      expect(() => retentionDays(), bad).toThrow(/LEDGER_RETENTION_DAYS must be a whole number of days from 1 to 3650/);
    }
  });
});

describe('archive_started_at is stored by the first successful ingest pass', () => {
  const sid = 'aaaaaaaa-0000-0000-0000-00000000000a';
  const tree = (name: string): string => {
    const root = join(work, name);
    put(join(root, '-work-demo', `${sid}.jsonl`), [usageLine(sid, 1, { stop: true })]);
    return root;
  };
  const open = (n: string) => openAndMigrate(join(env.dir, `${n}.db`)).db;

  it('is set once, to the start time of the first pass, and never overwritten', async () => {
    const root = tree('p1');
    const db = open('first');
    expect(getMeta(db, 'archive_started_at')).toBeNull();
    await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => 5_000 });
    expect(getMeta(db, 'archive_started_at')).toBe('5000');
    await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => 9_000 });
    expect(getMeta(db, 'archive_started_at')).toBe('5000');
    await runIngest(db, { roots: [root], full: true, trigger: 'test', now: () => 12_000 });
    expect(getMeta(db, 'archive_started_at')).toBe('5000');
    db.close();
  });

  it('uses the pass start, not a later clock reading', async () => {
    const root = tree('p2');
    const db = open('clock');
    let t = 1_000;
    await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => (t += 100) });
    // the first reading of the clock is the start of the pass; later readings (run row, file rows) are later
    expect(getMeta(db, 'archive_started_at')).toBe('1100');
    db.close();
  });

  it('keeps the oldest source file time for a database that has files but no stored value', async () => {
    const root = tree('p3');
    const db = open('legacy');
    await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => 2_000 });
    db.prepare("DELETE FROM meta WHERE key = 'archive_started_at'").run();
    await runIngest(db, { roots: [root], full: false, trigger: 'test', now: () => 70_000 });
    expect(getMeta(db, 'archive_started_at')).toBe('2000');
    db.close();
  });

  it('is not set when no folder could be read, because nothing has been archived yet', async () => {
    const db = open('missing');
    await runIngest(db, { roots: [join(work, 'does-not-exist')], full: false, trigger: 'test', now: () => 5_000 });
    expect(getMeta(db, 'archive_started_at')).toBeNull();
    // the next pass with a real folder starts the archive
    await runIngest(db, { roots: [tree('p4')], full: false, trigger: 'test', now: () => 8_000 });
    expect(getMeta(db, 'archive_started_at')).toBe('8000');
    db.close();
  });

  it('is not set when the pass fails', async () => {
    const root = tree('p5');
    const db = open('fails');
    await expect(
      runIngest(db, {
        roots: [root],
        full: false,
        trigger: 'test',
        now: () => 5_000,
        faultInTransaction: () => {
          throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    expect(getMeta(db, 'archive_started_at')).toBeNull();
    db.close();
  });
});
