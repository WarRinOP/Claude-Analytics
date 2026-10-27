// Contract: HTTP API response shapes. All timestamps are UTC epoch ms.
// Local dates are 'YYYY-MM-DD' in the configured time zone. All counts are integers.

// Query parameters accepted by every data endpoint:
//   from, to            local dates, inclusive. Defaults: from = archive start day, to = today.
//   models              comma separated model names. Empty = all.
//   projects            comma separated project keys. Empty = all.
//   includeSubagents    '1' (default) or '0'. '0' drops events from subagent files from token and tool metrics.
//   includeBackground   '0' (default) or '1'. '1' adds cost-state background models to Models and to the token KPI.
// Invalid parameters give HTTP 400 with ApiError.

export interface ApiError {
  error: string; // plain sentence, no dashes as punctuation
}

export interface RangeInfo {
  from: string;
  to: string;
  days: number; // calendar days in the range, inclusive
  tz: string;
  archiveStart: string | null; // local day of the earliest archived event
  coverageGap: boolean; // true when from < archiveStart (earlier days are unknown, not zero)
  // First local day from which the archive is complete: the local day of the first ingest minus the retention window
  // (30 days), never earlier than archiveStart. Days from archiveStart up to the day before completeFrom only hold
  // sessions that Claude Code kept because they were continued later, so they are possibly incomplete.
  completeFrom: string | null;
  partialGap: boolean; // true when the range includes any day in [archiveStart, completeFrom)
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number; // input + output + cacheRead + cacheWrite
}

// GET /api/summary
export interface Summary {
  range: RangeInfo;
  sessions: number; // distinct sessions with at least one main thread prompt or response in range
  prompts: number; // messages kind 'prompt', not sidechain
  responses: number; // usage events with is_sidechain 0 and is_subagent_file 0
  messages: number; // prompts + responses
  tokens: TokenTotals; // background calls included only when includeBackground = '1'
  backgroundTokens: TokenTotals | null; // the background part, when included, else null
  activeDays: number; // local days in range with at least one prompt or response
  peakHour: { hour: number; messages: number } | null; // local hour 0 to 23 with most messages
  peakDay: { day: string; messages: number } | null;
  favoriteModel: { model: string; tokens: number } | null; // most tokens; ties by responses, then name
  // API price equivalent: what the usage would cost at the dated list prices. Not what was paid.
  cost: {
    usd: number; // priced usage events in range and filters (background included only when includeBackground = '1')
    backgroundUsd: number | null; // cost-state costUSD of background models, when included, else null
    unpricedResponses: number; // usage events whose model has no price in the table
    priceTableDate: string; // 'YYYY-MM-DD' of the price table
  };
  longestSession: {
    sessionId: string;
    projectKey: string;
    displayName: string;
    title: string | null;
    activeMs: number; // sum of gaps of at most 30 minutes between consecutive events in range
    wallMs: number; // first to last event in range
  } | null;
  currentStreak: number; // consecutive active days ending today, or ending yesterday if today has no activity yet
  longestStreak: { days: number; from: string; to: string } | null;
  generatedAt: number;
}

// 'cost' values are USD (API price equivalent, plan section 15), not integers.
export type ActivityMetric = 'messages' | 'tokens' | 'sessions' | 'cost';

// GET /api/heatmap?metric=
// Grid: the 53 weeks (Monday first) ending in the week of `to`, or the whole range when longer.
export interface Heatmap {
  range: RangeInfo;
  metric: ActivityMetric;
  gridFrom: string; // first cell (a Monday)
  gridTo: string; // last cell (a Sunday)
  cells: { day: string; value: number; beforeArchive: boolean; partial: boolean; afterToday: boolean }[]; // partial: archiveStart <= day < completeFrom
  thresholds: number[]; // 4 ascending cut points from quantiles of non zero values: 5 steps including zero
}

// GET /api/day?date=  (tooltip strip: sessions of one day, honours filters)
export interface DayDetail {
  day: string;
  sessions: {
    sessionId: string;
    projectKey: string;
    displayName: string;
    title: string | null;
    firstTs: number; // first event of that day
    lastTs: number;
    messages: number;
    tokens: number;
    costUsd: number;
  }[];
}

// GET /api/daily?metric=&hideCacheRead=0|1
export interface Daily {
  range: RangeInfo;
  metric: ActivityMetric;
  models: string[]; // series order: by total descending
  days: { day: string; total: number; byModel: Record<string, number>; partial: boolean }[]; // every day in range, zeros included
}

// GET /api/hours?metric=
export interface Hours {
  range: RangeInfo;
  metric: ActivityMetric;
  hours: { hour: number; value: number }[]; // always 24 entries
}

// GET /api/models
export interface Models {
  range: RangeInfo;
  rows: {
    model: string;
    responses: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    share: number; // total / sum of totals of rows, 0 to 1
    favorite: boolean;
    costUsd: number | null; // null when the model has no price
    costShare: number; // costUsd / sum of priced rows, 0 to 1
  }[];
  // From each session's last cost-state snapshot: models that never appear in that session's transcript.
  // A session's background usage is placed on the local day of the session's first event.
  background: { model: string; sessions: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; costUsd: number }[]; // costUsd from cost-state costUSD
}

// GET /api/projects
export interface Projects {
  range: RangeInfo;
  rows: {
    projectKey: string;
    displayName: string;
    projectDir: string;
    aliases: string[]; // symlink alias folder names pointing at projectDir
    sessions: number;
    messages: number;
    tokens: number;
    lastActiveTs: number | null;
    costUsd: number;
  }[];
}

// GET /api/sessions?page=1&pageSize=50&sort=start|tokens|active  (descending)
export interface Sessions {
  range: RangeInfo;
  total: number;
  page: number;
  pageSize: number;
  rows: {
    sessionId: string;
    projectKey: string;
    displayName: string;
    title: string | null;
    firstTs: number; // in range
    lastTs: number;
    activeMs: number;
    wallMs: number;
    prompts: number;
    responses: number;
    tokens: number;
    models: string[];
    hasSubagents: boolean;
    sourceDeleted: boolean; // every source file of the session is gone; the archive still holds it
    costUsd: number;
  }[];
}

// GET /api/filters
export interface Filters {
  models: string[];
  projects: { projectKey: string; displayName: string; aliases: string[] }[];
  tz: string;
  archiveStart: string | null;
  completeFrom: string | null;
  today: string;
}

// GET /api/health
export interface Health {
  status: 'ok' | 'degraded';
  appVersion: string;
  tz: string;
  archiveStart: string | null;
  sync: {
    running: boolean;
    lastPassAt: number | null;
    lastSuccessAt: number | null;
    lastError: string | null;
    watcherAlive: boolean;
  };
  files: { active: number; deleted: number };
  sessions: { total: number; sourceDeleted: number };
  errors: { total: number };
  dbBytes: number;
  // Added for the Data health panel and `cli.ts doctor`.
  completeFrom: string | null;
  retentionDays: number;
  sourceRoot: string; // the transcript folder being read
  lastPass: {
    at: number;
    durationMs: number;
    trigger: string;
    filesScanned: number;
    filesChanged: number;
    linesRead: number;
    errors: number;
  } | null;
  recentErrors: { file: string; lineNo: number | null; byteOffset: number | null; error: string; at: number }[]; // newest first, at most 50
  unknownTypes: { type: string; version: string; count: number; lastSeenAt: number }[];
  missingFields: { field: string; version: string; count: number }[];
  versions: { version: string; responses: number; firstTs: number; lastTs: number }[]; // Claude Code versions seen in usage events
  entrypoints: { entrypoint: string; responses: number }[];
  aliases: { aliasDir: string; targetDir: string }[];
  costCheck: {
    sessionsWithSnapshot: number;
    compared: number; // snapshots with a non zero total for models we also saw
    withinOnePercent: number;
    exceptions: { sessionId: string; ours: number; theirs: number; percent: number }[]; // worst 10 by absolute percent
  };
  // A live session in ~/.claude/sessions updated in the last 10 minutes whose transcript has not grown for 10
  // minutes means transcripts may have moved. 'unknown' when the sessions folder cannot be read.
  canary: { status: 'ok' | 'warning' | 'unknown'; message: string };
  prices: {
    tableDate: string;
    unpricedModels: { model: string; responses: number }[];
    cacheWriteRemainderEvents: number; // events whose 5m and 1h parts did not add up; remainder priced at the 5m rate
  };
}

// GET /api/definitions  (same wording as docs/METRICS.md)
export interface Definitions {
  definitions: { id: string; term: string; text: string }[];
}

// GET /api/events  (Server Sent Events)
//   event: synced   data: SyncedEvent
//   a comment line every 25 s as a heartbeat
export interface SyncedEvent {
  at: number;
  changedFrom: string | null; // local days touched by the pass, null when unknown (full rebuild)
  changedTo: string | null;
}

// GET /api/breakdown?period=month|week|day  plus the common filters.
// GET /api/breakdown.csv returns the same rows as CSV (period rows, then per model rows).
// Rows are newest first and only periods with activity are listed; weeks start on Monday; months are calendar months
// in the configured zone. For month and week periods `days` holds the active days inside the period (newest first);
// for the day period it is empty. Days before archiveStart are never listed.
export type BreakdownPeriod = 'month' | 'week' | 'day';

export interface BreakdownTotals {
  responses: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number; // input + output + cacheWrite + cacheRead
  costUsd: number; // API price equivalent of the priced events
  unpriced: number; // events without a price
}

export interface BreakdownModelRow extends BreakdownTotals {
  model: string;
}

export interface BreakdownRow {
  key: string; // 'YYYY-MM', the Monday 'YYYY-MM-DD' of the week, or the day 'YYYY-MM-DD'
  label: string; // 'October 2026', 'Week of 20 Oct 2026', 'Mon 27 Oct 2026'
  from: string; // first local day of the period clipped to the range
  to: string; // last local day of the period clipped to the range
  partial: boolean; // contains a possibly incomplete day
  models: BreakdownModelRow[]; // by total descending
  totals: BreakdownTotals;
  days: BreakdownRow[]; // see above; day rows have an empty days list
}

export interface Breakdown {
  range: RangeInfo;
  period: BreakdownPeriod;
  rows: BreakdownRow[];
  totals: BreakdownTotals; // equals the sum of rows
  priceTableDate: string;
}
