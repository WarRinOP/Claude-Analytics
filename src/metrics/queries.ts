// One function per API endpoint, each returning exactly the shape in src/api/types.ts.
//
// Where numbers come from:
//   activity_rollup  day, hour, model, project and token aggregates (additive, cheap).
//   fact tables      distinct sessions, active time, the day strip and the sessions table, read with UTC bounds that
//                    are computed from the local dates, so they stay right on 23 and 25 hour days.
//
// Events and filters:
//   prompt    messages kind 'prompt' and is_sidechain 0. Its model for filtering is attributed_model.
//   response  usage event with is_sidechain 0 and is_subagent_file 0.
//   A session is active in a range when it has a prompt or a response in it. Session level times (first, last, active,
//   wall) use every prompt plus every usage event of the session that passes the filters, subagent files included
//   unless includeSubagents is 0.
import { statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  ActivityMetric,
  DayDetail,
  Daily,
  Definitions,
  Filters,
  Health,
  Heatmap,
  Hours,
  Models,
  Projects,
  RangeInfo,
  Sessions,
  Summary,
  TokenTotals,
} from '../api/types.ts';
import { sourceRoot as defaultSourceRoot } from '../config/paths.ts';
import { appVersion, retentionDays } from '../config/settings.ts';
import type { SyncStatus } from '../ingest/scheduler.ts';
import { stmt, type Db } from '../store/db.ts';
import type { QueryCache } from './cache.ts';
import { DEFINITIONS } from './definitions.ts';
import { aliases, checkCanary, costCheck, entrypoints, lastPass, missingFields, prices, recentErrors, unknownTypes, versions } from './health.ts';
import type { Paging, Query } from './filters.ts';
import { NANOS_PER_USD, PRICE_TABLE_DATE, nanosToUsd } from './prices.ts';
import {
  DAY_MS,
  addDays,
  dayBounds,
  dayCount,
  dayNumber,
  daysInRange,
  localDay,
  makeLocalizer,
  rangeBounds,
  today as todayOf,
  weekdayMonday0,
} from './time.ts';

export interface Ctx {
  db: Db;
  tz: string;
  now: () => number;
  // How long Claude Code keeps a transcript, in days. Absent: LEDGER_RETENTION_DAYS or 30.
  retentionDays?: number;
  // The transcript folder shown in the health report, and Claude Code's live session folder the canary reads. Absent:
  // CLAUDE_CONFIG_DIR or ~/.claude, like the ingest. Tests give temp folders.
  sourceRoot?: string;
  sessionsDir?: string;
  // Answers of the queries that scan the fact tables are kept here between requests (the server gives one and clears it
  // after every sync pass that changed something). Absent: every call computes.
  cache?: QueryCache;
}

// The cached value of `compute` under `key`, or its fresh value when there is no cache. Cached values are read only.
function memo<T>(ctx: Ctx, key: string, compute: () => T): T {
  return ctx.cache === undefined ? compute() : ctx.cache.get(key, compute);
}

// The parts of a query that decide which fact rows count, as a cache key. Order of the lists does not matter.
function filterKey(q: Query): string {
  return JSON.stringify([[...q.models].sort(), [...q.projects].sort(), q.includeSubagents]);
}

export const ACTIVE_GAP_MS = 30 * 60 * 1000;
// Label for prompts whose model is not known yet (no response after them so far).
export const NO_MODEL_LABEL = '(unattributed)';
const UNKNOWN_PROJECT = '(unknown project)';

type Param = string | number;
export interface Frag {
  sql: string;
  params: Param[];
}

const frag = (sql: string, params: Param[] = []): Frag => ({ sql, params });
const marks = (n: number): string => new Array(n).fill('?').join(',');
const inList = (col: string, values: string[]): Frag => frag(`${col} IN (${marks(values.length)})`, values);

function all(parts: Frag[]): Frag {
  return frag(parts.map((p) => `(${p.sql})`).join(' AND '), parts.flatMap((p) => p.params));
}

export function rows<T>(db: Db, f: Frag): T[] {
  return stmt(db, f.sql).all(...f.params) as unknown as T[];
}

// ---------------------------------------------------------------- filters as SQL

const MAIN_RESPONSE = 'u.is_sidechain = 0 AND u.is_subagent_file = 0';
const SESSIONS_IN_PROJECTS = (projects: string[]): Frag =>
  frag(`session_id IN (SELECT session_id FROM sessions WHERE project_key IN (${marks(projects.length)}))`, projects);

// rollup rows for local days from..to
export function rollupWhere(q: Query, from: string = q.from, to: string = q.to): Frag {
  const parts: Frag[] = [frag('day >= ? AND day <= ?', [from, to])];
  if (q.projects.length > 0) parts.push(inList('project_key', q.projects));
  if (q.models.length > 0) parts.push(inList('model', q.models));
  if (!q.includeSubagents) parts.push(frag('is_subagent_file = 0'));
  return all(parts);
}

// prompts (alias m) in the UTC window
function promptWhere(q: Query, startMs: number, endMs: number): Frag {
  const parts: Frag[] = [frag("m.kind = 'prompt' AND m.is_sidechain = 0 AND m.ts >= ? AND m.ts < ?", [startMs, endMs])];
  if (q.models.length > 0) parts.push(inList('m.attributed_model', q.models));
  if (q.projects.length > 0) {
    const p = SESSIONS_IN_PROJECTS(q.projects);
    parts.push(frag(`m.${p.sql}`, p.params));
  }
  return all(parts);
}

// usage events (alias u) in the UTC window; mainOnly keeps responses only
function usageWhere(q: Query, startMs: number, endMs: number, mainOnly: boolean): Frag {
  const parts: Frag[] = [frag('u.ts >= ? AND u.ts < ?', [startMs, endMs])];
  if (mainOnly) parts.push(frag(MAIN_RESPONSE));
  else if (!q.includeSubagents) parts.push(frag('u.is_subagent_file = 0'));
  if (q.models.length > 0) parts.push(inList('u.model', q.models));
  if (q.projects.length > 0) {
    const p = SESSIONS_IN_PROJECTS(q.projects);
    parts.push(frag(`u.${p.sql}`, p.params));
  }
  return all(parts);
}

const TOKENS_U = '(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens)';

// columns: session_id, ts for prompts and responses on the main thread
function mainActivity(q: Query, startMs: number, endMs: number): Frag {
  const p = promptWhere(q, startMs, endMs);
  const u = usageWhere(q, startMs, endMs, true);
  return frag(
    `SELECT m.session_id AS session_id, m.ts AS ts FROM messages m WHERE ${p.sql}
     UNION ALL SELECT u.session_id, u.ts FROM usage_events u WHERE ${u.sql}`,
    [...p.params, ...u.params],
  );
}

// columns: session_id, ts, is_prompt, is_resp, tokens, cost (nano dollars) for the prompts and every usage event that passes the filters
function sessionEvents(q: Query, startMs: number, endMs: number): Frag {
  const p = promptWhere(q, startMs, endMs);
  const u = usageWhere(q, startMs, endMs, false);
  return frag(
    `SELECT m.session_id AS session_id, m.ts AS ts, 1 AS is_prompt, 0 AS is_resp, 0 AS tokens, 0 AS cost FROM messages m WHERE ${p.sql}
     UNION ALL SELECT u.session_id, u.ts, 0, CASE WHEN ${MAIN_RESPONSE} THEN 1 ELSE 0 END, ${TOKENS_U}, COALESCE(u.cost_nanos, 0) FROM usage_events u WHERE ${u.sql}`,
    [...p.params, ...u.params],
  );
}

// ---------------------------------------------------------------- shared pieces

export function archiveStart(ctx: Ctx): string | null {
  const r = stmt(
    ctx.db,
    `SELECT MIN(a) AS ts FROM (SELECT MIN(ts) AS a FROM usage_events UNION ALL SELECT MIN(ts) FROM messages)`,
  ).get() as { ts: number | null };
  return r.ts === null ? null : localDay(r.ts, ctx.tz);
}

export function todayOfCtx(ctx: Ctx): string {
  return todayOf(ctx.tz, ctx.now());
}

// When the archive began: meta.archive_started_at (set once by the first ingest pass), else the oldest source file row.
// Null when neither exists (a database that was filled without an ingest pass).
export function archiveStartedAt(ctx: Ctx): number | null {
  const m = stmt(ctx.db, "SELECT value FROM meta WHERE key = 'archive_started_at'").get() as { value: string } | undefined;
  if (m !== undefined) {
    const n = Number(m.value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const f = stmt(ctx.db, 'SELECT MIN(first_seen_at) AS ts FROM source_files').get() as { ts: number | null };
  return f.ts;
}

// First local day from which the archive is complete: the local day of (first ingest minus the retention window),
// never before the archive start. Days from the archive start up to the day before this one are possibly incomplete.
// Null when nothing is archived. When the start of the archive is unknown, nothing is marked (the archive start).
export function completeFrom(ctx: Ctx, start: string | null = archiveStart(ctx)): string | null {
  if (start === null) return null;
  const at = archiveStartedAt(ctx);
  if (at === null) return start;
  const keep = (ctx.retentionDays ?? retentionDays()) * DAY_MS;
  const day = localDay(at - keep, ctx.tz);
  return day < start ? start : day;
}

export function rangeInfo(ctx: Ctx, q: Query, start: string | null = archiveStart(ctx)): RangeInfo {
  const from = completeFrom(ctx, start);
  return {
    from: q.from,
    to: q.to,
    days: dayCount(q.from, q.to),
    tz: ctx.tz,
    archiveStart: start,
    coverageGap: start !== null && q.from < start,
    completeFrom: from,
    partialGap: start !== null && from !== null && from > start && q.from < from && q.to >= start,
  };
}

interface SessionStat {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  activeMs: number;
  prompts: number;
  responses: number;
  tokens: number;
  costNanos: number;
}

// One row per session with a prompt or response in the window.
function sessionStats(ctx: Ctx, q: Query, startMs: number, endMs: number): SessionStat[] {
  if (endMs <= startMs) return [];
  // A copy, because callers sort the list they get.
  return [...memo(ctx, `sessionStats|${startMs}|${endMs}|${filterKey(q)}`, () => computeSessionStats(ctx.db, q, startMs, endMs))];
}

function computeSessionStats(db: Db, q: Query, startMs: number, endMs: number): SessionStat[] {
  const ev = sessionEvents(q, startMs, endMs);
  const f = frag(
    `WITH ev AS (${ev.sql}),
          g AS (SELECT session_id, ts, is_prompt, is_resp, tokens, cost,
                       ts - LAG(ts) OVER (PARTITION BY session_id ORDER BY ts) AS gap FROM ev)
     SELECT session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, SUM(is_prompt) AS prompts, SUM(is_resp) AS responses,
            SUM(tokens) AS tokens, SUM(cost) AS cost, SUM(CASE WHEN gap <= ${ACTIVE_GAP_MS} THEN gap ELSE 0 END) AS active_ms
       FROM g GROUP BY session_id HAVING SUM(is_prompt) + SUM(is_resp) > 0`,
    ev.params,
  );
  return rows<{ session_id: string; first_ts: number; last_ts: number; prompts: number; responses: number; tokens: number; cost: number; active_ms: number }>(db, f).map(
    (r) => ({
      sessionId: r.session_id,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      activeMs: r.active_ms,
      prompts: r.prompts,
      responses: r.responses,
      tokens: r.tokens,
      costNanos: r.cost,
    }),
  );
}

interface SessionInfo {
  projectKey: string;
  displayName: string;
  title: string | null;
  hasSubagents: boolean;
}

// Project, name and title of sessions. `ids` limits the lookup; without it every session is returned.
function sessionInfo(db: Db, ids?: string[]): Map<string, SessionInfo> {
  const sql = `SELECT s.session_id AS id, s.project_key AS project_key, s.has_subagents AS has_sub,
                      COALESCE(p.display_name, '') AS display_name, t.title AS title
                 FROM sessions s LEFT JOIN projects p ON p.project_key = s.project_key
                 LEFT JOIN session_titles t ON t.session_id = s.session_id`;
  const found =
    ids === undefined
      ? (stmt(db, sql).all() as unknown as Array<{ id: string; project_key: string; has_sub: number; display_name: string; title: string | null }>)
      : ids.length === 0
        ? []
        : (stmt(db, `${sql} WHERE s.session_id IN (${marks(ids.length)})`).all(...ids) as unknown as Array<{
            id: string;
            project_key: string;
            has_sub: number;
            display_name: string;
            title: string | null;
          }>);
  const out = new Map<string, SessionInfo>();
  for (const r of found) {
    out.set(r.id, { projectKey: r.project_key, displayName: r.display_name !== '' ? r.display_name : r.project_key, title: r.title, hasSubagents: r.has_sub === 1 });
  }
  return out;
}

function infoOf(map: Map<string, SessionInfo>, id: string): SessionInfo {
  return map.get(id) ?? { projectKey: '', displayName: UNKNOWN_PROJECT, title: null, hasSubagents: false };
}

interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function totalsOf(t: TokenSums): TokenTotals {
  return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, total: t.input + t.output + t.cacheRead + t.cacheWrite };
}

// Distinct sessions per local day or per local hour of day, from the fact tables.
function sessionBuckets(ctx: Ctx, q: Query, startMs: number, endMs: number, by: 'day' | 'hour'): Map<string | number, number> {
  if (endMs <= startMs) return new Map();
  // Main thread activity ignores includeSubagents, so the key leaves it out.
  const key = `sessionBuckets|${by}|${ctx.tz}|${startMs}|${endMs}|${JSON.stringify([[...q.models].sort(), [...q.projects].sort()])}`;
  return memo(ctx, key, () => computeSessionBuckets(ctx, q, startMs, endMs, by));
}

function computeSessionBuckets(ctx: Ctx, q: Query, startMs: number, endMs: number, by: 'day' | 'hour'): Map<string | number, number> {
  const out = new Map<string | number, number>();
  const act = mainActivity(q, startMs, endMs);
  const found = rows<{ session_id: string; ts: number }>(ctx.db, frag(`SELECT session_id, ts FROM (${act.sql})`, act.params));
  if (found.length === 0) return out;
  const loc = makeLocalizer(ctx.tz, startMs, endMs - 1);
  const sets = new Map<string | number, Set<string>>();
  for (const r of found) {
    const key = by === 'day' ? loc.day(r.ts) : loc.hour(r.ts);
    let s = sets.get(key);
    if (s === undefined) sets.set(key, (s = new Set()));
    s.add(r.session_id);
  }
  for (const [k, s] of sets) out.set(k, s.size);
  return out;
}

// ---------------------------------------------------------------- models and background calls

interface ModelRow {
  model: string;
  responses: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costNanos: number;
  priced: boolean; // false when the model has events without a price (the model is not in the price table)
}

function modelRows(db: Db, q: Query): ModelRow[] {
  const w = rollupWhere(q);
  const found = rows<{ model: string; responses: number; input: number; output: number; cache_read: number; cache_write: number; cost: number; unpriced: number }>(
    db,
    frag(
      `SELECT model, SUM(responses) AS responses, SUM(input) AS input, SUM(output) AS output,
              SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(cost_nanos) AS cost, SUM(unpriced) AS unpriced
         FROM activity_rollup WHERE ${w.sql} AND model <> '' GROUP BY model`,
      w.params,
    ),
  );
  return found
    .map((r) => ({
      model: r.model,
      responses: r.responses,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      total: r.input + r.output + r.cache_read + r.cache_write,
      costNanos: r.cost,
      priced: r.unpriced === 0,
    }))
    .filter((r) => r.total > 0 || r.responses > 0)
    .sort((a, b) => b.total - a.total || b.responses - a.responses || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

interface BackgroundRow {
  model: string;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number; // Claude Code's own costUSD from the snapshots
}

// Models in a session's last cost-state snapshot that never appear in that session's transcript, placed on the local
// day of the session's first event. Ranges, model and project filters apply; includeSubagents does not.
function backgroundRows(ctx: Ctx, q: Query): BackgroundRow[] {
  const snaps = stmt(
    ctx.db,
    `SELECT cs.session_id AS id, cs.model_usage_json AS json, s.project_key AS project_key,
            COALESCE(s.first_ts, (SELECT MIN(u.ts) FROM usage_events u WHERE u.session_id = cs.session_id)) AS first_ts
       FROM cost_snapshots cs LEFT JOIN sessions s ON s.session_id = cs.session_id`,
  ).all() as unknown as Array<{ id: string; json: string; project_key: string | null; first_ts: number | null }>;
  const seen = new Map<string, Set<string>>();
  for (const r of stmt(ctx.db, 'SELECT DISTINCT session_id AS id, model FROM usage_events').all() as unknown as Array<{ id: string; model: string }>) {
    let s = seen.get(r.id);
    if (s === undefined) seen.set(r.id, (s = new Set()));
    s.add(r.model);
  }
  const acc = new Map<string, BackgroundRow>();
  for (const s of snaps) {
    if (s.first_ts === null || s.first_ts < q.startMs || s.first_ts >= q.endMs) continue;
    if (q.projects.length > 0 && !(s.project_key !== null && q.projects.includes(s.project_key))) continue;
    let usage: Record<string, Record<string, unknown>>;
    try {
      usage = JSON.parse(s.json) as Record<string, Record<string, unknown>>;
    } catch {
      continue;
    }
    const inTranscript = seen.get(s.id);
    for (const [model, u] of Object.entries(usage)) {
      if (inTranscript?.has(model) === true) continue;
      if (q.models.length > 0 && !q.models.includes(model)) continue;
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
      const input = n(u['inputTokens']);
      const output = n(u['outputTokens']);
      const cacheRead = n(u['cacheReadInputTokens']);
      const cacheWrite = n(u['cacheCreationInputTokens']);
      const total = input + output + cacheRead + cacheWrite;
      if (total === 0) continue;
      let row = acc.get(model);
      if (row === undefined) acc.set(model, (row = { model, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 }));
      row.sessions += 1;
      row.input += input;
      row.output += output;
      row.cacheRead += cacheRead;
      row.cacheWrite += cacheWrite;
      row.total += total;
      row.costUsd += typeof u['costUSD'] === 'number' && Number.isFinite(u['costUSD']) && u['costUSD'] > 0 ? u['costUSD'] : 0;
    }
  }
  return [...acc.values()].sort((a, b) => b.total - a.total || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

// ---------------------------------------------------------------- summary

function streaks(active: Set<string>): { longest: { days: number; from: string; to: string } | null } {
  const sorted = [...active].sort();
  let best: { days: number; from: string; to: string } | null = null;
  let runStart = '';
  let prev = '';
  let len = 0;
  const close = (): void => {
    if (len > 0 && (best === null || len > best.days)) best = { days: len, from: runStart, to: prev };
  };
  for (const d of sorted) {
    if (len > 0 && dayNumber(d) - dayNumber(prev) === 1) {
      len += 1;
    } else {
      close();
      runStart = d;
      len = 1;
    }
    prev = d;
  }
  close();
  return { longest: best };
}

function currentStreak(active: Set<string>, to: string, today: string): number {
  const anchor = to < today ? to : today;
  let d: string;
  if (active.has(anchor)) d = anchor;
  else if (anchor === today && active.has(addDays(today, -1))) d = addDays(today, -1);
  else return 0;
  let n = 0;
  while (active.has(d)) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}

export function summary(ctx: Ctx, q: Query): Summary {
  const w = rollupWhere(q);
  const start = archiveStart(ctx);
  const t = stmt(
    ctx.db,
    `SELECT COALESCE(SUM(prompts), 0) AS prompts, COALESCE(SUM(responses), 0) AS responses, COALESCE(SUM(input), 0) AS input,
            COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS cache_read, COALESCE(SUM(cache_write), 0) AS cache_write,
            COALESCE(SUM(cost_nanos), 0) AS cost, COALESCE(SUM(unpriced), 0) AS unpriced
       FROM activity_rollup WHERE ${w.sql}`,
  ).get(...w.params) as { prompts: number; responses: number; input: number; output: number; cache_read: number; cache_write: number; cost: number; unpriced: number };

  const perDay = rows<{ day: string; n: number }>(ctx.db, frag(`SELECT day, SUM(prompts + responses) AS n FROM activity_rollup WHERE ${w.sql} GROUP BY day`, w.params));
  const perHour = rows<{ hour: number; n: number }>(ctx.db, frag(`SELECT hour, SUM(prompts + responses) AS n FROM activity_rollup WHERE ${w.sql} GROUP BY hour`, w.params));

  const active = new Set<string>();
  let peakDay: Summary['peakDay'] = null;
  for (const r of perDay) {
    if (r.n <= 0) continue;
    active.add(r.day);
    if (peakDay === null || r.n > peakDay.messages || (r.n === peakDay.messages && r.day < peakDay.day)) peakDay = { day: r.day, messages: r.n };
  }
  let peakHour: Summary['peakHour'] = null;
  for (const r of perHour) {
    if (r.n <= 0) continue;
    if (peakHour === null || r.n > peakHour.messages || (r.n === peakHour.messages && r.hour < peakHour.hour)) peakHour = { hour: r.hour, messages: r.n };
  }

  const models = modelRows(ctx.db, q);
  const favorite = models[0];

  const stats = sessionStats(ctx, q, q.startMs, q.endMs);
  let best: SessionStat | null = null;
  for (const s of stats) {
    const wall = s.lastTs - s.firstTs;
    if (best === null || s.activeMs > best.activeMs || (s.activeMs === best.activeMs && (wall > best.lastTs - best.firstTs || (wall === best.lastTs - best.firstTs && s.sessionId < best.sessionId)))) best = s;
  }
  let longestSession: Summary['longestSession'] = null;
  if (best !== null) {
    const info = infoOf(sessionInfo(ctx.db, [best.sessionId]), best.sessionId);
    longestSession = {
      sessionId: best.sessionId,
      projectKey: info.projectKey,
      displayName: info.displayName,
      title: info.title,
      activeMs: best.activeMs,
      wallMs: best.lastTs - best.firstTs,
    };
  }

  let tokens = totalsOf({ input: t.input, output: t.output, cacheRead: t.cache_read, cacheWrite: t.cache_write });
  let backgroundTokens: TokenTotals | null = null;
  let backgroundUsd: number | null = null;
  if (q.includeBackground) {
    const sum: TokenSums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let usd = 0;
    for (const b of backgroundRows(ctx, q)) {
      sum.input += b.input;
      sum.output += b.output;
      sum.cacheRead += b.cacheRead;
      sum.cacheWrite += b.cacheWrite;
      usd += b.costUsd;
    }
    backgroundUsd = usd;
    backgroundTokens = totalsOf(sum);
    tokens = totalsOf({ input: t.input + sum.input, output: t.output + sum.output, cacheRead: t.cache_read + sum.cacheRead, cacheWrite: t.cache_write + sum.cacheWrite });
  }

  return {
    range: rangeInfo(ctx, q, start),
    sessions: stats.length,
    prompts: t.prompts,
    responses: t.responses,
    messages: t.prompts + t.responses,
    tokens,
    backgroundTokens,
    cost: { usd: nanosToUsd(t.cost) + (backgroundUsd ?? 0), backgroundUsd, unpricedResponses: t.unpriced, priceTableDate: PRICE_TABLE_DATE },
    activeDays: active.size,
    peakHour,
    peakDay,
    favoriteModel: favorite === undefined ? null : { model: favorite.model, tokens: favorite.total },
    longestSession,
    currentStreak: currentStreak(active, q.to, todayOfCtx(ctx)),
    longestStreak: streaks(active).longest,
    generatedAt: ctx.now(),
  };
}

// ---------------------------------------------------------------- heatmap, daily, hours

const TOKENS_R = 'SUM(input + output + cache_read + cache_write)';
const COST_R = 'SUM(cost_nanos)';
// The rollup expression of one metric. Cost is summed as whole nano dollars and turned into dollars only at the end.
const metricExpr = (metric: ActivityMetric): string => (metric === 'tokens' ? TOKENS_R : metric === 'cost' ? COST_R : 'SUM(prompts + responses)');
const metricValue = (metric: ActivityMetric, n: number): number => (metric === 'cost' ? n / NANOS_PER_USD : n);

// Per day value of one metric for days from..to, honouring the filters. Days without activity are absent.
function dailyValues(ctx: Ctx, q: Query, metric: ActivityMetric, from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  if (metric === 'sessions') {
    const [s, e] = rangeBounds(from, to, ctx.tz);
    for (const [k, v] of sessionBuckets(ctx, q, s, e, 'day')) out.set(k as string, v);
    return out;
  }
  const w = rollupWhere(q, from, to);
  const expr = metricExpr(metric);
  for (const r of rows<{ day: string; n: number }>(ctx.db, frag(`SELECT day, ${expr} AS n FROM activity_rollup WHERE ${w.sql} GROUP BY day`, w.params))) {
    if (r.n > 0) out.set(r.day, metricValue(metric, r.n));
  }
  return out;
}

// Upper bounds (inclusive) of the four non zero colour steps: the 25th, 50th and 75th percentile and the maximum of the
// non zero values, by nearest rank. A value v is step 0 when zero, else the first step i with v <= thresholds[i] plus 1.
function thresholdsOf(values: number[]): number[] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length === 0) return [1, 2, 3, 4];
  const at = (p: number): number => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))] as number;
  return [at(0.25), at(0.5), at(0.75), at(1)];
}

// A day is possibly incomplete when it lies in [archiveStart, completeFrom).
export function isPartial(day: string, start: string | null, from: string | null): boolean {
  return start !== null && from !== null && day >= start && day < from;
}

export function heatmap(ctx: Ctx, q: Query, metric: ActivityMetric): Heatmap {
  const start = archiveStart(ctx);
  const today = todayOfCtx(ctx);
  const mondayOfTo = addDays(q.to, -weekdayMonday0(q.to));
  const gridTo = addDays(mondayOfTo, 6);
  const fiftyThreeWeeks = addDays(mondayOfTo, -52 * 7);
  const mondayOfFrom = addDays(q.from, -weekdayMonday0(q.from));
  const gridFrom = mondayOfFrom < fiftyThreeWeeks ? mondayOfFrom : fiftyThreeWeeks;
  // The grid is a fixed context window: cells before `from` keep their values, cells after `to` are empty.
  const values = dailyValues(ctx, q, metric, gridFrom, q.to);
  const range = rangeInfo(ctx, q, start);
  const cells = daysInRange(gridFrom, gridTo).map((day) => ({
    day,
    value: values.get(day) ?? 0,
    beforeArchive: start === null || day < start,
    partial: isPartial(day, start, range.completeFrom),
    afterToday: day > today,
  }));
  return { range, metric, gridFrom, gridTo, cells, thresholds: thresholdsOf(cells.map((c) => c.value)) };
}

export function daily(ctx: Ctx, q: Query, metric: ActivityMetric, hideCacheRead: boolean): Daily {
  const days = daysInRange(q.from, q.to);
  const range = rangeInfo(ctx, q);
  const partial = (day: string): boolean => isPartial(day, range.archiveStart, range.completeFrom);
  if (metric === 'sessions') {
    const v = dailyValues(ctx, q, 'sessions', q.from, q.to);
    // Sessions cannot be added up across models, so there is one total per day and no model series.
    return { range, metric, models: [], days: days.map((day) => ({ day, total: v.get(day) ?? 0, byModel: {}, partial: partial(day) })) };
  }
  const w = rollupWhere(q);
  const expr = metric === 'tokens' ? `SUM(input + output + cache_write${hideCacheRead ? '' : ' + cache_read'})` : metricExpr(metric);
  const found = rows<{ day: string; model: string; n: number }>(
    ctx.db,
    frag(`SELECT day, model, ${expr} AS n FROM activity_rollup WHERE ${w.sql} GROUP BY day, model`, w.params),
  ).filter((r) => r.n > 0);
  const label = (m: string): string => (m === '' ? NO_MODEL_LABEL : m);
  const perModel = new Map<string, number>();
  const perDay = new Map<string, Map<string, number>>();
  for (const r of found) {
    const m = label(r.model);
    perModel.set(m, (perModel.get(m) ?? 0) + r.n);
    let d = perDay.get(r.day);
    if (d === undefined) perDay.set(r.day, (d = new Map()));
    d.set(m, (d.get(m) ?? 0) + r.n);
  }
  const models = [...perModel.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([m]) => m);
  return {
    range,
    metric,
    models,
    days: days.map((day) => {
      const d = perDay.get(day);
      const byModel: Record<string, number> = {};
      let total = 0;
      for (const m of models) {
        const n = d?.get(m) ?? 0;
        byModel[m] = metricValue(metric, n);
        total += n;
      }
      return { day, total: metricValue(metric, total), byModel, partial: partial(day) };
    }),
  };
}

export function hours(ctx: Ctx, q: Query, metric: ActivityMetric): Hours {
  const values = new Array<number>(24).fill(0);
  if (metric === 'sessions') {
    for (const [h, n] of sessionBuckets(ctx, q, q.startMs, q.endMs, 'hour')) values[h as number] = n;
  } else {
    const w = rollupWhere(q);
    const expr = metricExpr(metric);
    for (const r of rows<{ hour: number; n: number }>(ctx.db, frag(`SELECT hour, ${expr} AS n FROM activity_rollup WHERE ${w.sql} GROUP BY hour`, w.params))) {
      values[r.hour] = metricValue(metric, r.n);
    }
  }
  return { range: rangeInfo(ctx, q), metric, hours: values.map((value, hour) => ({ hour, value })) };
}

// ---------------------------------------------------------------- models, projects

export function models(ctx: Ctx, q: Query): Models {
  const found = modelRows(ctx.db, q);
  const sum = found.reduce((a, r) => a + r.total, 0);
  const costSum = found.reduce((a, r) => a + (r.priced ? r.costNanos : 0), 0);
  return {
    range: rangeInfo(ctx, q),
    rows: found.map((r, i) => {
      const { costNanos, priced, ...row } = r;
      return {
        ...row,
        share: sum === 0 ? 0 : r.total / sum,
        favorite: i === 0 && r.total > 0,
        costUsd: priced ? nanosToUsd(costNanos) : null,
        costShare: priced && costSum > 0 ? costNanos / costSum : 0,
      };
    }),
    background: q.includeBackground ? backgroundRows(ctx, q) : [],
  };
}

function aliasMap(db: Db): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of stmt(db, 'SELECT alias_dir, target_dir FROM project_aliases ORDER BY alias_dir').all() as unknown as Array<{ alias_dir: string; target_dir: string }>) {
    // A link target is kept as written: a folder name, or a path that ends in the project folder's name.
    const target = basename(r.target_dir);
    const l = out.get(target);
    if (l === undefined) out.set(target, [r.alias_dir]);
    else l.push(r.alias_dir);
  }
  return out;
}

interface ProjectMeta {
  displayName: string;
  projectDir: string;
}

function projectMeta(db: Db): Map<string, ProjectMeta> {
  const out = new Map<string, ProjectMeta>();
  for (const r of stmt(db, 'SELECT project_key, display_name, project_dir FROM projects').all() as unknown as Array<{ project_key: string; display_name: string; project_dir: string }>) {
    out.set(r.project_key, { displayName: r.display_name, projectDir: r.project_dir });
  }
  return out;
}

export function projects(ctx: Ctx, q: Query): Projects {
  const w = rollupWhere(q);
  const sums = new Map<string, { messages: number; tokens: number; cost: number }>();
  for (const r of rows<{ project_key: string; messages: number; tokens: number; cost: number }>(
    ctx.db,
    frag(`SELECT project_key, SUM(prompts + responses) AS messages, ${TOKENS_R} AS tokens, ${COST_R} AS cost FROM activity_rollup WHERE ${w.sql} GROUP BY project_key`, w.params),
  )) {
    sums.set(r.project_key, { messages: r.messages, tokens: r.tokens, cost: r.cost });
  }
  const info = sessionInfo(ctx.db);
  const per = new Map<string, { sessions: number; last: number }>();
  for (const s of sessionStats(ctx, q, q.startMs, q.endMs)) {
    const key = infoOf(info, s.sessionId).projectKey;
    const p = per.get(key);
    if (p === undefined) per.set(key, { sessions: 1, last: s.lastTs });
    else {
      p.sessions += 1;
      p.last = Math.max(p.last, s.lastTs);
    }
  }
  const meta = projectMeta(ctx.db);
  const aliases = aliasMap(ctx.db);
  const keys = new Set([...sums.keys(), ...per.keys()]);
  const out: Projects['rows'] = [];
  for (const key of keys) {
    const s = sums.get(key) ?? { messages: 0, tokens: 0, cost: 0 };
    const p = per.get(key) ?? { sessions: 0, last: 0 };
    if (s.messages === 0 && s.tokens === 0 && p.sessions === 0) continue;
    const m = meta.get(key);
    const dir = m?.projectDir ?? '';
    out.push({
      projectKey: key,
      displayName: m?.displayName ?? (key === '' ? UNKNOWN_PROJECT : key),
      projectDir: dir,
      aliases: aliases.get(dir) ?? [],
      sessions: p.sessions,
      messages: s.messages,
      tokens: s.tokens,
      lastActiveTs: p.sessions > 0 ? p.last : null,
      costUsd: nanosToUsd(s.cost),
    });
  }
  out.sort((a, b) => b.tokens - a.tokens || (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0) || (a.projectKey < b.projectKey ? -1 : 1));
  return { range: rangeInfo(ctx, q), rows: out };
}

// ---------------------------------------------------------------- sessions and the day strip

export function sessions(ctx: Ctx, q: Query, paging: Paging): Sessions {
  const stats = sessionStats(ctx, q, q.startMs, q.endMs);
  const key = (s: SessionStat): number => (paging.sort === 'tokens' ? s.tokens : paging.sort === 'active' ? s.activeMs : s.firstTs);
  stats.sort((a, b) => key(b) - key(a) || b.firstTs - a.firstTs || (a.sessionId < b.sessionId ? -1 : 1));
  const page = stats.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize);
  const ids = page.map((s) => s.sessionId);
  const info = sessionInfo(ctx.db, ids);

  const modelsOf = new Map<string, Array<{ model: string; tokens: number }>>();
  const deleted = new Map<string, boolean>();
  if (ids.length > 0) {
    const u = usageWhere(q, q.startMs, q.endMs, false);
    for (const r of rows<{ id: string; model: string; tokens: number }>(
      ctx.db,
      frag(
        `SELECT u.session_id AS id, u.model AS model, SUM(${TOKENS_U}) AS tokens FROM usage_events u
          WHERE ${u.sql} AND u.session_id IN (${marks(ids.length)}) GROUP BY u.session_id, u.model`,
        [...u.params, ...ids],
      ),
    )) {
      const l = modelsOf.get(r.id);
      if (l === undefined) modelsOf.set(r.id, [{ model: r.model, tokens: r.tokens }]);
      else l.push({ model: r.model, tokens: r.tokens });
    }
    for (const r of stmt(
      ctx.db,
      `SELECT session_id AS id, COUNT(*) AS n, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS live
         FROM source_files WHERE session_id IN (${marks(ids.length)}) GROUP BY session_id`,
    ).all(...ids) as unknown as Array<{ id: string; n: number; live: number }>) {
      deleted.set(r.id, r.n > 0 && r.live === 0);
    }
  }

  return {
    range: rangeInfo(ctx, q),
    total: stats.length,
    page: paging.page,
    pageSize: paging.pageSize,
    rows: page.map((s) => {
      const i = infoOf(info, s.sessionId);
      const used = (modelsOf.get(s.sessionId) ?? []).sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)).map((m) => m.model);
      return {
        sessionId: s.sessionId,
        projectKey: i.projectKey,
        displayName: i.displayName,
        title: i.title,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        activeMs: s.activeMs,
        wallMs: s.lastTs - s.firstTs,
        prompts: s.prompts,
        responses: s.responses,
        tokens: s.tokens,
        models: used,
        hasSubagents: i.hasSubagents,
        sourceDeleted: deleted.get(s.sessionId) ?? false,
        costUsd: nanosToUsd(s.costNanos),
      };
    }),
  };
}

export function dayDetail(ctx: Ctx, q: Query, day: string): DayDetail {
  const [s, e] = dayBounds(day, ctx.tz);
  const stats = sessionStats(ctx, q, s, e);
  const info = sessionInfo(ctx.db, stats.map((x) => x.sessionId));
  stats.sort((a, b) => a.firstTs - b.firstTs || (a.sessionId < b.sessionId ? -1 : 1));
  return {
    day,
    sessions: stats.map((x) => {
      const i = infoOf(info, x.sessionId);
      return {
        sessionId: x.sessionId,
        projectKey: i.projectKey,
        displayName: i.displayName,
        title: i.title,
        firstTs: x.firstTs,
        lastTs: x.lastTs,
        messages: x.prompts + x.responses,
        tokens: x.tokens,
        costUsd: nanosToUsd(x.costNanos),
      };
    }),
  };
}

// ---------------------------------------------------------------- filters, health, definitions

export function filters(ctx: Ctx): Filters {
  const modelList = (
    stmt(ctx.db, "SELECT model, SUM(input + output + cache_read + cache_write) AS t FROM activity_rollup WHERE model <> '' GROUP BY model ORDER BY t DESC, model").all() as unknown as Array<{
      model: string;
    }>
  ).map((r) => r.model);
  const aliases = aliasMap(ctx.db);
  const list = (stmt(ctx.db, 'SELECT project_key, display_name, project_dir FROM projects ORDER BY display_name COLLATE NOCASE, project_key').all() as unknown as Array<{
    project_key: string;
    display_name: string;
    project_dir: string;
  }>).map((p) => ({ projectKey: p.project_key, displayName: p.display_name, aliases: aliases.get(p.project_dir) ?? [] }));
  const start = archiveStart(ctx);
  return { models: modelList, projects: list, tz: ctx.tz, archiveStart: start, completeFrom: completeFrom(ctx, start), today: todayOfCtx(ctx) };
}

function dbBytes(db: Db): number {
  const loc = db.location();
  if (loc === null || loc === undefined || loc === '') return 0;
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += statSync(loc + suffix).size;
    } catch {
      // no such side file
    }
  }
  return total;
}

export function health(ctx: Ctx, sync: SyncStatus): Health {
  const root = ctx.sourceRoot ?? defaultSourceRoot();
  const one = (sql: string): number => (stmt(ctx.db, sql).get() as { n: number }).n;
  const sessionRows = new Set(
    (stmt(ctx.db, 'SELECT session_id AS id FROM sessions').all() as unknown as Array<{ id: string }>).map((r) => r.id),
  );
  let sourceDeleted = 0;
  for (const r of stmt(ctx.db, "SELECT session_id AS id, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS live FROM source_files GROUP BY session_id").all() as unknown as Array<{ id: string; live: number }>) {
    if (r.live === 0 && sessionRows.has(r.id)) sourceDeleted += 1;
  }
  return {
    status: sync.lastError === null ? 'ok' : 'degraded',
    appVersion: appVersion(),
    tz: ctx.tz,
    archiveStart: archiveStart(ctx),
    sync: {
      running: sync.running,
      lastPassAt: sync.lastPassAt,
      lastSuccessAt: sync.lastSuccessAt,
      lastError: sync.lastError,
      watcherAlive: sync.watcherAlive,
    },
    files: {
      active: one("SELECT COUNT(*) AS n FROM source_files WHERE status = 'active'"),
      deleted: one("SELECT COUNT(*) AS n FROM source_files WHERE status = 'deleted'"),
    },
    sessions: { total: one('SELECT COUNT(*) AS n FROM sessions'), sourceDeleted },
    errors: { total: one('SELECT COUNT(*) AS n FROM ingest_errors') },
    dbBytes: dbBytes(ctx.db),
    completeFrom: completeFrom(ctx),
    retentionDays: ctx.retentionDays ?? retentionDays(),
    sourceRoot: root,
    lastPass: lastPass(ctx.db),
    recentErrors: recentErrors(ctx.db, root),
    unknownTypes: unknownTypes(ctx.db),
    missingFields: missingFields(ctx.db),
    versions: memo(ctx, 'health|versions', () => versions(ctx.db)),
    entrypoints: memo(ctx, 'health|entrypoints', () => entrypoints(ctx.db)),
    aliases: aliases(ctx.db),
    costCheck: memo(ctx, 'health|costCheck', () => costCheck(ctx.db)),
    canary: checkCanary(ctx.db, { sessionsDir: ctx.sessionsDir ?? join(dirname(root), 'sessions'), sourceRoot: root, now: ctx.now() }),
    prices: memo(ctx, 'health|prices', () => prices(ctx.db)),
  };
}

export function definitions(): Definitions {
  return { definitions: DEFINITIONS.map((d) => ({ ...d })) };
}
