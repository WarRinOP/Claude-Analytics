// Repository functions over the archive. Every function takes the database first.
// Writes are idempotent and order independent; callers wrap batches in transaction().
import { basename } from 'node:path';
import type {
  ApiErrorFact,
  CompactionFact,
  CostSnapshotFact,
  LineMeta,
  MessageFact,
  UsageFact,
} from '../ingest/facts.ts';
import { priceEventNanos } from '../metrics/prices.ts';
import { pricedFromRow, type CostColumns } from './costs.ts';
import { stmt, type Db } from './db.ts';

type Row = Record<string, unknown>;

function bool(b: boolean): number {
  return b ? 1 : 0;
}

// ---------------------------------------------------------------- source files

export interface SourceFileInput {
  dev: number;
  ino: number;
  path: string;
  projectDir: string;
  sessionId: string;
  agentId: string | null;
  isSubagent: boolean;
  size: number;
  mtimeMs: number;
  now: number;
}

export interface SourceFileRow {
  id: number;
  dev: number;
  ino: number;
  path: string;
  projectDir: string;
  sessionId: string;
  agentId: string | null;
  isSubagent: boolean;
  size: number;
  mtimeMs: number;
  byteOffset: number;
  linesRead: number;
  headHash: string | null;
  status: 'active' | 'deleted';
  firstSeenAt: number;
  lastIngestedAt: number | null;
  deletedDetectedAt: number | null;
}

// Identity is (dev, ino). A known file gets its path, size and mtime refreshed and goes back to active.
export function upsertSourceFile(db: Db, f: SourceFileInput): number {
  const row = stmt(
    db,
    `INSERT INTO source_files (dev, ino, path, project_dir, session_id, agent_id, is_subagent, size, mtime_ms, first_seen_at)
     VALUES (@dev, @ino, @path, @projectDir, @sessionId, @agentId, @isSubagent, @size, @mtimeMs, @now)
     ON CONFLICT(dev, ino) DO UPDATE SET
       path = excluded.path,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       status = 'active',
       deleted_detected_at = NULL
     RETURNING id`,
  ).get({
    dev: f.dev,
    ino: f.ino,
    path: f.path,
    projectDir: f.projectDir,
    sessionId: f.sessionId,
    agentId: f.agentId,
    isSubagent: bool(f.isSubagent),
    size: f.size,
    mtimeMs: f.mtimeMs,
    now: f.now,
  }) as { id: number };
  return row.id;
}

export function getSourceFile(db: Db, dev: number, ino: number): SourceFileRow | undefined {
  const r = stmt(db, 'SELECT * FROM source_files WHERE dev = ? AND ino = ?').get(dev, ino) as Row | undefined;
  if (r === undefined) return undefined;
  return {
    id: r['id'] as number,
    dev: r['dev'] as number,
    ino: r['ino'] as number,
    path: r['path'] as string,
    projectDir: r['project_dir'] as string,
    sessionId: r['session_id'] as string,
    agentId: r['agent_id'] as string | null,
    isSubagent: r['is_subagent'] === 1,
    size: r['size'] as number,
    mtimeMs: r['mtime_ms'] as number,
    byteOffset: r['byte_offset'] as number,
    linesRead: r['lines_read'] as number,
    headHash: r['head_hash'] as string | null,
    status: r['status'] as 'active' | 'deleted',
    firstSeenAt: r['first_seen_at'] as number,
    lastIngestedAt: r['last_ingested_at'] as number | null,
    deletedDetectedAt: r['deleted_detected_at'] as number | null,
  };
}

export function setOffset(
  db: Db,
  id: number,
  byteOffset: number,
  linesRead: number,
  headHash: string | null,
  size: number,
  mtimeMs: number,
  at: number = Date.now(),
): void {
  stmt(
    db,
    `UPDATE source_files SET byte_offset = ?, lines_read = ?, head_hash = ?, size = ?, mtime_ms = ?, last_ingested_at = ?
     WHERE id = ?`,
  ).run(byteOffset, linesRead, headHash, size, mtimeMs, at, id);
}

// Active rows, for deletion marking.
export function listActiveSourceFiles(db: Db): Array<{ id: number; dev: number; ino: number; path: string }> {
  return stmt(db, "SELECT id, dev, ino, path FROM source_files WHERE status = 'active'").all() as Array<{ id: number; dev: number; ino: number; path: string }>;
}

export function markDeleted(db: Db, id: number, at: number): void {
  stmt(db, `UPDATE source_files SET status = 'deleted', deleted_detected_at = ? WHERE id = ?`).run(at, id);
}

// ---------------------------------------------------------------- usage events

const USAGE_UPSERT = `
INSERT INTO usage_events (
  event_key, session_id, agent_id, is_sidechain, is_subagent_file, source_file_id, ts, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m, cache_write_1h,
  thinking_tokens, web_search_requests, web_fetch_requests, stop_reason, service_tier, speed, inference_geo, version, entrypoint, rank
) VALUES (
  @key, @sessionId, @agentId, @isSidechain, @isSubagentFile, @sourceFileId, @ts, @model,
  @input, @output, @cacheRead, @cacheWrite, @cacheWrite5m, @cacheWrite1h,
  @thinking, @webSearch, @webFetch, @stopReason, @serviceTier, @speed, @inferenceGeo, @version, @entrypoint, @rank
)
ON CONFLICT(event_key) DO UPDATE SET
  session_id = CASE WHEN usage_events.is_subagent_file = 1 AND excluded.is_subagent_file = 0 THEN excluded.session_id ELSE usage_events.session_id END,
  agent_id = CASE WHEN usage_events.is_subagent_file = 1 AND excluded.is_subagent_file = 0 THEN excluded.agent_id ELSE usage_events.agent_id END,
  is_sidechain = CASE WHEN usage_events.is_subagent_file = 1 AND excluded.is_subagent_file = 0 THEN excluded.is_sidechain ELSE usage_events.is_sidechain END,
  source_file_id = CASE WHEN usage_events.is_subagent_file = 1 AND excluded.is_subagent_file = 0 THEN excluded.source_file_id ELSE usage_events.source_file_id END,
  is_subagent_file = CASE WHEN usage_events.is_subagent_file = 1 AND excluded.is_subagent_file = 0 THEN 0 ELSE usage_events.is_subagent_file END,
  ts = MIN(usage_events.ts, excluded.ts),
  model = CASE WHEN excluded.rank > usage_events.rank THEN excluded.model ELSE usage_events.model END,
  input_tokens = CASE WHEN excluded.rank > usage_events.rank THEN excluded.input_tokens ELSE usage_events.input_tokens END,
  output_tokens = CASE WHEN excluded.rank > usage_events.rank THEN excluded.output_tokens ELSE usage_events.output_tokens END,
  cache_read_tokens = CASE WHEN excluded.rank > usage_events.rank THEN excluded.cache_read_tokens ELSE usage_events.cache_read_tokens END,
  cache_write_tokens = CASE WHEN excluded.rank > usage_events.rank THEN excluded.cache_write_tokens ELSE usage_events.cache_write_tokens END,
  cache_write_5m = CASE WHEN excluded.rank > usage_events.rank THEN excluded.cache_write_5m ELSE usage_events.cache_write_5m END,
  cache_write_1h = CASE WHEN excluded.rank > usage_events.rank THEN excluded.cache_write_1h ELSE usage_events.cache_write_1h END,
  thinking_tokens = CASE WHEN excluded.rank > usage_events.rank THEN excluded.thinking_tokens ELSE usage_events.thinking_tokens END,
  web_search_requests = CASE WHEN excluded.rank > usage_events.rank THEN excluded.web_search_requests ELSE usage_events.web_search_requests END,
  web_fetch_requests = CASE WHEN excluded.rank > usage_events.rank THEN excluded.web_fetch_requests ELSE usage_events.web_fetch_requests END,
  stop_reason = CASE WHEN excluded.rank > usage_events.rank THEN excluded.stop_reason ELSE usage_events.stop_reason END,
  service_tier = CASE WHEN excluded.rank > usage_events.rank THEN excluded.service_tier ELSE usage_events.service_tier END,
  speed = CASE WHEN excluded.rank > usage_events.rank THEN excluded.speed ELSE usage_events.speed END,
  -- Same rule as the other value columns, plus one upgrade step: a row stored before migration 4 has NULL here, and the same line
  -- read again (cli ingest --full) at equal rank fills it. A stored value is never replaced at equal rank.
  inference_geo = CASE WHEN excluded.rank > usage_events.rank THEN excluded.inference_geo
                       WHEN excluded.rank = usage_events.rank THEN COALESCE(usage_events.inference_geo, excluded.inference_geo)
                       ELSE usage_events.inference_geo END,
  version = CASE WHEN excluded.rank > usage_events.rank THEN excluded.version ELSE usage_events.version END,
  entrypoint = CASE WHEN excluded.rank > usage_events.rank THEN excluded.entrypoint ELSE usage_events.entrypoint END,
  rank = MAX(usage_events.rank, excluded.rank)
RETURNING cost_nanos, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m, cache_write_1h, speed, inference_geo
`;

// One statement applies the same rules as mergeUsage (src/ingest/merge.ts); tool uses are added by id.
// The stored cost is priced from the row that results from the merge, so it follows whichever line wins
// and equals a full recompute: it changes only when the priced columns of the row changed.
export function upsertUsage(db: Db, f: UsageFact, sourceFileId: number): void {
  const row = stmt(db, USAGE_UPSERT).get({
    key: f.key,
    sessionId: f.sessionId,
    agentId: f.agentId,
    isSidechain: bool(f.isSidechain),
    isSubagentFile: bool(f.isSubagentFile),
    sourceFileId,
    ts: f.ts,
    model: f.model,
    input: f.input,
    output: f.output,
    cacheRead: f.cacheRead,
    cacheWrite: f.cacheWrite,
    cacheWrite5m: f.cacheWrite5m,
    cacheWrite1h: f.cacheWrite1h,
    thinking: f.thinking,
    webSearch: f.webSearch,
    webFetch: f.webFetch,
    stopReason: f.stopReason,
    serviceTier: f.serviceTier,
    speed: f.speed,
    inferenceGeo: f.inferenceGeo,
    version: f.version,
    entrypoint: f.entrypoint,
    rank: f.rank,
  }) as unknown as CostColumns & { cost_nanos: number | null };
  const cost = priceEventNanos(pricedFromRow(row));
  if (cost !== row.cost_nanos) stmt(db, 'UPDATE usage_events SET cost_nanos = ? WHERE event_key = ?').run(cost, f.key);
  const tool = stmt(db, 'INSERT OR IGNORE INTO tool_calls (tool_use_id, event_key, name) VALUES (?, ?, ?)');
  for (const t of f.toolUses) tool.run(t.id, f.key, t.name);
}

// ---------------------------------------------------------------- messages, errors, compactions

export function insertMessage(db: Db, f: MessageFact): void {
  stmt(
    db,
    'INSERT OR IGNORE INTO messages (uuid, session_id, ts, kind, is_sidechain) VALUES (?, ?, ?, ?, ?)',
  ).run(f.uuid, f.sessionId, f.ts, f.messageKind, bool(f.isSidechain));
}

export function insertApiError(db: Db, f: ApiErrorFact): void {
  stmt(db, 'INSERT OR IGNORE INTO api_errors (uuid, session_id, ts) VALUES (?, ?, ?)').run(f.uuid, f.sessionId, f.ts);
}

export function insertCompaction(db: Db, f: CompactionFact): void {
  stmt(
    db,
    'INSERT OR IGNORE INTO compactions (uuid, session_id, ts, trigger, pre_tokens) VALUES (?, ?, ?, ?, ?)',
  ).run(f.uuid, f.sessionId, f.ts, f.trigger, f.preTokens);
}

// ---------------------------------------------------------------- cost snapshots

// Numbers only: model names as keys, the seven counters as values. No other text from the line is kept.
function modelUsageJson(f: CostSnapshotFact): string {
  const out: Record<string, Record<string, number>> = {};
  for (const [model, u] of Object.entries(f.modelUsage)) {
    out[model] = {
      inputTokens: Number(u.inputTokens) || 0,
      outputTokens: Number(u.outputTokens) || 0,
      thinkingTokens: Number(u.thinkingTokens) || 0,
      cacheReadInputTokens: Number(u.cacheReadInputTokens) || 0,
      cacheCreationInputTokens: Number(u.cacheCreationInputTokens) || 0,
      webSearchRequests: Number(u.webSearchRequests) || 0,
      costUSD: Number(u.costUSD) || 0,
    };
  }
  return JSON.stringify(out);
}

// Replaces the stored snapshot only when the new total duration is strictly larger, or none exists.
export function upsertCostSnapshot(db: Db, f: CostSnapshotFact, sourceFileId: number | null): void {
  stmt(
    db,
    `INSERT INTO cost_snapshots (session_id, start_time, total_duration_ms, total_cost_usd, model_usage_json, captured_from_file_id)
     VALUES (@sessionId, @startTime, @duration, @cost, @json, @fileId)
     ON CONFLICT(session_id) DO UPDATE SET
       start_time = excluded.start_time,
       total_duration_ms = excluded.total_duration_ms,
       total_cost_usd = excluded.total_cost_usd,
       model_usage_json = excluded.model_usage_json,
       captured_from_file_id = excluded.captured_from_file_id
     WHERE excluded.total_duration_ms > COALESCE(cost_snapshots.total_duration_ms, -1)`,
  ).run({
    sessionId: f.sessionId,
    startTime: f.startTime,
    duration: f.totalDuration,
    cost: f.totalCostUSD,
    json: modelUsageJson(f),
    fileId: sourceFileId,
  });
}

// ---------------------------------------------------------------- sessions and projects

function projectName(key: string, cwd: string | null, projectDir: string): string {
  const base = cwd !== null ? basename(cwd) : '';
  if (base !== '') return base;
  return cwd !== null && cwd !== '' ? cwd : projectDir !== '' ? projectDir : key;
}

function ensureProject(db: Db, key: string, cwd: string | null, projectDir: string, at: number): void {
  stmt(
    db,
    'INSERT OR IGNORE INTO projects (project_key, project_dir, display_name, first_seen_at) VALUES (?, ?, ?, ?)',
  ).run(key, projectDir, projectName(key, cwd, projectDir), at);
}

// Smaller string wins, a value beats null. Used only when two events share the exact same ts.
function tieBreak(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

// Fields that follow the earliest event: strictly earlier ts takes the new value, equal ts breaks the tie by value.
function earliest(oldTs: number, oldV: string | null, newTs: number, newV: string | null): string | null {
  if (newTs < oldTs) return newV;
  if (newTs === oldTs) return tieBreak(oldV, newV);
  return oldV;
}

function latest(oldTs: number, oldV: string | null, newTs: number, newV: string | null): string | null {
  if (newTs > oldTs) return newV;
  if (newTs === oldTs) return tieBreak(oldV, newV);
  return oldV;
}

// Folds one event of a MAIN file into its session row. Subagent file lines never create or change a session.
// The result does not depend on the order in which events arrive. Call inside a transaction.
// Returns true when events already in the archive now belong to a different project than before: the project key of
// an existing session moved, or a session row appeared for events that had none (their project was the empty key).
export function upsertSession(db: Db, f: LineMeta, projectDir: string, at: number = Date.now()): boolean {
  if ('isSubagentFile' in f && (f as { isSubagentFile: unknown }).isSubagentFile === true) {
    throw new Error('upsertSession: facts from subagent files must not create or change sessions');
  }
  const cur = stmt(db, 'SELECT * FROM sessions WHERE session_id = ?').get(f.sessionId) as Row | undefined;
  const fallback = `dir:${projectDir}`;

  if (cur === undefined) {
    const key = f.cwd ?? fallback;
    ensureProject(db, key, f.cwd, projectDir, at);
    stmt(
      db,
      `INSERT INTO sessions (session_id, project_key, first_ts, last_ts, entrypoint, first_version, last_version, git_branch, project_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(f.sessionId, key, f.ts, f.ts, f.entrypoint, f.version, f.version, f.gitBranch, f.cwd !== null ? f.ts : null);
    return (
      stmt(db, 'SELECT 1 AS x FROM usage_events WHERE session_id = ? LIMIT 1').get(f.sessionId) !== undefined ||
      stmt(db, 'SELECT 1 AS x FROM messages WHERE session_id = ? LIMIT 1').get(f.sessionId) !== undefined
    );
  }

  const firstTs = cur['first_ts'] as number;
  const lastTs = cur['last_ts'] as number;
  let projectKey = cur['project_key'] as string;
  let projectTs = cur['project_ts'] as number | null;
  if (f.cwd !== null) {
    const takes = projectTs === null || f.ts < projectTs || (f.ts === projectTs && f.cwd < projectKey);
    if (takes) {
      projectKey = f.cwd;
      projectTs = f.ts;
    }
  }
  const oldKey = cur['project_key'] as string;
  if (projectKey !== oldKey) ensureProject(db, projectKey, f.cwd, projectDir, at);

  stmt(
    db,
    `UPDATE sessions SET project_key = ?, first_ts = ?, last_ts = ?, entrypoint = ?, first_version = ?, last_version = ?,
       git_branch = ?, project_ts = ? WHERE session_id = ?`,
  ).run(
    projectKey,
    Math.min(firstTs, f.ts),
    Math.max(lastTs, f.ts),
    earliest(firstTs, cur['entrypoint'] as string | null, f.ts, f.entrypoint),
    earliest(firstTs, cur['first_version'] as string | null, f.ts, f.version),
    latest(lastTs, cur['last_version'] as string | null, f.ts, f.version),
    earliest(firstTs, cur['git_branch'] as string | null, f.ts, f.gitBranch),
    projectTs,
    f.sessionId,
  );

  if (projectKey !== oldKey) {
    // The old key was only a stand in (or a later cwd); drop it when nothing refers to it any more,
    // so the projects table is the same whatever order the events came in.
    stmt(
      db,
      `DELETE FROM projects WHERE project_key = ? AND NOT EXISTS (SELECT 1 FROM sessions WHERE project_key = ?)`,
    ).run(oldKey, oldKey);
  }
  return projectKey !== oldKey;
}

// A custom title is never replaced by an ai title. Within the same source the latest call wins.
export function setSessionTitle(db: Db, sessionId: string, source: 'ai' | 'custom', title: string, at: number): void {
  stmt(
    db,
    `INSERT INTO session_titles (session_id, source, title, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET source = excluded.source, title = excluded.title, updated_at = excluded.updated_at
     WHERE NOT (session_titles.source = 'custom' AND excluded.source = 'ai')`,
  ).run(sessionId, source, title, at);
}

// ---------------------------------------------------------------- counters and aliases

export function bumpUnknownType(db: Db, sourceFileId: number, type: string, version: string | null, n: number, at: number): void {
  stmt(
    db,
    `INSERT INTO unknown_types (type, version, source_file_id, count, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(type, version, source_file_id) DO UPDATE SET count = unknown_types.count + excluded.count,
       last_seen_at = MAX(unknown_types.last_seen_at, excluded.last_seen_at)`,
  ).run(type, version ?? '', sourceFileId, n, at);
}

export function bumpMissingField(db: Db, sourceFileId: number, field: string, version: string | null, n: number, at: number): void {
  stmt(
    db,
    `INSERT INTO missing_fields (field, version, source_file_id, count, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(field, version, source_file_id) DO UPDATE SET count = missing_fields.count + excluded.count,
       last_seen_at = MAX(missing_fields.last_seen_at, excluded.last_seen_at)`,
  ).run(field, version ?? '', sourceFileId, n, at);
}

// Removes the counters and error rows of one file. Called in the first batch of a reread from offset 0.
export function clearFileDiagnostics(db: Db, sourceFileId: number): void {
  stmt(db, 'DELETE FROM unknown_types WHERE source_file_id = ?').run(sourceFileId);
  stmt(db, 'DELETE FROM missing_fields WHERE source_file_id = ?').run(sourceFileId);
  stmt(db, 'DELETE FROM ingest_errors WHERE source_file_id = ?').run(sourceFileId);
}

export interface IngestErrorInput {
  runId: number;
  sourceFileId: number;
  // Null for a problem with the whole file (for example it cannot be read).
  lineNo: number | null;
  byteOffset: number | null;
  lineLength: number | null;
  error: string;
  at: number;
}

export function insertIngestError(db: Db, e: IngestErrorInput): void {
  stmt(
    db,
    `INSERT INTO ingest_errors (run_id, source_file_id, line_no, byte_offset, line_length, error, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.runId, e.sourceFileId, e.lineNo, e.byteOffset, e.lineLength, e.error, e.at);
}

export function upsertAlias(db: Db, aliasDir: string, targetDir: string, at: number): void {
  stmt(
    db,
    `INSERT INTO project_aliases (alias_dir, target_dir, seen_at) VALUES (?, ?, ?)
     ON CONFLICT(alias_dir) DO UPDATE SET target_dir = excluded.target_dir, seen_at = MAX(project_aliases.seen_at, excluded.seen_at)`,
  ).run(aliasDir, targetDir, at);
}
