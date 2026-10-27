// Derived tables. activity_rollup holds one row per local day,
// local hour, project, model and file kind. It can always be rebuilt from usage_events, messages and sessions.
//
// Project of an event is its session's project_key; events whose session row is missing use the empty key.
// A prompt's model is the model of the first main thread response at or after it (attributed_model), empty while unknown.
import type { RunSummary } from '../ingest/ingest.ts';
import { stmt, transaction, type Db } from '../store/db.ts';
import { addDays, dayBounds, daysInRange, dayNumber, localDay, makeLocalizer } from './time.ts';

export interface ChangedDays {
  // Local days touched by the pass; null when unknown (full rebuild, or a change with no day such as a title).
  changedFrom: string | null;
  changedTo: string | null;
}

const META_TZ = 'rollup_tz';

export function getMeta(db: Db, key: string): string | null {
  const r = stmt(db, 'SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r === undefined ? null : r.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  stmt(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------------------------------------------------------------- prompt models

// Fills attributed_model for main thread prompts that have none yet. Returns the ts of every prompt it filled.
// A prompt with no later main thread response stays empty and is tried again on the next call.
export function resolvePromptModels(db: Db): number[] {
  const rows = stmt(
    db,
    `SELECT m.uuid AS uuid, m.ts AS ts,
            (SELECT u.model FROM usage_events u
              WHERE u.session_id = m.session_id AND u.is_sidechain = 0 AND u.is_subagent_file = 0 AND u.ts >= m.ts
              ORDER BY u.ts, u.event_key LIMIT 1) AS model
       FROM messages m
      WHERE m.kind = 'prompt' AND m.is_sidechain = 0 AND m.attributed_model IS NULL`,
  ).all() as Array<{ uuid: string; ts: number; model: string | null }>;
  const found = rows.filter((r): r is { uuid: string; ts: number; model: string } => r.model !== null);
  if (found.length === 0) return [];
  transaction(db, () => {
    const set = stmt(db, 'UPDATE messages SET attributed_model = ? WHERE uuid = ? AND attributed_model IS NULL');
    for (const r of found) set.run(r.model, r.uuid);
  });
  return found.map((r) => r.ts);
}

// ---------------------------------------------------------------- building rows

interface Cell {
  day: string;
  hour: number;
  projectKey: string;
  model: string;
  sub: number;
  prompts: number;
  responses: number;
  tools: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costNanos: number; // sum of the stored costs of the priced events
  unpriced: number; // usage events whose model has no price
}

const USAGE_ROWS = `
SELECT u.ts AS ts, COALESCE(s.project_key, '') AS project_key, u.model AS model, u.is_subagent_file AS sub, u.is_sidechain AS side,
       u.input_tokens AS input, u.output_tokens AS output, u.cache_read_tokens AS cache_read, u.cache_write_tokens AS cache_write,
       u.cost_nanos AS cost,
       (SELECT COUNT(*) FROM tool_calls t WHERE t.event_key = u.event_key) AS tools
  FROM usage_events u LEFT JOIN sessions s ON s.session_id = u.session_id
 WHERE u.ts >= ? AND u.ts < ?`;

const PROMPT_ROWS = `
SELECT m.ts AS ts, COALESCE(s.project_key, '') AS project_key, COALESCE(m.attributed_model, '') AS model
  FROM messages m LEFT JOIN sessions s ON s.session_id = m.session_id
 WHERE m.kind = 'prompt' AND m.is_sidechain = 0 AND m.ts >= ? AND m.ts < ?`;

interface UsageRow {
  ts: number;
  project_key: string;
  model: string;
  sub: number;
  side: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  tools: number;
}

// Cells for every event with startMs <= ts < endMs, keyed by the primary key of activity_rollup.
function buildCells(db: Db, tz: string, startMs: number, endMs: number): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  if (endMs <= startMs) return cells;
  const loc = makeLocalizer(tz, startMs, endMs - 1);
  const cell = (ts: number, projectKey: string, model: string, sub: number): Cell => {
    const day = loc.day(ts);
    const hour = loc.hour(ts);
    const key = `${day}|${hour}|${projectKey}|${model}|${sub}`;
    let c = cells.get(key);
    if (c === undefined) {
      c = { day, hour, projectKey, model, sub, prompts: 0, responses: 0, tools: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costNanos: 0, unpriced: 0 };
      cells.set(key, c);
    }
    return c;
  };
  for (const r of stmt(db, USAGE_ROWS).all(startMs, endMs) as unknown as UsageRow[]) {
    const c = cell(r.ts, r.project_key, r.model, r.sub);
    if (r.sub === 0 && r.side === 0) c.responses += 1;
    c.tools += r.tools;
    c.input += r.input;
    c.output += r.output;
    c.cacheRead += r.cache_read;
    c.cacheWrite += r.cache_write;
    if (r.cost === null) c.unpriced += 1;
    else c.costNanos += r.cost;
  }
  for (const r of stmt(db, PROMPT_ROWS).all(startMs, endMs) as Array<{ ts: number; project_key: string; model: string }>) {
    cell(r.ts, r.project_key, r.model, 0).prompts += 1;
  }
  return cells;
}

function insertCells(db: Db, cells: Iterable<Cell>, keepFrom: string, keepTo: string): void {
  const ins = stmt(
    db,
    `INSERT INTO activity_rollup (day, hour, project_key, model, is_subagent_file, prompts, responses, tool_calls, input, output, cache_read, cache_write, cost_nanos, unpriced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of cells) {
    if (c.day < keepFrom || c.day > keepTo) continue;
    ins.run(c.day, c.hour, c.projectKey, c.model, c.sub, c.prompts, c.responses, c.tools, c.input, c.output, c.cacheRead, c.cacheWrite, c.costNanos, c.unpriced);
  }
}

// ---------------------------------------------------------------- rebuild and refresh

// Drops and recomputes every rollup row in the given zone, and records the zone in meta.rollup_tz.
export function rebuildAll(db: Db, tz: string): void {
  const span = stmt(
    db,
    `SELECT MIN(a) AS lo, MAX(b) AS hi FROM (
       SELECT MIN(ts) AS a, MAX(ts) AS b FROM usage_events UNION ALL SELECT MIN(ts), MAX(ts) FROM messages)`,
  ).get() as { lo: number | null; hi: number | null };
  transaction(db, () => {
    stmt(db, 'DELETE FROM activity_rollup').run();
    if (span.lo !== null && span.hi !== null) {
      insertCells(db, buildCells(db, tz, span.lo, span.hi + 1).values(), '', '9999-99-99');
    }
    setMeta(db, META_TZ, tz);
  });
}

// Recomputes the given local days. Days with no events end up with no rows.
export function refreshDays(db: Db, tz: string, days: Iterable<string>): void {
  const sorted = [...new Set(days)].sort();
  if (sorted.length === 0) return;
  // Consecutive days form one run, so a long span is one query and a few scattered days are a few small ones.
  const runs: Array<[string, string]> = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && dayNumber(d) - dayNumber(last[1]) === 1) last[1] = d;
    else runs.push([d, d]);
  }
  transaction(db, () => {
    for (const [first, last] of runs) {
      const startMs = dayBounds(first, tz)[0];
      const endMs = dayBounds(last, tz)[1];
      stmt(db, 'DELETE FROM activity_rollup WHERE day >= ? AND day <= ?').run(first, last);
      insertCells(db, buildCells(db, tz, startMs, endMs).values(), first, last);
    }
  });
}

interface Sums {
  responses: number;
  prompts: number;
  tools: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costNanos: number;
  unpriced: number;
}

function factSums(db: Db): Sums {
  const u = stmt(
    db,
    `SELECT COALESCE(SUM(CASE WHEN is_sidechain = 0 AND is_subagent_file = 0 THEN 1 ELSE 0 END), 0) AS responses,
            COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
            COALESCE(SUM(cost_nanos), 0) AS cost, COALESCE(SUM(CASE WHEN cost_nanos IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
       FROM usage_events`,
  ).get() as { responses: number; input: number; output: number; cache_read: number; cache_write: number; cost: number; unpriced: number };
  const p = stmt(db, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'prompt' AND is_sidechain = 0").get() as { n: number };
  const t = stmt(db, 'SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number };
  return { responses: u.responses, prompts: p.n, tools: t.n, input: u.input, output: u.output, cacheRead: u.cache_read, cacheWrite: u.cache_write, costNanos: u.cost, unpriced: u.unpriced };
}

function rollupSums(db: Db): Sums {
  const r = stmt(
    db,
    `SELECT COALESCE(SUM(responses), 0) AS responses, COALESCE(SUM(prompts), 0) AS prompts, COALESCE(SUM(tool_calls), 0) AS tools,
            COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
            COALESCE(SUM(cache_read), 0) AS cache_read, COALESCE(SUM(cache_write), 0) AS cache_write,
            COALESCE(SUM(cost_nanos), 0) AS cost, COALESCE(SUM(unpriced), 0) AS unpriced
       FROM activity_rollup`,
  ).get() as { responses: number; prompts: number; tools: number; input: number; output: number; cache_read: number; cache_write: number; cost: number; unpriced: number };
  return { responses: r.responses, prompts: r.prompts, tools: r.tools, input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, costNanos: r.cost, unpriced: r.unpriced };
}

// True when the grand totals of the rollup equal those of the fact tables. Catches a stop between the end of a pass
// and the refresh that follows it.
export function rollupMatchesFacts(db: Db): boolean {
  const a = factSums(db);
  const b = rollupSums(db);
  return (Object.keys(a) as Array<keyof Sums>).every((k) => a[k] === b[k]);
}

// Run once at start, before the first pass. Rebuilds when the zone changed, when the rollup was never built, or when
// its totals no longer equal the facts. Returns true when a rebuild happened.
export function ensureRollups(db: Db, tz: string): boolean {
  const filled = resolvePromptModels(db);
  if (getMeta(db, META_TZ) !== tz || !rollupMatchesFacts(db)) {
    rebuildAll(db, tz);
    return true;
  }
  if (filled.length > 0) refreshDays(db, tz, filled.map((ts) => localDay(ts, tz)));
  return false;
}

function daySnapshot(db: Db, day: string): string {
  return JSON.stringify(
    stmt(db, 'SELECT * FROM activity_rollup WHERE day = ? ORDER BY hour, project_key, model, is_subagent_file').all(day),
  );
}

// Run after every pass that changed something. Resolves prompt models, then refreshes the local days the pass touched
// plus the days of prompts that just got a model. A moved project or a zone change rebuilds everything.
// A response written across a day boundary keeps the ts of its first line, so a later line can change the day before
// the first new line. That day is refreshed too, and reported only when its rows really changed.
export function afterPass(db: Db, tz: string, summary: RunSummary): ChangedDays {
  const filled = resolvePromptModels(db);
  if (getMeta(db, META_TZ) !== tz || summary.sessionsReprojected > 0) {
    rebuildAll(db, tz);
    return { changedFrom: null, changedTo: null };
  }
  const touched = new Set<string>();
  let margin: string | null = null;
  if (summary.changedRange !== null) {
    const first = localDay(summary.changedRange.minTs, tz);
    for (const d of daysInRange(first, localDay(summary.changedRange.maxTs, tz))) touched.add(d);
    margin = addDays(first, -1);
  }
  for (const ts of filled) touched.add(localDay(ts, tz));
  if (touched.size === 0) return { changedFrom: null, changedTo: null };

  const marginBefore = margin !== null && !touched.has(margin) ? daySnapshot(db, margin) : null;
  refreshDays(db, tz, margin === null ? touched : [...touched, margin]);
  if (margin !== null && marginBefore !== null && daySnapshot(db, margin) !== marginBefore) touched.add(margin);

  const sorted = [...touched].sort();
  return { changedFrom: sorted[0] as string, changedTo: sorted[sorted.length - 1] as string };
}
