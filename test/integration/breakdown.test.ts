// Plan section 16: GET /api/breakdown and /api/breakdown.csv on synthetic archives. Zones and daylight saving changes are real
// (the events are placed in UTC and the rollup gives them their local day), the sums are compared with the other endpoints.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Breakdown, BreakdownModelRow, BreakdownPeriod, BreakdownRow, BreakdownTotals, Summary } from '../../src/api/types.ts';
import { BREAKDOWN_CSV_HEADER } from '../../src/metrics/breakdown.ts';
import { rebuildAll, resolvePromptModels, setMeta } from '../../src/metrics/rollups.ts';
import { dayBounds } from '../../src/metrics/time.ts';
import { HOUR, MIN, seeder, shapeErrors, type Seeder, type Shape } from '../unit/metricsHelpers.ts';
import { useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

const DHAKA = 'Asia/Dhaka';
const NY = 'America/New_York';
const PERIODS: BreakdownPeriod[] = ['month', 'week', 'day'];

const local = (day: string, hh: number, mm = 0, tz = DHAKA): number => dayBounds(day, tz)[0] + hh * HOUR + mm * MIN;
const utc = (iso: string): number => Date.parse(iso);

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

const bd = (s: Seeder, period: BreakdownPeriod, extra = ''): Breakdown => body<Breakdown>(s, `/api/breakdown?period=${period}${extra === '' ? '' : `&${extra}`}`);

// Dhaka archive over a month end, with two projects, three models (one without a price) and a subagent event:
//   2026-10-20 (Tue)  A /work/a: p 09:00, opus 09:01, sonnet 09:02, mystery 09:03 (no price), subagent sonnet 09:04
//   2026-10-31 (Sat)  B /work/b: p 23:30, sonnet 23:31          (still October in Dhaka)
//   2026-11-01 (Sun)  B: opus 00:30                              (local November, UTC 2026-10-31 18:30)
//   2026-11-02 (Mon)  A: sonnet 10:00, haiku-4-5 10:01
function archive(): Seeder {
  const s = seeder(env.dir, DHAKA, local('2026-11-03', 8));
  s.prompt('A', local('2026-10-20', 9), { cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 1), { model: 'claude-opus-5-5', cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 2), { cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 3), { model: 'claude-mystery-1', cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 4), { sub: true });
  s.prompt('B', local('2026-10-31', 23, 30), { cwd: '/work/b' });
  s.response('B', local('2026-10-31', 23, 31), { cwd: '/work/b' });
  s.response('B', local('2026-11-01', 0, 30), { model: 'claude-opus-5-5', cwd: '/work/b' });
  s.prompt('A', local('2026-11-02', 10), { cwd: '/work/a' });
  s.response('A', local('2026-11-02', 10, 0), { cwd: '/work/a' });
  s.response('A', local('2026-11-02', 10, 1), { model: 'claude-haiku-4-5', cwd: '/work/a', output: 5000 });
  return finish(s);
}

const nanos = (usd: number): number => Math.round(usd * 1e9);

function sumOf(items: Array<BreakdownTotals>): BreakdownTotals {
  const t: BreakdownTotals = { responses: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, costUsd: 0, unpriced: 0 };
  let n = 0;
  for (const i of items) {
    t.responses += i.responses;
    t.input += i.input;
    t.output += i.output;
    t.cacheWrite += i.cacheWrite;
    t.cacheRead += i.cacheRead;
    t.total += i.total;
    t.unpriced += i.unpriced;
    n += nanos(i.costUsd);
  }
  t.costUsd = n / 1e9;
  return t;
}

// Equal in every field; dollars compared as whole nano dollars so float addition order cannot matter.
function expectSame(a: BreakdownTotals, b: BreakdownTotals, what: string): void {
  expect({ ...a, costUsd: nanos(a.costUsd) }, what).toEqual({ ...b, costUsd: nanos(b.costUsd) });
}

// ---------------------------------------------------------------- contract

const totals: Shape = { responses: 'int', input: 'int', output: 'int', cacheWrite: 'int', cacheRead: 'int', total: 'int', costUsd: 'number', unpriced: 'int' };
const modelRow: Shape = { model: 'string', ...(totals as Record<string, Shape>) };
const dayRowShape: Shape = { key: 'string', label: 'string', from: 'string', to: 'string', partial: 'boolean', models: [modelRow], totals, days: [{ key: 'string' }] };
const SHAPE: Shape = {
  range: { from: 'string', to: 'string', days: 'int', tz: 'string', archiveStart: { nullable: 'string' }, coverageGap: 'boolean', completeFrom: { nullable: 'string' }, partialGap: 'boolean' },
  period: 'string',
  rows: [dayRowShape],
  totals,
  priceTableDate: 'string',
};

describe('the contract', () => {
  it('answers exactly the Breakdown shape for every period', () => {
    const s = archive();
    for (const p of PERIODS) {
      const b = bd(s, p);
      // the nested days list is checked row by row below; the shape of a day row is the same as a period row
      const top = shapeErrors({ ...b, rows: b.rows.map((r) => ({ ...r, days: r.days.map((d) => ({ key: d.key })) })) }, SHAPE);
      expect(top, p).toEqual([]);
      for (const r of b.rows) {
        for (const d of r.days) {
          expect(shapeErrors({ ...d, days: d.days.map((x) => ({ key: x.key })) }, dayRowShape), `${p} ${r.key} ${d.key}`).toEqual([]);
          expect(d.days).toEqual([]);
        }
      }
    }
  });

  it('period defaults to month, and a bad one is a 400 with a plain sentence', () => {
    const s = archive();
    expect(body<Breakdown>(s, '/api/breakdown').period).toBe('month');
    for (const bad of ['period=year', 'period=month&period=day', 'period=Week', 'from=2026-13-01', 'includeSubagents=maybe']) {
      for (const path of ['/api/breakdown', '/api/breakdown.csv']) {
        const r = s.get(`${path}?${bad}`);
        expect(r.status, `${path} ${bad}`).toBe(400);
        expect(Object.keys(r.body as object)).toEqual(['error']);
        expect((r.body as { error: string }).error).not.toMatch(/[-–—]/);
      }
    }
  });

  it('an empty archive gives no rows and zero totals', () => {
    const s = finish(seeder(env.dir, DHAKA));
    for (const p of PERIODS) {
      const b = bd(s, p);
      expect(b.rows).toEqual([]);
      expect(b.totals).toEqual({ responses: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, costUsd: 0, unpriced: 0 });
      expect(b.priceTableDate).toBe('2026-10-27');
    }
    const r = s.get('/api/breakdown.csv');
    expect(r.status).toBe(200);
    expect(r.file?.text).toBe(BREAKDOWN_CSV_HEADER.join(',') + '\r\n');
  });
});

// ---------------------------------------------------------------- periods

describe('months, weeks and days in Asia/Dhaka across a month end', () => {
  it('buckets by the local calendar: 23:31 on 31 Oct is October, 00:30 on 1 Nov (UTC 31 Oct) is November', () => {
    const s = archive();
    const m = bd(s, 'month');
    expect(m.rows.map((r) => r.key)).toEqual(['2026-11', '2026-10']); // newest first
    expect(m.rows.map((r) => r.label)).toEqual(['November 2026', 'October 2026']);
    const nov = m.rows[0] as BreakdownRow;
    const oct = m.rows[1] as BreakdownRow;
    expect(nov.days.map((d) => d.key)).toEqual(['2026-11-02', '2026-11-01']);
    expect(oct.days.map((d) => d.key)).toEqual(['2026-10-31', '2026-10-20']);
    expect(nov.days.map((d) => d.label)).toEqual(['Mon 2 Nov 2026', 'Sun 1 Nov 2026']);
    expect(oct.days.map((d) => d.label)).toEqual(['Sat 31 Oct 2026', 'Tue 20 Oct 2026']);
  });

  it('weeks start on Monday and hold the Sunday that ends them', () => {
    const s = archive();
    const w = bd(s, 'week');
    expect(w.rows.map((r) => r.key)).toEqual(['2026-11-02', '2026-10-26', '2026-10-19']);
    expect(w.rows.map((r) => r.label)).toEqual(['Week of 2 Nov 2026', 'Week of 26 Oct 2026', 'Week of 19 Oct 2026']);
    // Sat 31 Oct and Sun 1 Nov are one week although they are two months
    const mid = w.rows[1] as BreakdownRow;
    expect(mid.days.map((d) => d.key)).toEqual(['2026-11-01', '2026-10-31']);
    expect(mid.models.map((x) => x.model).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  it('days are flat rows with one day each and no nested days', () => {
    const s = archive();
    const d = bd(s, 'day');
    expect(d.rows.map((r) => [r.key, r.from, r.to, r.days.length])).toEqual([
      ['2026-11-02', '2026-11-02', '2026-11-02', 0],
      ['2026-11-01', '2026-11-01', '2026-11-01', 0],
      ['2026-10-31', '2026-10-31', '2026-10-31', 0],
      ['2026-10-20', '2026-10-20', '2026-10-20', 0],
    ]);
  });

  it('lists only days with usage: a day with only a prompt is not a row', () => {
    const s = seeder(env.dir, DHAKA, local('2026-11-03', 8));
    s.prompt('A', local('2026-10-21', 9), { cwd: '/work/a' }); // a prompt with no response after it
    s.response('A', local('2026-10-22', 9), { cwd: '/work/a' });
    finish(s);
    expect(bd(s, 'day').rows.map((r) => r.key)).toEqual(['2026-10-22']);
  });

  it('model rows are by total tokens descending with the numbers of the default response', () => {
    const s = archive();
    const oct = bd(s, 'month').rows[1] as BreakdownRow;
    // opus and the unpriced model tie on tokens and responses, so the name decides
    expect(oct.models.map((m) => m.model)).toEqual(['claude-sonnet-5-5', 'claude-mystery-1', 'claude-opus-5-5']);
    const sonnet = oct.models[0] as BreakdownModelRow;
    // 2 main responses and 1 subagent event of the default size: input 10, output 100, cache read 1000, cache write 50 each
    expect(sonnet).toMatchObject({ responses: 2, input: 30, output: 300, cacheWrite: 150, cacheRead: 3000, total: 3480, unpriced: 0 });
    // 3 events x (10 * 2000 + 100 * 10000 + 20 * 2500 + 30 * 4000 + 1000 * 100) nano dollars
    expect(nanos(sonnet.costUsd)).toBe(3 * 1_290_000);
    const mystery = oct.models[1] as BreakdownModelRow;
    expect(mystery).toMatchObject({ responses: 1, total: 1160, unpriced: 1, costUsd: 0 });
    expect(oct.totals.unpriced).toBe(1);
  });
});

describe('daylight saving in America/New_York', () => {
  // The clocks go back on Sun 2026-11-01 (a 25 hour day) and forward on Sun 2026-03-08 (23 hours). Events are placed in UTC.
  function dst(): Seeder {
    const s = seeder(env.dir, NY, utc('2026-11-04T12:00:00Z'));
    const at = (iso: string, o: { model?: string } = {}): void => void s.response('A', utc(iso), { cwd: '/work/a', ...o });
    at('2026-11-01T03:30:00Z'); // Sat 31 Oct 23:30 EDT
    at('2026-11-01T04:30:00Z'); // Sun 1 Nov 00:30 EDT
    at('2026-11-01T05:30:00Z'); // Sun 1 Nov 01:30 EDT, the first one
    at('2026-11-01T06:30:00Z'); // Sun 1 Nov 01:30 EST, the repeated hour
    at('2026-11-02T04:30:00Z'); // Sun 1 Nov 23:30 EST
    at('2026-11-02T05:30:00Z'); // Mon 2 Nov 00:30 EST
    at('2026-03-08T06:30:00Z'); // Sun 8 Mar 01:30 EST
    at('2026-03-08T07:30:00Z'); // Sun 8 Mar 03:30 EDT (02:xx does not exist)
    at('2026-03-09T03:30:00Z'); // Sun 8 Mar 23:30 EDT
    at('2026-03-09T04:30:00Z'); // Mon 9 Mar 00:30 EDT
    at('2026-04-01T03:30:00Z'); // Tue 31 Mar 23:30 EDT
    at('2026-04-01T04:30:00Z'); // Wed 1 Apr 00:30 EDT
    return finish(s);
  }

  it('the 25 hour day is one day and the 23 hour day is one day', () => {
    const s = dst();
    const d = bd(s, 'day');
    const count = (day: string): number | undefined => d.rows.find((r) => r.key === day)?.totals.responses;
    expect(count('2026-10-31')).toBe(1);
    expect(count('2026-11-01')).toBe(4); // 00:30 EDT, both 01:30s and 23:30 EST on a day that lasted 25 hours; 23:30 EDT of the night before is Oct 31
    expect(count('2026-11-02')).toBe(1);
    expect(count('2026-03-08')).toBe(3);
    expect(count('2026-03-09')).toBe(1);
  });

  it('weeks and months follow the local days across both changes', () => {
    const s = dst();
    const w = bd(s, 'week');
    // Mon 26 Oct to Sun 1 Nov holds Sat 31 Oct and all of Sunday 1 Nov; Mon 2 Nov starts the next week
    const wk = (key: string): BreakdownRow => w.rows.find((r) => r.key === key) as BreakdownRow;
    expect(wk('2026-10-26').totals.responses).toBe(5);
    expect(wk('2026-10-26').days.map((x) => x.key)).toEqual(['2026-11-01', '2026-10-31']);
    expect(wk('2026-11-02').totals.responses).toBe(1);
    // Sun 8 Mar closes the week of Mon 2 Mar; Mon 9 Mar opens the next
    expect(wk('2026-03-02').totals.responses).toBe(3);
    expect(wk('2026-03-09').totals.responses).toBe(1);

    const m = bd(s, 'month');
    const mo = (key: string): BreakdownRow => m.rows.find((r) => r.key === key) as BreakdownRow;
    expect(mo('2026-10').totals.responses).toBe(1); // only Sat 31 Oct 23:30 EDT; in UTC that event is already November
    expect(mo('2026-11').totals.responses).toBe(5);
    expect(mo('2026-03').totals.responses).toBe(5); // includes Tue 31 Mar 23:30 EDT, which is already April in UTC
    expect(mo('2026-04').totals.responses).toBe(1);
    // the second of the pair of 01:30s is not lost or doubled
    expect(sumOf(m.rows.map((r) => r.totals)).responses).toBe(12);
  });

  it('the same instants in Asia/Dhaka (no daylight saving) fall on other days, so the zone is applied once, by the rollup', () => {
    const s = seeder(env.dir, DHAKA, utc('2026-11-04T12:00:00Z'));
    s.response('A', utc('2026-10-31T17:59:00Z'), { cwd: '/work/a' }); // Sat 31 Oct 23:59 Dhaka
    s.response('A', utc('2026-10-31T18:01:00Z'), { cwd: '/work/a' }); // Sun 1 Nov 00:01 Dhaka
    finish(s);
    expect(bd(s, 'month').rows.map((r) => [r.key, r.totals.responses])).toEqual([['2026-11', 1], ['2026-10', 1]]);
  });
});

describe('clipping to the range', () => {
  it('the first and last period of a range show the clipped dates, the days inside are the days of the range', () => {
    const s = archive();
    const b = bd(s, 'month', 'from=2026-10-25&to=2026-11-01');
    expect(b.rows.map((r) => [r.key, r.from, r.to])).toEqual([
      ['2026-11', '2026-11-01', '2026-11-01'],
      ['2026-10', '2026-10-25', '2026-10-31'],
    ]);
    expect(b.rows.flatMap((r) => r.days.map((d) => d.key))).toEqual(['2026-11-01', '2026-10-31']); // 20 Oct and 2 Nov are outside
    const w = bd(s, 'week', 'from=2026-10-28&to=2026-11-03');
    expect(w.rows.map((r) => [r.key, r.from, r.to])).toEqual([
      ['2026-11-02', '2026-11-02', '2026-11-03'],
      ['2026-10-26', '2026-10-28', '2026-11-01'],
    ]);
  });

  it('a period inside the range is not clipped', () => {
    const s = archive();
    const b = bd(s, 'month', 'from=2026-09-01&to=2026-12-31');
    expect(b.rows.map((r) => [r.key, r.from, r.to])).toEqual([
      ['2026-11', '2026-11-01', '2026-11-30'],
      ['2026-10', '2026-10-01', '2026-10-31'],
    ]);
    expect(b.range).toMatchObject({ from: '2026-09-01', to: '2026-12-31' });
  });

  it('days outside the range are not summed', () => {
    const s = archive();
    expect(bd(s, 'day', 'from=2026-10-21&to=2026-10-31').rows.map((r) => r.key)).toEqual(['2026-10-31']);
  });
});

// ---------------------------------------------------------------- sums

const FILTERS = [
  '',
  'models=claude-sonnet-5-5',
  'models=claude-opus-5-5,claude-haiku-4-5',
  'projects=/work/a',
  'projects=/work/b',
  'includeSubagents=0',
  'projects=/work/a&models=claude-sonnet-5-5&includeSubagents=0',
  'from=2026-10-25&to=2026-11-01',
  'from=2026-10-20&to=2026-10-20&models=claude-mystery-1',
  'models=claude-future-9',
];

describe('every number adds up', () => {
  it('rows sum to the totals, days to their period, model rows to their row, for every period and filter', () => {
    const s = archive();
    for (const f of FILTERS) {
      for (const p of PERIODS) {
        const b = bd(s, p, f);
        const tag = `${p} ${f}`;
        expectSame(b.totals, sumOf(b.rows.map((r) => r.totals)), `${tag} totals`);
        for (const r of b.rows) {
          expectSame(r.totals, sumOf(r.models), `${tag} ${r.key} models`);
          expect(r.totals.total, `${tag} ${r.key} total`).toBe(r.totals.input + r.totals.output + r.totals.cacheWrite + r.totals.cacheRead);
          for (const m of r.models) expect(m.total).toBe(m.input + m.output + m.cacheWrite + m.cacheRead);
          if (p !== 'day') {
            expectSame(r.totals, sumOf(r.days.map((d) => d.totals)), `${tag} ${r.key} days`);
            for (const d of r.days) {
              expectSame(d.totals, sumOf(d.models), `${tag} ${d.key} models`);
              expect(d.days).toEqual([]);
              expect(d.key >= r.from && d.key <= r.to, `${tag} ${d.key} inside ${r.key}`).toBe(true);
            }
            // a model of the period is the sum of that model over its days
            for (const m of r.models) {
              const over = sumOf(r.days.flatMap((d) => d.models.filter((x) => x.model === m.model)));
              const { model: _name, ...numbers } = m;
              expectSame(numbers, over, `${tag} ${r.key} ${m.model}`);
            }
          }
        }
      }
    }
  });

  it('the totals equal /api/summary tokens, cost, responses and unpriced for the same filters', () => {
    const s = archive();
    for (const f of FILTERS) {
      const sum = body<Summary>(s, `/api/summary${f === '' ? '' : `?${f}`}`);
      for (const p of PERIODS) {
        const t = bd(s, p, f).totals;
        const tag = `${p} ${f}`;
        expect(t.input, tag).toBe(sum.tokens.input);
        expect(t.output, tag).toBe(sum.tokens.output);
        expect(t.cacheWrite, tag).toBe(sum.tokens.cacheWrite);
        expect(t.cacheRead, tag).toBe(sum.tokens.cacheRead);
        expect(t.total, tag).toBe(sum.tokens.total);
        expect(t.responses, tag).toBe(sum.responses);
        expect(t.unpriced, tag).toBe(sum.cost.unpricedResponses);
        expect(t.costUsd, tag).toBe(sum.cost.usd); // the same integer nano dollars divided once
      }
    }
  });

  it('is the same grand total whatever the period', () => {
    const s = archive();
    const [m, w, d] = PERIODS.map((p) => bd(s, p).totals);
    expect(w).toEqual(m);
    expect(d).toEqual(m);
  });
});

describe('filters behave like the other endpoints', () => {
  it('a model filter keeps only those models in every row and drops periods that have none', () => {
    const s = archive();
    const b = bd(s, 'month', 'models=claude-haiku-4-5');
    expect(b.rows.map((r) => r.key)).toEqual(['2026-11']);
    expect((b.rows[0] as BreakdownRow).models.map((m) => m.model)).toEqual(['claude-haiku-4-5']);
    expect((b.rows[0] as BreakdownRow).days.map((d) => d.key)).toEqual(['2026-11-02']);
    const none = bd(s, 'month', 'models=claude-future-9');
    expect(none.rows).toEqual([]);
    expect(none.totals.total).toBe(0);
  });

  it('a project filter keeps that project only', () => {
    const s = archive();
    const b = bd(s, 'day', 'projects=/work/b');
    expect(b.rows.map((r) => r.key)).toEqual(['2026-11-01', '2026-10-31']);
    expect(bd(s, 'day', 'projects=/work/a').rows.map((r) => r.key)).toEqual(['2026-11-02', '2026-10-20']);
  });

  it('includeSubagents=0 drops the subagent event from tokens and cost, and responses never counted it', () => {
    const s = archive();
    const all = bd(s, 'day', 'from=2026-10-20&to=2026-10-20').totals;
    const main = bd(s, 'day', 'from=2026-10-20&to=2026-10-20&includeSubagents=0').totals;
    expect(all.responses).toBe(main.responses);
    expect(all.total - main.total).toBe(1160);
    expect(nanos(all.costUsd) - nanos(main.costUsd)).toBe(1_290_000);
  });

  it('includeBackground does not change the ledger (it lists transcripts only)', () => {
    const s = archive();
    expect(bd(s, 'month', 'includeBackground=1')).toEqual(bd(s, 'month'));
  });
});

// ---------------------------------------------------------------- possibly incomplete

describe('possibly incomplete periods', () => {
  // The earliest event is 2026-09-01 and the first ingest was 2026-10-27 12:00 Dhaka: complete from 2026-09-27.
  function aged(): Seeder {
    const s = seeder(env.dir, DHAKA, local('2026-10-28', 8));
    for (const [day, hh] of [['2026-09-01', 9], ['2026-09-10', 14], ['2026-09-26', 22], ['2026-09-27', 9], ['2026-10-05', 10], ['2026-10-27', 11]] as const) {
      s.prompt('A', local(day, hh), { cwd: '/work/a' });
      s.response('A', local(day, hh, 1), { cwd: '/work/a' });
    }
    setMeta(s.db, 'archive_started_at', String(local('2026-10-27', 12)));
    return finish(s);
  }

  it('a month, week or day that overlaps the window carries the flag, the others do not', () => {
    const s = aged();
    const m = bd(s, 'month');
    expect(m.rows.map((r) => [r.key, r.partial])).toEqual([['2026-10', false], ['2026-09', true]]);
    const sep = m.rows[1] as BreakdownRow;
    expect(sep.days.map((d) => [d.key, d.partial])).toEqual([['2026-09-27', false], ['2026-09-26', true], ['2026-09-10', true], ['2026-09-01', true]]);
    const w = bd(s, 'week');
    // Sun 27 Sep closes the week of Mon 21 Sep, whose other days are still inside the window
    expect(w.rows.map((r) => [r.key, r.partial])).toEqual([['2026-10-26', false], ['2026-10-05', false], ['2026-09-21', true], ['2026-09-07', true], ['2026-08-31', true]]);
    expect(bd(s, 'day').rows.map((r) => [r.key, r.partial])).toEqual([
      ['2026-10-27', false],
      ['2026-10-05', false],
      ['2026-09-27', false],
      ['2026-09-26', true],
      ['2026-09-10', true],
      ['2026-09-01', true],
    ]);
  });

  it('a range that starts after the window has no partial period', () => {
    const s = aged();
    expect(bd(s, 'month', 'from=2026-09-27').rows.map((r) => r.partial)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------- CSV

// A small RFC 4180 reader, enough for the file under test (quoted fields, doubled quotes, CRLF).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  expect(quoted).toBe(false);
  expect(cell).toBe('');
  expect(row).toEqual([]);
  return rows;
}

describe('the CSV equals the JSON', () => {
  it('has the header, one row per period and its model rows, with the same numbers', () => {
    const s = archive();
    for (const p of PERIODS) {
      for (const f of ['', 'projects=/work/a&includeSubagents=0', 'from=2026-10-25&to=2026-11-01']) {
        const b = bd(s, p, f);
        const r = s.get(`/api/breakdown.csv?period=${p}${f === '' ? '' : `&${f}`}`);
        expect(r.status).toBe(200);
        const file = r.file;
        expect(file?.type).toBe('text/csv; charset=utf-8');
        expect(file?.filename).toBe(`usage-${p}-${b.range.from}-${b.range.to}.csv`);
        expect(file?.filename).toMatch(/^[A-Za-z0-9-]+\.csv$/);
        const lines = parseCsv(file?.text ?? '');
        expect(lines[0]).toEqual(BREAKDOWN_CSV_HEADER);
        expect(BREAKDOWN_CSV_HEADER.slice(0, 7)).toEqual(['period', 'label', 'from', 'to', 'partial', 'models', 'model']);
        const expected: string[][] = [];
        const nums = (t: BreakdownTotals): string[] => [t.responses, t.input, t.output, t.cacheWrite, t.cacheRead, t.total].map(String).concat(t.costUsd.toFixed(6), String(t.unpriced));
        for (const row of b.rows) {
          const head = [row.key, row.label, row.from, row.to, row.partial ? 'yes' : 'no'];
          expected.push([...head, row.models.map((m) => m.model).join(';'), '', ...nums(row.totals)]);
          for (const m of row.models) expected.push([...head, '', m.model, ...nums(m)]);
        }
        expect(lines.slice(1), `${p} ${f}`).toEqual(expected);
      }
    }
  });

  it('writes cost with six decimals and keeps the model joiner a plain semicolon', () => {
    const s = archive();
    const lines = parseCsv(s.get('/api/breakdown.csv?period=month').file?.text ?? '');
    const octLine = lines.find((l) => l[0] === '2026-10' && l[6] === '') as string[];
    expect(octLine[5]).toBe('claude-sonnet-5-5;claude-mystery-1;claude-opus-5-5');
    for (const l of lines.slice(1)) expect(l[13]).toMatch(/^\d+\.\d{6}$/);
  });

  it('ends every row with CRLF and escapes a model name that could be read as a formula or break a row', () => {
    const s = seeder(env.dir, DHAKA, local('2026-11-03', 8));
    s.response('A', local('2026-10-20', 9), { model: '=HYPERLINK("x")', cwd: '/work/a' });
    s.response('A', local('2026-10-20', 10), { model: 'a,b', cwd: '/work/a' });
    finish(s);
    const text = s.get('/api/breakdown.csv?period=day').file?.text ?? '';
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    const rows = parseCsv(text);
    const models = rows.slice(1).map((r) => r[6]).filter((m) => m !== '');
    expect(models.sort()).toEqual(["'=HYPERLINK(\"x\")", 'a,b']);
  });
});
