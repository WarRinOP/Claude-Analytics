// One ingest pass: discovery, reader, classifier and repository joined together.
// Each batch of lines is written together with the file's new offset in ONE SQLite transaction, so a crash
// leaves either the old offset with no new rows or the new offset with all of them. Source files are only read.
import { resolve } from 'node:path';
import { classify } from './classify.ts';
import { foldBatch, type FoldedBatch } from './dedupe.ts';
import { discover, type DiscoveredFile } from './discover.ts';
import type { Fact, LineContext } from './facts.ts';
import { headHash, headLength, planRead, readLines, type LineBatch, type ReadOptions, type ReadPlan } from './reader.ts';
import { isInside } from '../config/paths.ts';
import { getMeta } from '../metrics/rollups.ts';
import { transaction, stmt, type Db } from '../store/db.ts';
import {
  bumpMissingField,
  bumpUnknownType,
  clearFileDiagnostics,
  getSourceFile,
  insertApiError,
  insertCompaction,
  insertIngestError,
  insertMessage,
  listActiveSourceFiles,
  markDeleted,
  setOffset,
  setSessionTitle,
  upsertAlias,
  upsertCostSnapshot,
  upsertSession,
  upsertSourceFile,
  upsertUsage,
  type SourceFileRow,
} from '../store/repo.ts';

export interface BatchInfo {
  sourceFileId: number;
  path: string;
  // 1 based count of batches handled in this run, across all files.
  batchNo: number;
  endOffset: number;
  lines: number;
}

export interface IngestOptions {
  roots: string[]; // the first root is the live source; only its aliases are recorded
  full: boolean;
  trigger: string;
  now?: () => number;
  // Called after a batch has been committed.
  onBatchCommitted?: (info: BatchInfo) => void;
  // Called inside the transaction of a batch, after its rows are written and before it commits.
  // Throwing here rolls the batch back (used by tests to simulate a crash between two chunks).
  faultInTransaction?: (info: BatchInfo) => void;
  // Reader limits, small in tests.
  read?: ReadOptions;
}

export interface RunSummary {
  runId: number;
  // The trigger the pass was started with: cli, startup, watch or poll.
  trigger: string;
  filesScanned: number;
  filesChanged: number;
  linesRead: number;
  // Classified lines by fact kind (for example usage, message, ignored, malformed).
  factsByKind: Record<string, number>;
  // Usage events written after folding within batches.
  eventsUpserted: number;
  // Lines that could not be parsed, plus files that could not be read (counted once, when the error row is first written).
  errors: number;
  durationMs: number;
  // Source files whose path lies in a scanned root and that were no longer found in this pass.
  filesMarkedDeleted: number;
  // Smallest and largest ts of usage, message, api error and compaction facts written in this pass, null when none.
  changedRange: { minTs: number; maxTs: number } | null;
  // Sessions in this pass whose events moved to another project (the key of a known session changed, or a session
  // row appeared for events that had none). Rollups need a full rebuild when this is above 0.
  sessionsReprojected: number;
}

interface Counters {
  filesScanned: number;
  filesChanged: number;
  linesRead: number;
  factsByKind: Record<string, number>;
  eventsUpserted: number;
  errors: number;
  batchNo: number;
  minTs: number | null;
  maxTs: number | null;
  filesMarkedDeleted: number;
  sessionsReprojected: number;
}

function newCounters(): Counters {
  return {
    filesScanned: 0,
    filesChanged: 0,
    linesRead: 0,
    factsByKind: {},
    eventsUpserted: 0,
    errors: 0,
    batchNo: 0,
    minTs: null,
    maxTs: null,
    filesMarkedDeleted: 0,
    sessionsReprojected: 0,
  };
}

// A failure of the operating system while opening or reading one file (EACCES, EIO, EISDIR and so on).
// Database errors (code ERR_SQLITE_ERROR) and errors thrown by test hooks do not match and still abort the pass.
function isFileSystemError(err: unknown): err is NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code);
}

const UNREADABLE = 'cannot read file: ';

// One row per file and text, however many passes meet the same problem. Returns true when a row was added.
function recordUnreadable(db: Db, sourceFileId: number, runId: number, code: string, at: number): boolean {
  const text = `${UNREADABLE}${code}`;
  const exists = stmt(db, 'SELECT 1 AS x FROM ingest_errors WHERE source_file_id = ? AND line_no IS NULL AND error = ?').get(sourceFileId, text);
  if (exists !== undefined) return false;
  insertIngestError(db, { runId, sourceFileId, lineNo: null, byteOffset: null, lineLength: null, error: text, at });
  return true;
}

function clearUnreadable(db: Db, sourceFileId: number): void {
  stmt(db, "DELETE FROM ingest_errors WHERE source_file_id = ? AND line_no IS NULL AND error LIKE 'cannot read file: %'").run(sourceFileId);
}

// Writes one folded batch with the repository functions. Exported for the folding equivalence test.
// Returns how many session upserts moved events to another project (see upsertSession).
export function writeFolded(db: Db, sourceFileId: number, projectDir: string, b: FoldedBatch, at: number): number {
  let reprojected = 0;
  for (const m of b.sessionMetas) if (upsertSession(db, m, projectDir, at)) reprojected += 1;
  for (const u of b.usage) upsertUsage(db, u, sourceFileId);
  for (const m of b.messages) insertMessage(db, m);
  for (const e of b.apiErrors) insertApiError(db, e);
  for (const c of b.compactions) insertCompaction(db, c);
  for (const s of b.costSnapshots) upsertCostSnapshot(db, s, sourceFileId);
  for (const t of b.titles) setSessionTitle(db, t.sessionId, t.source, t.title, at);
  for (const u of b.unknownTypes) bumpUnknownType(db, sourceFileId, u.type, u.version, u.count, at);
  for (const m of b.missingFields) bumpMissingField(db, sourceFileId, m.field, m.version, m.count, at);
  return reprojected;
}

function contextOf(f: DiscoveredFile): LineContext {
  return { sessionIdFromFile: f.sessionId, isSubagentFile: f.isSubagent, agentIdFromFile: f.agentId };
}

async function ingestFile(
  db: Db,
  f: DiscoveredFile,
  runId: number,
  opts: IngestOptions,
  now: () => number,
  c: Counters,
): Promise<void> {
  c.filesScanned += 1;
  const known = getSourceFile(db, f.dev, f.ino);
  const id = upsertSourceFile(db, {
    dev: f.dev,
    ino: f.ino,
    path: f.path,
    projectDir: f.projectDir,
    sessionId: f.sessionId,
    agentId: f.agentId,
    isSubagent: f.isSubagent,
    size: f.size,
    mtimeMs: f.mtimeMs,
    now: now(),
  });

  try {
    await readFile(db, f, id, known, runId, opts, now, c);
  } catch (err) {
    // One unreadable file is a recorded error, not a failed run. The next pass tries it again.
    if (!isFileSystemError(err)) throw err;
    if (recordUnreadable(db, id, runId, err.code ?? 'UNKNOWN', now())) c.errors += 1;
  }
}

async function readFile(
  db: Db,
  f: DiscoveredFile,
  id: number,
  known: SourceFileRow | undefined,
  runId: number,
  opts: IngestOptions,
  now: () => number,
  c: Counters,
): Promise<void> {
  let plan: ReadPlan;
  if (opts.full) {
    plan = { action: known === undefined ? 'new' : 'reset', start: 0 };
  } else {
    const current = known !== undefined && known.byteOffset > 0 ? await headHash(f.path, headLength(known.byteOffset)) : null;
    plan = planRead(f, known, current);
  }
  if (plan.action === 'unchanged') {
    clearUnreadable(db, id); // the head could be read, so an earlier "cannot read file" row is out of date
    return;
  }
  c.filesChanged += 1;

  const startLineNo = plan.action === 'append' && known !== undefined ? known.linesRead : 0;
  const ctx = contextOf(f);
  let first = true;
  let committed = false;

  for await (const batch of readLines(f.path, plan.start, startLineNo, opts.read)) {
    const hash = batch.endOffset > 0 ? await headHash(f.path, headLength(batch.endOffset)) : null;
    const at = now();
    const info: BatchInfo = { sourceFileId: id, path: f.path, batchNo: c.batchNo + 1, endOffset: batch.endOffset, lines: batch.lines.length };
    const stats = transaction(db, () => {
      if (first && plan.start === 0) clearFileDiagnostics(db, id);
      const s = writeBatch(db, id, f, ctx, batch, runId, at);
      if (opts.faultInTransaction !== undefined) opts.faultInTransaction(info);
      setOffset(db, id, batch.endOffset, batch.endLineNo, hash, f.size, f.mtimeMs, at);
      return s;
    });
    first = false;
    committed = true;
    c.batchNo += 1;
    c.linesRead += batch.lines.length + batch.oversized.length;
    c.eventsUpserted += stats.events;
    c.errors += stats.errors;
    c.sessionsReprojected += stats.reprojected;
    if (stats.minTs !== null && stats.maxTs !== null) {
      c.minTs = c.minTs === null ? stats.minTs : Math.min(c.minTs, stats.minTs);
      c.maxTs = c.maxTs === null ? stats.maxTs : Math.max(c.maxTs, stats.maxTs);
    }
    for (const [k, n] of Object.entries(stats.kinds)) c.factsByKind[k] = (c.factsByKind[k] ?? 0) + n;
    if (opts.onBatchCommitted !== undefined) opts.onBatchCommitted(info);
  }

  clearUnreadable(db, id); // the whole read worked

  // Nothing was readable (empty file, only a partial last line, or a file that became empty): still clear
  // what an earlier read left behind and record the position, so the file is not treated as new again.
  if (!committed && plan.start === 0) {
    transaction(db, () => {
      clearFileDiagnostics(db, id);
      setOffset(db, id, 0, 0, null, f.size, f.mtimeMs, now());
    });
  }
}

function writeBatch(
  db: Db,
  id: number,
  f: DiscoveredFile,
  ctx: LineContext,
  batch: LineBatch,
  runId: number,
  at: number,
): { events: number; errors: number; kinds: Record<string, number>; minTs: number | null; maxTs: number | null; reprojected: number } {
  const kinds: Record<string, number> = {};
  const facts: Fact[] = [];
  let errors = 0;
  for (const line of batch.lines) {
    const fact = classify(line.text, ctx);
    kinds[fact.kind] = (kinds[fact.kind] ?? 0) + 1;
    if (fact.kind === 'malformed') {
      insertIngestError(db, {
        runId,
        sourceFileId: id,
        lineNo: line.lineNo,
        byteOffset: line.byteOffset,
        lineLength: Buffer.byteLength(line.text, 'utf8'),
        error: fact.error,
        at,
      });
      errors += 1;
    } else {
      facts.push(fact);
    }
  }
  for (const o of batch.oversized) {
    insertIngestError(db, {
      runId,
      sourceFileId: id,
      lineNo: o.lineNo,
      byteOffset: o.byteOffset,
      lineLength: o.length,
      error: 'line too large, skipped',
      at,
    });
    errors += 1;
  }
  const folded = foldBatch(facts, f.isSubagent);
  const reprojected = writeFolded(db, id, f.projectDir, folded, at);
  let minTs: number | null = null;
  let maxTs: number | null = null;
  for (const group of [folded.usage, folded.messages, folded.apiErrors, folded.compactions]) {
    for (const x of group) {
      if (minTs === null || x.ts < minTs) minTs = x.ts;
      if (maxTs === null || x.ts > maxTs) maxTs = x.ts;
    }
  }
  return { events: folded.usage.length, errors, kinds, minTs, maxTs, reprojected };
}

const META_ARCHIVE_STARTED = 'archive_started_at';

// The moment the archive began, to be stored by the first successful pass and never changed afterwards. Null when it
// is already stored. A database that already holds source files but has no value (it was filled before this value was
// kept) gets the oldest first_seen_at instead of the time of this pass.
function archiveStartCandidate(db: Db, passStart: number): number | null {
  if (getMeta(db, META_ARCHIVE_STARTED) !== null) return null;
  const r = stmt(db, 'SELECT MIN(first_seen_at) AS ts FROM source_files').get() as { ts: number | null };
  return r.ts === null ? passStart : Math.min(r.ts, passStart);
}

function setMetaOnce(db: Db, key: string, value: string): void {
  stmt(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, value);
}

export async function runIngest(db: Db, opts: IngestOptions): Promise<RunSummary> {
  const now = opts.now ?? Date.now;
  const t0 = Date.now();
  const t0Ms = now();
  const c = newCounters();
  const runId = (
    stmt(db, 'INSERT INTO ingest_runs (started_at, trigger, files_scanned, files_changed, lines_read, events_upserted, errors) VALUES (?, ?, 0, 0, 0, 0, 0) RETURNING id').get(
      now(),
      opts.trigger,
    ) as { id: number }
  ).id;

  // Remembered at the start of the pass and written once it has worked (see markArchiveStart).
  const archiveStartedAt = archiveStartCandidate(db, t0Ms);

  const finish = (): RunSummary => {
    stmt(
      db,
      'UPDATE ingest_runs SET finished_at = ?, files_scanned = ?, files_changed = ?, lines_read = ?, events_upserted = ?, errors = ? WHERE id = ?',
    ).run(now(), c.filesScanned, c.filesChanged, c.linesRead, c.eventsUpserted, c.errors, runId);
    return {
      runId,
      trigger: opts.trigger,
      filesScanned: c.filesScanned,
      filesChanged: c.filesChanged,
      linesRead: c.linesRead,
      factsByKind: c.factsByKind,
      eventsUpserted: c.eventsUpserted,
      errors: c.errors,
      durationMs: Date.now() - t0,
      filesMarkedDeleted: c.filesMarkedDeleted,
      changedRange: c.minTs !== null && c.maxTs !== null ? { minTs: c.minTs, maxTs: c.maxTs } : null,
      sessionsReprojected: c.sessionsReprojected,
    };
  };

  try {
    // Discover every root first. A file reached from two roots by the same (dev, ino) is read once.
    const files = new Map<string, DiscoveredFile>();
    // Roots whose listing worked. A root that was not found or could not be listed proves nothing about its files.
    const scanned: string[] = [];
    const skippedPaths: string[] = [];
    opts.roots.forEach((root, i) => {
      const d = discover(root);
      if (!d.skipped.some((x) => x.path === root)) scanned.push(resolve(root));
      for (const x of d.skipped) skippedPaths.push(resolve(x.path));
      if (i === 0) for (const a of d.aliases) upsertAlias(db, a.aliasDir, a.targetDir, now());
      for (const f of d.files) {
        const k = `${f.dev}:${f.ino}`;
        if (!files.has(k)) files.set(k, f);
      }
    });
    const all = [...files.values()];
    // Main files first, so attribution of a key seen in both kinds of file starts at the main file.
    const ordered = [...all.filter((f) => !f.isSubagent), ...all.filter((f) => f.isSubagent)];
    for (const f of ordered) await ingestFile(db, f, runId, opts, now, c);

    // Deletion marking: rows stay, the file is only flagged. Never under a root that was not
    // scanned or could not be listed, and never under a folder that discovery could not read.
    const present = new Set(all.map((f) => `${f.dev}:${f.ino}`));
    const gone = listActiveSourceFiles(db).filter(
      (r) =>
        !present.has(`${r.dev}:${r.ino}`) &&
        scanned.some((root) => isInside(root, r.path)) &&
        !skippedPaths.some((p) => isInside(p, r.path)),
    );
    if (gone.length > 0) {
      const at = now();
      transaction(db, () => {
        for (const r of gone) markDeleted(db, r.id, at);
      });
      c.filesMarkedDeleted = gone.length;
    }

    // At least one root must have been listed: a missing folder proves nothing, and the archive has not begun yet.
    if (archiveStartedAt !== null && scanned.length > 0) setMetaOnce(db, META_ARCHIVE_STARTED, String(archiveStartedAt));

    stmt(
      db,
      `UPDATE sessions SET has_subagents = CASE WHEN EXISTS (
         SELECT 1 FROM source_files sf WHERE sf.session_id = sessions.session_id AND sf.is_subagent = 1
       ) THEN 1 ELSE 0 END`,
    ).run();
  } catch (err) {
    try {
      finish();
    } catch {
      // the original error is the useful one
    }
    throw err;
  }
  return finish();
}
