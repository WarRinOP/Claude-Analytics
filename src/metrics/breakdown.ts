// The usage breakdown ledger: tokens and API price equivalent by month, week or day, with the days of a
// month or week nested in its row and a per model split in every row.
//
// Everything comes from activity_rollup (one scan, grouped by local day and model) plus the local calendar, so there is no
// per event scan and the numbers are the same integers the summary adds up. Periods are named by calendar arithmetic on the
// local day strings the rollup already holds, which keeps a month or week right across daylight saving changes: the zone was
// applied once, when the event was given its local day.
import type { Breakdown, BreakdownModelRow, BreakdownPeriod, BreakdownRow, BreakdownTotals } from '../api/types.ts';
import { toCsv } from './csv.ts';
import { BadRequest, type Query } from './filters.ts';
import { PRICE_TABLE_DATE, nanosToUsd } from './prices.ts';
import { completeFrom, archiveStart, rangeInfo, rollupWhere, rows, type Ctx } from './queries.ts';
import { addDays, dayFromNumber, dayNumber, weekdayMonday0 } from './time.ts';

// ---------------------------------------------------------------- calendar (pure)

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parts(day: string): [number, number, number] {
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

// The key of the period that holds a local day: 'YYYY-MM', the Monday of its week, or the day itself.
export function periodKey(period: BreakdownPeriod, day: string): string {
  if (period === 'month') return day.slice(0, 7);
  if (period === 'week') return addDays(day, -weekdayMonday0(day));
  return day;
}

// First and last calendar day of a period, before any clipping to the range.
export function periodSpan(period: BreakdownPeriod, key: string): [string, string] {
  if (period === 'day') return [key, key];
  if (period === 'week') return [key, addDays(key, 6)];
  const first = `${key}-01`;
  const [y, m] = parts(first);
  const next = m === 12 ? `${String(y + 1).padStart(4, '0')}-01-01` : `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-01`;
  return [first, dayFromNumber(dayNumber(next) - 1)];
}

// 'October 2026', 'Week of 26 Oct 2026', 'Tue 27 Oct 2026'. Days are not zero padded, like everywhere else in the dashboard.
export function periodLabel(period: BreakdownPeriod, key: string): string {
  if (period === 'month') {
    const [y, m] = parts(`${key}-01`);
    return `${MONTHS_LONG[m - 1] ?? ''} ${y}`;
  }
  const [y, m, d] = parts(key);
  const date = `${d} ${MONTHS_SHORT[m - 1] ?? ''} ${y}`;
  return period === 'week' ? `Week of ${date}` : `${WEEKDAYS[weekdayMonday0(key)] ?? ''} ${date}`;
}

const maxDay = (a: string, b: string): string => (a > b ? a : b);
const minDay = (a: string, b: string): string => (a < b ? a : b);

// The days of a period inside the range: its span clipped to [from, to].
export function clippedSpan(period: BreakdownPeriod, key: string, from: string, to: string): [string, string] {
  const [first, last] = periodSpan(period, key);
  return [maxDay(first, from), minDay(last, to)];
}

// A span is possibly incomplete when it overlaps [archiveStart, completeFrom): the same window the charts mark per day.
export function spanIsPartial(first: string, last: string, start: string | null, complete: string | null): boolean {
  return start !== null && complete !== null && complete > start && first < complete && last >= start;
}

export function parsePeriod(p: URLSearchParams): BreakdownPeriod {
  const all = p.getAll('period');
  if (all.length > 1) throw new BadRequest('The parameter period was given more than once.');
  const v = all[0] ?? '';
  if (v === '') return 'month';
  if (v === 'month' || v === 'week' || v === 'day') return v;
  throw new BadRequest('The parameter period must be month, week or day.');
}

// ---------------------------------------------------------------- accumulation

interface Acc {
  responses: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costNanos: number; // integer nano dollars of the priced events
  unpriced: number;
}

const empty = (): Acc => ({ responses: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costNanos: 0, unpriced: 0 });

function add(into: Acc, from: Acc): void {
  into.responses += from.responses;
  into.input += from.input;
  into.output += from.output;
  into.cacheWrite += from.cacheWrite;
  into.cacheRead += from.cacheRead;
  into.costNanos += from.costNanos;
  into.unpriced += from.unpriced;
}

const totalsOf = (a: Acc): BreakdownTotals => ({
  responses: a.responses,
  input: a.input,
  output: a.output,
  cacheWrite: a.cacheWrite,
  cacheRead: a.cacheRead,
  total: a.input + a.output + a.cacheWrite + a.cacheRead,
  costUsd: nanosToUsd(a.costNanos),
  unpriced: a.unpriced,
});

// Models of one row, by total tokens descending, then responses, then name (the order the Models table uses).
function modelRows(models: Map<string, Acc>): BreakdownModelRow[] {
  return [...models.entries()]
    .map(([model, a]) => ({ model, ...totalsOf(a) }))
    .sort((a, b) => b.total - a.total || b.responses - a.responses || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

function sumModels(models: Iterable<Map<string, Acc>>): { models: Map<string, Acc>; all: Acc } {
  const merged = new Map<string, Acc>();
  const all = empty();
  for (const m of models) {
    for (const [name, a] of m) {
      let into = merged.get(name);
      if (into === undefined) merged.set(name, (into = empty()));
      add(into, a);
      add(all, a);
    }
  }
  return { models: merged, all };
}

interface DbRow {
  day: string;
  model: string;
  responses: number;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cost: number;
  unpriced: number;
}

// ---------------------------------------------------------------- the endpoint

export function breakdown(ctx: Ctx, q: Query, period: BreakdownPeriod): Breakdown {
  const w = rollupWhere(q);
  const found = rows<DbRow>(ctx.db, {
    sql: `SELECT day, model, SUM(responses) AS responses, SUM(input) AS input, SUM(output) AS output, SUM(cache_write) AS cache_write,
                 SUM(cache_read) AS cache_read, SUM(cost_nanos) AS cost, SUM(unpriced) AS unpriced
            FROM activity_rollup WHERE ${w.sql} AND model <> '' GROUP BY day, model`,
    params: w.params,
  });

  // day -> model -> sums. Rows that hold only prompts (no usage at all) are not usage and are left out.
  const byDay = new Map<string, Map<string, Acc>>();
  for (const r of found) {
    if (r.responses === 0 && r.input === 0 && r.output === 0 && r.cache_write === 0 && r.cache_read === 0 && r.cost === 0 && r.unpriced === 0) continue;
    let models = byDay.get(r.day);
    if (models === undefined) byDay.set(r.day, (models = new Map()));
    models.set(r.model, {
      responses: r.responses,
      input: r.input,
      output: r.output,
      cacheWrite: r.cache_write,
      cacheRead: r.cache_read,
      costNanos: r.cost,
      unpriced: r.unpriced,
    });
  }

  const start = archiveStart(ctx);
  const complete = completeFrom(ctx, start);
  const dayRow = (day: string, models: Map<string, Acc>): BreakdownRow => {
    const { all } = sumModels([models]);
    return {
      key: day,
      label: periodLabel('day', day),
      from: day,
      to: day,
      partial: spanIsPartial(day, day, start, complete),
      models: modelRows(models),
      totals: totalsOf(all),
      days: [],
    };
  };

  const newestFirst = (a: BreakdownRow, b: BreakdownRow): number => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
  const days = [...byDay.entries()].map(([day, models]) => dayRow(day, models)).sort(newestFirst);

  let out: BreakdownRow[];
  if (period === 'day') {
    out = days;
  } else {
    const groups = new Map<string, BreakdownRow[]>();
    for (const d of days) {
      const key = periodKey(period, d.key);
      let g = groups.get(key);
      if (g === undefined) groups.set(key, (g = []));
      g.push(d);
    }
    out = [...groups.entries()]
      .map(([key, children]): BreakdownRow => {
        const { models, all } = sumModels(children.map((c) => byDay.get(c.key) as Map<string, Acc>));
        const [from, to] = clippedSpan(period, key, q.from, q.to);
        return { key, label: periodLabel(period, key), from, to, partial: spanIsPartial(from, to, start, complete), models: modelRows(models), totals: totalsOf(all), days: children };
      })
      .sort(newestFirst);
  }

  const grand = sumModels(byDay.values()).all;
  return { range: rangeInfo(ctx, q, start), period, rows: out, totals: totalsOf(grand), priceTableDate: PRICE_TABLE_DATE };
}

// ---------------------------------------------------------------- CSV

export const BREAKDOWN_CSV_HEADER = [
  'period',
  'label',
  'from',
  'to',
  'partial',
  'models',
  'model',
  'responses',
  'input',
  'output',
  'cache_write',
  'cache_read',
  'total',
  'cost_usd',
  'unpriced_events',
];

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');
const nums = (t: BreakdownTotals): Array<string | number> => [t.responses, t.input, t.output, t.cacheWrite, t.cacheRead, t.total, t.costUsd.toFixed(6), t.unpriced];

// One row per period (the days inside it are not listed: the file is the chosen level), each followed by its per model rows.
// A period row has an empty `model` column; a model row repeats the period and has an empty `models` column.
export function breakdownCsv(b: Breakdown): string {
  const lines: Array<Array<string | number | boolean>> = [];
  for (const r of b.rows) {
    lines.push([r.key, r.label, r.from, r.to, yesNo(r.partial), r.models.map((m) => m.model).join(';'), '', ...nums(r.totals)]);
    for (const m of r.models) lines.push([r.key, r.label, r.from, r.to, yesNo(r.partial), '', m.model, ...nums(m)]);
  }
  return toCsv(BREAKDOWN_CSV_HEADER, lines);
}

// usage-<period>-<from>-<to>.csv, from the range of the answer.
export const breakdownFileName = (b: Breakdown): string => `usage-${b.period}-${b.range.from}-${b.range.to}.csv`;
