// Totals and the cost-state cross check. Read only queries; counts only.
import type { Db } from '../store/db.ts';

export interface ModelTotals {
  model: string;
  rows: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  sum: number;
}

export function totalsPerModel(db: Db): ModelTotals[] {
  const rows = db
    .prepare(
      `SELECT model, COUNT(*) AS rows, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write
       FROM usage_events GROUP BY model`,
    )
    .all() as Array<{ model: string; rows: number; input: number; output: number; cache_read: number; cache_write: number }>;
  return rows
    .map((r) => ({
      model: r.model,
      rows: r.rows,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      sum: r.input + r.output + r.cache_read + r.cache_write,
    }))
    .sort((a, b) => b.sum - a.sum || (a.model < b.model ? -1 : 1));
}

export function grandTotals(db: Db): ModelTotals {
  const t: ModelTotals = { model: 'all', rows: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sum: 0 };
  for (const m of totalsPerModel(db)) {
    t.rows += m.rows;
    t.input += m.input;
    t.output += m.output;
    t.cacheRead += m.cacheRead;
    t.cacheWrite += m.cacheWrite;
    t.sum += m.sum;
  }
  return t;
}

export interface Exception {
  sessionId: string;
  ours: number;
  theirs: number;
  percent: number; // signed, (ours - theirs) / theirs * 100
}

export interface VariantResult {
  compared: number;
  agree: number;
  rate: number; // agree / compared, 0 when nothing was compared
  worst: Exception[]; // at most 10, largest absolute percent first
}

export interface CrossCheck {
  snapshots: number;
  excludedZero: number; // snapshot total is 0
  excludedNoCommon: number; // no snapshot model appears in our events for that session
  a: VariantResult; // all our events of the session, subagent files included
  b: VariantResult; // main file events only
  better: 'A' | 'B';
}

interface Snapshot {
  [model: string]: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

function snapshotTokens(u: Snapshot[string] | undefined): number {
  if (u === undefined || u === null || typeof u !== 'object') return 0;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return n(u.inputTokens) + n(u.outputTokens) + n(u.cacheReadInputTokens) + n(u.cacheCreationInputTokens);
}

const AGREE_WITHIN = 0.01;

export function costStateCrossCheck(db: Db): CrossCheck {
  // Our sums per (session, model, main or subagent file).
  const rows = db
    .prepare(
      `SELECT session_id AS s, model AS m, is_subagent_file AS sub,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total
       FROM usage_events GROUP BY session_id, model, is_subagent_file`,
    )
    .all() as Array<{ s: string; m: string; sub: number; total: number }>;
  const ours = new Map<string, Map<string, { main: number; sub: number }>>();
  for (const r of rows) {
    let models = ours.get(r.s);
    if (models === undefined) ours.set(r.s, (models = new Map()));
    let cell = models.get(r.m);
    if (cell === undefined) models.set(r.m, (cell = { main: 0, sub: 0 }));
    if (r.sub === 1) cell.sub += r.total;
    else cell.main += r.total;
  }

  const snaps = db.prepare('SELECT session_id AS s, model_usage_json AS j FROM cost_snapshots ORDER BY session_id').all() as Array<{
    s: string;
    j: string;
  }>;

  const result: CrossCheck = {
    snapshots: snaps.length,
    excludedZero: 0,
    excludedNoCommon: 0,
    a: { compared: 0, agree: 0, rate: 0, worst: [] },
    b: { compared: 0, agree: 0, rate: 0, worst: [] },
    better: 'A',
  };
  const exA: Exception[] = [];
  const exB: Exception[] = [];

  for (const snap of snaps) {
    let parsed: Snapshot;
    try {
      parsed = JSON.parse(snap.j) as Snapshot;
    } catch {
      parsed = {};
    }
    const models = Object.keys(parsed);
    const total = models.reduce((acc, m) => acc + snapshotTokens(parsed[m]), 0);
    if (total === 0) {
      result.excludedZero += 1;
      continue;
    }
    const mine = ours.get(snap.s);
    const common = models.filter((m) => mine?.has(m) === true);
    if (mine === undefined || common.length === 0) {
      result.excludedNoCommon += 1;
      continue;
    }
    const theirs = common.reduce((acc, m) => acc + snapshotTokens(parsed[m]), 0);
    if (theirs === 0) {
      result.excludedZero += 1;
      continue;
    }
    let a = 0;
    let b = 0;
    for (const m of common) {
      const cell = mine.get(m);
      if (cell === undefined) continue;
      a += cell.main + cell.sub;
      b += cell.main;
    }
    for (const [v, value, list] of [
      [result.a, a, exA],
      [result.b, b, exB],
    ] as const) {
      v.compared += 1;
      const pct = ((value - theirs) / theirs) * 100;
      if (Math.abs(value - theirs) <= AGREE_WITHIN * theirs) v.agree += 1;
      else list.push({ sessionId: snap.s, ours: value, theirs, percent: pct });
    }
  }

  const byWorst = (x: Exception, y: Exception): number =>
    Math.abs(y.percent) - Math.abs(x.percent) || (x.sessionId < y.sessionId ? -1 : 1);
  result.a.rate = result.a.compared === 0 ? 0 : result.a.agree / result.a.compared;
  result.b.rate = result.b.compared === 0 ? 0 : result.b.agree / result.b.compared;
  result.a.worst = exA.sort(byWorst).slice(0, 10);
  result.b.worst = exB.sort(byWorst).slice(0, 10);
  result.better = result.b.rate > result.a.rate ? 'B' : 'A';
  return result;
}

// ---------------------------------------------------------------- cost agreement

export interface CostPair {
  sessionId: string;
  model: string;
  ours: number; // USD, our stored cost of the session's events of this model
  theirs: number; // USD, Claude Code's own costUSD for this model in the session's last snapshot
  diff: number; // ours minus theirs, USD
  cacheRead: number; // cache read tokens of the pair
}

export interface CostAgreement {
  snapshots: number;
  sessions: number; // sessions whose deduped tokens equal the last snapshot exactly for every model of the transcript
  pairs: number; // (session, model) pairs compared in those sessions
  within: number; // pairs within $0.01
  explained: number; // not within, but the difference is the corrected cache read rate (older Claude Code versions)
  other: number; // not within and not explained
  worst: CostPair[]; // at most 5 of the "other" pairs, largest absolute difference first
}

export const COST_AGREE_WITHIN_USD = 0.01;

// Models whose cache read rate was corrected on 2026-10-27, as the old rate minus the new rate in milli USD per million tokens.
// Claude Code up to 2.1.292 priced Sonnet 5.5 cache reads at $0.20, so its costUSD is higher than ours by cache reads times $0.10.
export const CORRECTED_READ_RATE_MILLI: Readonly<Record<string, number>> = { 'claude-sonnet-5-5': 100 };

// True when our cost is below theirs by exactly the cache read tokens times the corrected rate difference, within $0.01.
export function explainedByReadRate(model: string, cacheRead: number, diffUsd: number): boolean {
  const milli = Object.hasOwn(CORRECTED_READ_RATE_MILLI, model) ? (CORRECTED_READ_RATE_MILLI[model] as number) : 0;
  if (milli === 0) return false;
  const expected = -(cacheRead * milli) / 1_000_000_000;
  return Math.abs(diffUsd - expected) <= COST_AGREE_WITHIN_USD + 1e-9;
}

// For every session whose deduped token counts (all four counters, subagent events included) equal the last cost-state snapshot
// exactly for each model of the session's transcript, compares our cost per model with the snapshot's costUSD. Models that only
// appear in the snapshot are background calls and are left out. A model without a price is not compared. Read only.
export function costAgreement(db: Db): CostAgreement {
  const rows = db
    .prepare(
      `SELECT session_id AS s, model AS m, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr,
              SUM(cache_write_tokens) AS cw, SUM(cost_nanos) AS cost, COUNT(*) - COUNT(cost_nanos) AS unpriced
         FROM usage_events GROUP BY session_id, model`,
    )
    .all() as Array<{ s: string; m: string; i: number; o: number; cr: number; cw: number; cost: number | null; unpriced: number }>;
  const ours = new Map<string, typeof rows>();
  for (const r of rows) {
    const l = ours.get(r.s);
    if (l === undefined) ours.set(r.s, [r]);
    else l.push(r);
  }
  const snaps = db.prepare('SELECT session_id AS s, model_usage_json AS j FROM cost_snapshots ORDER BY session_id').all() as Array<{ s: string; j: string }>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out: CostAgreement = { snapshots: snaps.length, sessions: 0, pairs: 0, within: 0, explained: 0, other: 0, worst: [] };
  const all: CostPair[] = [];
  for (const snap of snaps) {
    const mine = ours.get(snap.s);
    if (mine === undefined) continue;
    let parsed: Record<string, Record<string, unknown>>;
    try {
      parsed = JSON.parse(snap.j) as Record<string, Record<string, unknown>>;
    } catch {
      continue;
    }
    const equal = mine.every((r) => {
      const t = parsed[r.m];
      return (
        t !== undefined &&
        t !== null &&
        typeof t === 'object' &&
        n(t['inputTokens']) === r.i &&
        n(t['outputTokens']) === r.o &&
        n(t['cacheReadInputTokens']) === r.cr &&
        n(t['cacheCreationInputTokens']) === r.cw
      );
    });
    if (!equal) continue;
    const priced = mine.filter((r) => r.unpriced === 0 && r.cost !== null);
    if (priced.length === 0) continue;
    out.sessions += 1;
    for (const r of priced) {
      const theirs = n((parsed[r.m] as Record<string, unknown>)['costUSD']);
      const usd = (r.cost as number) / 1_000_000_000;
      const diff = usd - theirs;
      out.pairs += 1;
      if (Math.abs(diff) <= COST_AGREE_WITHIN_USD + 1e-9) out.within += 1;
      else if (explainedByReadRate(r.m, r.cr, diff)) out.explained += 1;
      else {
        out.other += 1;
        all.push({ sessionId: snap.s, model: r.m, ours: usd, theirs, diff, cacheRead: r.cr });
      }
    }
  }
  out.worst = all.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || (a.sessionId < b.sessionId ? -1 : 1)).slice(0, 5);
  return out;
}
