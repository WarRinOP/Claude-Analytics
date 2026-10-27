// `node src/cli.ts export --csv`: daily.csv and sessions.csv for a range and filters, with the same
// rules and the same numbers as the API. Reads the archive only. Files go under the app data folder through the path
// guard; --stdout daily|sessions prints one table instead.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, dbPath } from '../config/paths.ts';
import { guardedMkdir, guardedWriteFile } from '../config/pathGuard.ts';
import { tz as configuredTz } from '../config/settings.ts';
import { BadRequest, parseQuery, type Query } from '../metrics/filters.ts';
import { csvField, toCsv } from '../metrics/csv.ts';
import { nanosToUsd } from '../metrics/prices.ts';
import * as queries from '../metrics/queries.ts';
import { ensureRollups } from '../metrics/rollups.ts';
import { daysInRange, formatClock, localDay } from '../metrics/time.ts';
import type { Db } from '../store/db.ts';
import { stmt } from '../store/db.ts';
import { openAndMigrate } from '../store/migrate.ts';

// CSV writing lives in src/metrics/csv.ts (the breakdown download of the API uses it too).
export { csvField, toCsv };

// ---------------------------------------------------------------- tables

export interface DailyRow {
  day: string;
  prompts: number;
  responses: number;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  partial: boolean;
}

export interface SessionRow {
  sessionId: string;
  project: string;
  title: string | null;
  startLocal: string;
  endLocal: string;
  activeMinutes: number;
  prompts: number;
  responses: number;
  tokens: number;
  models: string[];
  sourceDeleted: boolean;
  costUsd: number;
}

interface Column<R> {
  header: string;
  get: (r: R) => string | number | boolean;
}

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

// The API price equivalent in dollars with six decimals, the same value the API answers.
const usdText = (usd: number): string => usd.toFixed(6);

// One entry per column. `cost_usd` is the API price equivalent, filled from the same functions the API uses.
const DAILY_COLUMNS: Column<DailyRow>[] = [
  { header: 'day', get: (r) => r.day },
  { header: 'prompts', get: (r) => r.prompts },
  { header: 'responses', get: (r) => r.responses },
  { header: 'sessions', get: (r) => r.sessions },
  { header: 'input_tokens', get: (r) => r.input },
  { header: 'output_tokens', get: (r) => r.output },
  { header: 'cache_read_tokens', get: (r) => r.cacheRead },
  { header: 'cache_write_tokens', get: (r) => r.cacheWrite },
  { header: 'total_tokens', get: (r) => r.input + r.output + r.cacheRead + r.cacheWrite },
  { header: 'partial', get: (r) => yesNo(r.partial) },
  { header: 'cost_usd', get: (r) => usdText(r.costUsd) },
];

function sessionColumns(titles: boolean): Column<SessionRow>[] {
  const cols: Column<SessionRow>[] = [
    { header: 'session_id', get: (r) => r.sessionId },
    { header: 'project', get: (r) => r.project },
    { header: 'start_local', get: (r) => r.startLocal },
    { header: 'end_local', get: (r) => r.endLocal },
    { header: 'active_minutes', get: (r) => r.activeMinutes },
    { header: 'prompts', get: (r) => r.prompts },
    { header: 'responses', get: (r) => r.responses },
    { header: 'tokens', get: (r) => r.tokens },
    { header: 'models', get: (r) => r.models.join('; ') },
    { header: 'source_deleted', get: (r) => yesNo(r.sourceDeleted) },
    { header: 'cost_usd', get: (r) => usdText(r.costUsd) },
  ];
  if (titles) cols.push({ header: 'title', get: (r) => r.title ?? '' });
  return cols;
}

export function dailyCsv(rows: DailyRow[]): string {
  return toCsv(DAILY_COLUMNS.map((c) => c.header), rows.map((r) => DAILY_COLUMNS.map((c) => c.get(r))));
}

export function sessionsCsv(rows: SessionRow[], titles: boolean): string {
  const cols = sessionColumns(titles);
  return toCsv(cols.map((c) => c.header), rows.map((r) => cols.map((c) => c.get(r))));
}

// ---------------------------------------------------------------- data (the same functions and filters as the API)

function dailyRows(ctx: queries.Ctx, q: Query): DailyRow[] {
  const parts = ['day >= ? AND day <= ?'];
  const params: Array<string | number> = [q.from, q.to];
  if (q.projects.length > 0) {
    parts.push(`project_key IN (${q.projects.map(() => '?').join(',')})`);
    params.push(...q.projects);
  }
  if (q.models.length > 0) {
    parts.push(`model IN (${q.models.map(() => '?').join(',')})`);
    params.push(...q.models);
  }
  if (!q.includeSubagents) parts.push('is_subagent_file = 0');
  const found = stmt(
    ctx.db,
    `SELECT day, SUM(prompts) AS prompts, SUM(responses) AS responses, SUM(input) AS input, SUM(output) AS output,
            SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(cost_nanos) AS cost
       FROM activity_rollup WHERE ${parts.join(' AND ')} GROUP BY day`,
  ).all(...params) as unknown as Array<{ day: string; prompts: number; responses: number; input: number; output: number; cache_read: number; cache_write: number; cost: number }>;
  const byDay = new Map(found.map((r) => [r.day, r]));
  // Sessions and the partial flag come straight from the API function, so they cannot drift from the dashboard.
  const api = queries.daily(ctx, q, 'sessions', false);
  const apiDay = new Map(api.days.map((d) => [d.day, d]));
  return daysInRange(q.from, q.to).map((day) => {
    const r = byDay.get(day);
    const a = apiDay.get(day);
    return {
      day,
      prompts: r?.prompts ?? 0,
      responses: r?.responses ?? 0,
      sessions: a?.total ?? 0,
      input: r?.input ?? 0,
      output: r?.output ?? 0,
      cacheRead: r?.cache_read ?? 0,
      cacheWrite: r?.cache_write ?? 0,
      costUsd: nanosToUsd(r?.cost ?? 0),
      partial: a?.partial ?? false,
    };
  });
}

const localStamp = (ts: number, tz: string): string => `${localDay(ts, tz)} ${formatClock(ts, tz)}`;

function sessionRows(ctx: queries.Ctx, q: Query): SessionRow[] {
  const all = queries.sessions(ctx, q, { page: 1, pageSize: Number.MAX_SAFE_INTEGER, sort: 'start' });
  return all.rows
    .map((s) => ({
      sessionId: s.sessionId,
      project: s.displayName,
      title: s.title,
      startLocal: localStamp(s.firstTs, ctx.tz),
      endLocal: localStamp(s.lastTs, ctx.tz),
      activeMinutes: Math.round(s.activeMs / 6000) / 10,
      prompts: s.prompts,
      responses: s.responses,
      tokens: s.tokens,
      models: s.models,
      sourceDeleted: s.sourceDeleted,
      costUsd: s.costUsd,
    }))
    .reverse(); // oldest first
}

// ---------------------------------------------------------------- command

function usage(): string {
  return [
    'Usage: node src/cli.ts export --csv [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--models a,b] [--projects key1,key2] [--titles]',
    '       node src/cli.ts export --stdout daily|sessions [same filters]',
    'Files go to the exports folder inside the app data folder. Dates are local days. Titles are left out unless --titles is given.',
  ].join('\n');
}

interface ExportArgs {
  csv: boolean;
  stdout: 'daily' | 'sessions' | null;
  titles: boolean;
  params: URLSearchParams;
}

function parseArgs(args: string[]): ExportArgs | string {
  const out: ExportArgs = { csv: false, stdout: null, titles: false, params: new URLSearchParams() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const value = (): string | undefined => (eq === -1 ? args[++i] : a.slice(eq + 1));
    if (name === '--csv' && eq === -1) out.csv = true;
    else if (name === '--titles' && eq === -1) out.titles = true;
    else if (name === '--stdout') {
      const v = value();
      if (v !== 'daily' && v !== 'sessions') return '--stdout needs daily or sessions.';
      out.stdout = v;
    } else if (name === '--from' || name === '--to' || name === '--models' || name === '--projects') {
      const v = value();
      if (v === undefined || v === '') return `${name} needs a value.`;
      out.params.set(name.slice(2), v);
    } else return `Unknown option for export: ${a.slice(0, 40)}\n${usage()}`;
  }
  if (!out.csv && out.stdout === null) return `Choose an output format. Only --csv is supported.\n${usage()}`;
  return out;
}

function stamp(now: number, tz: string): string {
  return `${localDay(now, tz).replace(/-/g, '')}-${formatClock(now, tz).replace(/:/g, '')}`;
}

export async function cmdExport(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }
  let zone: string;
  try {
    zone = configuredTz();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!existsSync(dbPath())) {
    console.error('There is no archive yet. Run node src/cli.ts ingest first.');
    return 1;
  }
  const { db } = openAndMigrate(dbPath());
  try {
    return runExport(db, zone, parsed);
  } catch (err) {
    if (err instanceof BadRequest) console.error(err.message);
    else console.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}

function runExport(db: Db, zone: string, a: ExportArgs): number {
  const now = Date.now();
  const ctx: queries.Ctx = { db, tz: zone, now: () => now };
  ensureRollups(db, zone); // the same repair the server runs at start
  const q = parseQuery(a.params, { tz: zone, today: queries.todayOfCtx(ctx), archiveStart: queries.archiveStart(ctx) });

  if (a.stdout !== null) {
    process.stdout.write(a.stdout === 'daily' ? dailyCsv(dailyRows(ctx, q)) : sessionsCsv(sessionRows(ctx, q), a.titles));
    return 0;
  }

  const daily = dailyCsv(dailyRows(ctx, q));
  const sess = sessionsCsv(sessionRows(ctx, q), a.titles);
  const base = join(dataDir(), 'exports');
  let dir = join(base, stamp(now, zone));
  for (let n = 2; existsSync(dir); n++) dir = join(base, `${stamp(now, zone)}-${n}`);
  guardedMkdir(dir);
  const dailyPath = guardedWriteFile(join(dir, 'daily.csv'), daily);
  const sessionsPath = guardedWriteFile(join(dir, 'sessions.csv'), sess);
  console.log(
    [
      `Exported ${q.from} to ${q.to} (times in ${zone}).`,
      `  ${dailyPath}`,
      `  ${sessionsPath}`,
      a.titles ? 'Session titles are included.' : 'Session titles are left out. Add --titles to include them.',
    ].join('\n'),
  );
  return 0;
}
