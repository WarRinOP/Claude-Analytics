// The parts of GET /api/health that come from the archive and from the Claude Code session registry.
// Counts, ids, timestamps and paths only. Nothing here reads transcript content.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { Health } from '../api/types.ts';
import { isInside } from '../config/paths.ts';
import { costStateCrossCheck } from '../ingest/crosscheck.ts';
import { PRICE_TABLE_DATE } from './prices.ts';
import type { SyncStatus } from '../ingest/scheduler.ts';
import { stmt, type Db } from '../store/db.ts';

const MIN = 60_000;
export const CANARY_WINDOW_MS = 10 * MIN;

// ---------------------------------------------------------------- the archive

export function lastPass(db: Db): Health['lastPass'] {
  const r = stmt(
    db,
    `SELECT started_at, finished_at, trigger, files_scanned, files_changed, lines_read, errors
       FROM ingest_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
  ).get() as { started_at: number; finished_at: number; trigger: string | null; files_scanned: number; files_changed: number; lines_read: number; errors: number } | undefined;
  if (r === undefined) return null;
  return {
    at: r.finished_at,
    durationMs: Math.max(0, r.finished_at - r.started_at),
    trigger: r.trigger ?? '',
    filesScanned: r.files_scanned,
    filesChanged: r.files_changed,
    linesRead: r.lines_read,
    errors: r.errors,
  };
}

// A file path as the panel shows it: relative to the source folder when it lies inside it, else the project folder and the
// file name (a folder given with --root, or a file whose row has lost its path).
export function displayPath(path: string | null, root: string): string {
  if (path === null || path === '') return '(unknown file)';
  if (root !== '' && isInside(root, path)) {
    const rel = relative(root, path);
    if (rel !== '') return rel.split(sep).join('/');
  }
  return `${basename(dirname(path))}/${basename(path)}`;
}

export function recentErrors(db: Db, root: string): Health['recentErrors'] {
  const rows = stmt(
    db,
    `SELECT e.line_no, e.byte_offset, e.error, e.at, f.path
       FROM ingest_errors e LEFT JOIN source_files f ON f.id = e.source_file_id
      ORDER BY e.at DESC, e.id DESC LIMIT 50`,
  ).all() as unknown as Array<{ line_no: number | null; byte_offset: number | null; error: string; at: number; path: string | null }>;
  return rows.map((r) => ({ file: displayPath(r.path, root), lineNo: r.line_no, byteOffset: r.byte_offset, error: r.error, at: r.at }));
}

export function unknownTypes(db: Db): Health['unknownTypes'] {
  const rows = stmt(
    db,
    `SELECT type, version, SUM(count) AS n, MAX(last_seen_at) AS seen FROM unknown_types
      GROUP BY type, version ORDER BY n DESC, type, version LIMIT 100`,
  ).all() as unknown as Array<{ type: string; version: string; n: number; seen: number }>;
  return rows.map((r) => ({ type: r.type, version: r.version, count: r.n, lastSeenAt: r.seen }));
}

export function missingFields(db: Db): Health['missingFields'] {
  const rows = stmt(
    db,
    `SELECT field, version, SUM(count) AS n FROM missing_fields GROUP BY field, version ORDER BY n DESC, field, version LIMIT 100`,
  ).all() as unknown as Array<{ field: string; version: string; n: number }>;
  return rows.map((r) => ({ field: r.field, version: r.version, count: r.n }));
}

export function versions(db: Db): Health['versions'] {
  const rows = stmt(
    db,
    `SELECT COALESCE(version, '') AS v, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM usage_events
      GROUP BY COALESCE(version, '') ORDER BY last DESC, v DESC LIMIT 100`,
  ).all() as unknown as Array<{ v: string; n: number; first: number; last: number }>;
  return rows.map((r) => ({ version: r.v, responses: r.n, firstTs: r.first, lastTs: r.last }));
}

export function entrypoints(db: Db): Health['entrypoints'] {
  const rows = stmt(
    db,
    `SELECT COALESCE(entrypoint, '') AS e, COUNT(*) AS n FROM usage_events GROUP BY COALESCE(entrypoint, '') ORDER BY n DESC, e LIMIT 50`,
  ).all() as unknown as Array<{ e: string; n: number }>;
  return rows.map((r) => ({ entrypoint: r.e, responses: r.n }));
}

export function aliases(db: Db): Health['aliases'] {
  const rows = stmt(db, 'SELECT alias_dir, target_dir FROM project_aliases ORDER BY alias_dir').all() as unknown as Array<{ alias_dir: string; target_dir: string }>;
  return rows.map((r) => ({ aliasDir: r.alias_dir, targetDir: r.target_dir }));
}

// The whole session comparison (subagent files included), the one `verify` reports. Never changes a number.
export function costCheck(db: Db): Health['costCheck'] {
  const x = costStateCrossCheck(db);
  return {
    sessionsWithSnapshot: x.snapshots,
    compared: x.a.compared,
    withinOnePercent: x.a.agree,
    exceptions: x.a.worst.map((e) => ({ sessionId: e.sessionId, ours: e.ours, theirs: e.theirs, percent: e.percent })),
  };
}

// The price table behind the API price equivalent: its date, the models that have no price (their events are
// counted, never priced as zero) and the events whose cache write parts did not add up (the remainder is priced at the 5 minute rate).
export function prices(db: Db): Health['prices'] {
  const unpriced = stmt(db, 'SELECT model, COUNT(*) AS n FROM usage_events WHERE cost_nanos IS NULL GROUP BY model ORDER BY n DESC, model LIMIT 100').all() as unknown as Array<{ model: string; n: number }>;
  const rest = stmt(db, 'SELECT COUNT(*) AS n FROM usage_events WHERE cost_nanos IS NOT NULL AND cache_write_tokens > cache_write_5m + cache_write_1h').get() as { n: number };
  return {
    tableDate: PRICE_TABLE_DATE,
    unpricedModels: unpriced.map((r) => ({ model: r.model, responses: r.n })),
    cacheWriteRemainderEvents: rest.n,
  };
}

// ---------------------------------------------------------------- what `doctor` knows without a running service

// The sync state as far as the archive tells it: the newest finished pass. A newest pass that never finished means a service
// stopped in the middle of it, unless `serviceRunning` says one is running right now.
export function syncFromRuns(db: Db, serviceRunning: boolean): SyncStatus {
  const done = lastPass(db);
  const newest = stmt(db, 'SELECT finished_at FROM ingest_runs ORDER BY id DESC LIMIT 1').get() as { finished_at: number | null } | undefined;
  const unfinished = newest !== undefined && newest.finished_at === null;
  return {
    running: serviceRunning && unfinished,
    lastPassAt: done?.at ?? null,
    lastSuccessAt: done?.at ?? null,
    lastError: unfinished && !serviceRunning ? 'the newest pass never finished, so the service stopped in the middle of it' : null,
    watcherAlive: serviceRunning,
  };
}

// ---------------------------------------------------------------- the canary

export interface CanaryOptions {
  sessionsDir: string; // <Claude config dir>/sessions
  sourceRoot: string; // <Claude config dir>/projects
  now: number;
}

interface LiveSession {
  sessionId: string;
  updatedAt: number;
}

const MAX_REGISTRY_FILES = 500;
const MAX_REGISTRY_BYTES = 256 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

// Reads one registry file and keeps only `sessionId` and `updatedAt`. Every other key is dropped at once.
function readLive(file: string): LiveSession | null {
  try {
    if (statSync(file).size > MAX_REGISTRY_BYTES) return null;
    const rec = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const { sessionId, updatedAt } = rec as { sessionId?: unknown; updatedAt?: unknown };
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) return null;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
    return { sessionId, updatedAt };
  } catch {
    return null;
  }
}

// The newest write to any transcript of a session: the files the archive tracks (checked on disk, because the archive's own
// timestamp can be a minute old) plus a look for `<session>.jsonl` in each project folder, for a file not ingested yet.
function newestWrite(db: Db, sessionId: string, root: string): number | null {
  let newest: number | null = null;
  const see = (ms: number): void => {
    if (newest === null || ms > newest) newest = ms;
  };
  const rows = stmt(db, "SELECT path, mtime_ms FROM source_files WHERE session_id = ? AND status = 'active'").all(sessionId) as unknown as Array<{ path: string; mtime_ms: number }>;
  for (const r of rows) {
    try {
      see(statSync(r.path).mtimeMs);
    } catch {
      see(r.mtime_ms);
    }
  }
  try {
    for (const dir of readdirSync(root)) {
      try {
        see(statSync(join(root, dir, `${sessionId}.jsonl`)).mtimeMs);
      } catch {
        // not in this project folder
      }
    }
  } catch {
    // the source folder cannot be listed: the archive's rows are all there is
  }
  return newest;
}

const shortId = (id: string): string => id.slice(0, 8);

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / MIN))} min`;

// A live session in ~/.claude/sessions updated in the last 10 minutes whose transcript has not grown for 10 minutes means the
// transcripts may have moved. Parses only `sessionId` and `updatedAt` of the registry files, reads nothing else there.
export function checkCanary(db: Db, o: CanaryOptions): Health['canary'] {
  let names: string[];
  try {
    names = readdirSync(o.sessionsDir).filter((n) => n.endsWith('.json') && !n.endsWith('.key'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    return {
      status: 'unknown',
      message:
        code === 'ENOENT'
          ? "Claude Code's live session folder (the sessions folder next to projects) does not exist, so this check could not run. That is normal when Claude Code has never been started here."
          : `Claude Code's live session folder could not be read (${code}), so this check could not run.`,
    };
  }
  if (names.length > MAX_REGISTRY_FILES) names = names.slice(0, MAX_REGISTRY_FILES);
  const live: LiveSession[] = [];
  for (const n of names) {
    const s = readLive(join(o.sessionsDir, n));
    if (s !== null) live.push(s);
  }
  if (names.length > 0 && live.length === 0) {
    return { status: 'unknown', message: `None of the ${names.length} files in Claude Code's live session folder could be read, so this check could not run.` };
  }
  const recent = live.filter((s) => o.now - s.updatedAt <= CANARY_WINDOW_MS);
  if (recent.length === 0) {
    return { status: 'ok', message: 'No Claude Code session was updated in the last 10 minutes, so there is nothing to compare with the transcripts.' };
  }
  const stalled: Array<{ id: string; idle: number }> = [];
  let growing = 0;
  let waiting = 0;
  for (const s of recent) {
    const last = newestWrite(db, s.sessionId, o.sourceRoot);
    if (last === null) waiting += 1;
    else if (o.now - last > CANARY_WINDOW_MS) stalled.push({ id: s.sessionId, idle: o.now - last });
    else growing += 1;
  }
  if (stalled.length > 0) {
    stalled.sort((x, y) => y.idle - x.idle);
    const worst = stalled[0] as { id: string; idle: number };
    const shortest = stalled[stalled.length - 1] as { id: string; idle: number };
    const what =
      stalled.length === 1
        ? `Session ${shortId(worst.id)} was updated in the last 10 minutes, but its transcript has not changed for ${minutes(worst.idle)}.`
        : `${stalled.length} sessions were updated in the last 10 minutes, but their transcripts have not changed for at least ${minutes(shortest.idle)}.`;
    return { status: 'warning', message: `${what} Claude Code may be writing transcripts somewhere else. Check that a new session still appears in the dashboard.` };
  }
  const was = (n: number): string => (n === 1 ? 'session was' : 'sessions were');
  const waitingText = waiting === 0 ? '' : growing > 0 ? ` ${waiting} more ${waiting === 1 ? 'has' : 'have'} no transcript yet, which is normal before the first message.` : '';
  if (growing === 0) {
    return { status: 'ok', message: `${waiting} ${was(waiting)} updated in the last 10 minutes with no transcript yet, which is normal before the first message.` };
  }
  return {
    status: 'ok',
    message: `${growing} ${was(growing)} updated in the last 10 minutes and ${growing === 1 ? 'its transcript is' : 'their transcripts are'} growing.${waitingText}`,
  };
}
