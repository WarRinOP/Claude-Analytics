// `node src/cli.ts doctor`: prints the Data health report as plain text (the same checks and wording as the dashboard panel).
// It opens the archive for reading only: no ingest, no migration, no lock. Exit 0 when healthy, 1 when the status is
// degraded or the transcript check warns (or when the archive cannot be read at all).
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Health } from '../api/types.ts';
import { dataDir, dbPath } from '../config/paths.ts';
import { tz as configuredTz } from '../config/settings.ts';
import { lockPath } from '../ingest/lock.ts';
import { syncFromRuns } from '../metrics/health.ts';
import {
  COST_CHECK_WHY,
  bytesText,
  countText,
  dayText,
  errorExplanation,
  healthChecks,
  needsAttention,
  overall,
  placeText,
  plural,
  shortId,
  stampText,
  type Check,
} from '../metrics/healthChecks.ts';
import { health } from '../metrics/queries.ts';
import { defaultMigrationsDir, readMigrations } from '../store/migrate.ts';
import { openDb, type Db } from '../store/db.ts';

const MARK: Record<Check['verdict'], string> = { ok: '[ok]     ', note: '[look]   ', problem: '[problem]' };

// The pid in the service's lock file when that process is alive, else null. Reads only the app's own lock file.
function runningService(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(), 'utf8').trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null;
    }
    return pid;
  } catch {
    return null;
  }
}

function pendingMigrations(db: Db): number[] {
  let done: Set<number>;
  try {
    done = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
  } catch {
    done = new Set();
  }
  return readMigrations(defaultMigrationsDir())
    .map((m) => m.version)
    .filter((v) => !done.has(v));
}

const cap = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 3)}...` : text);

// The report as lines of text. Pure: a Health answer in, lines out (so it can be tested without a database).
export function renderDoctor(h: Health, o: { now: number; service: number | null; dbFile?: string }): string[] {
  const checks = healthChecks(h, { now: o.now, live: false });
  const head = overall(h, checks);
  const out: string[] = [];
  out.push(`Usage Ledger doctor, version ${h.appVersion}`);
  out.push(`Status: ${head.word}${h.status === 'degraded' ? ' (sync reports a problem)' : ''}`);
  out.push(o.service === null ? 'Service: not running, so nothing is keeping the archive current right now.' : `Service: running (process ${o.service}).`);
  out.push('');
  out.push('Checks');
  for (const c of checks) {
    out.push(`  ${MARK[c.verdict]} ${c.name}: ${c.text}`);
  }
  out.push('');
  out.push('Archive');
  out.push(`  Time zone ${h.tz}. Archive starts ${h.archiveStart === null ? 'when the first transcript is read' : dayText(h.archiveStart)}.`);
  out.push(
    h.completeFrom === null
      ? '  Complete from: not known yet.'
      : `  Complete from ${dayText(h.completeFrom)}. Claude Code keeps transcripts ${h.retentionDays} days, so earlier days only hold sessions that were continued later.`,
  );
  out.push(`  Source folder ${h.sourceRoot}`);
  out.push(`  Database ${bytesText(h.dbBytes)}${o.dbFile === undefined ? '' : ` at ${o.dbFile}`}. ${plural(h.sessions.total, 'session')} archived.`);
  if (h.aliases.length === 0) out.push('  Symlink aliases: none found.');
  else for (const a of h.aliases.slice(0, 5)) out.push(`  Symlink alias ${a.aliasDir} points at ${a.targetDir}`);

  if (h.recentErrors.length > 0) {
    out.push('');
    out.push(`Ingest errors (newest first, ${Math.min(h.recentErrors.length, 6)} of ${countText(h.errors.total)})`);
    for (const e of h.recentErrors.slice(0, 6)) out.push(`  ${e.file}, ${placeText(e.lineNo, e.byteOffset)}: ${e.error}. ${errorExplanation(e.error)}`);
  }
  if (h.unknownTypes.length > 0) {
    out.push('');
    out.push('Unknown record types');
    for (const u of h.unknownTypes.slice(0, 5)) out.push(`  ${u.type}${u.version === '' ? '' : ` (Claude Code ${u.version})`}: ${countText(u.count)} ${u.count === 1 ? 'line' : 'lines'}, last seen ${stampText(u.lastSeenAt, h.tz)}`);
  }
  if (h.missingFields.length > 0) {
    out.push('');
    out.push('Missing usage fields');
    const byField = new Map<string, { count: number; versions: string[] }>();
    for (const f of h.missingFields) {
      const e = byField.get(f.field) ?? { count: 0, versions: [] };
      e.count += f.count;
      if (f.version !== '' && !e.versions.includes(f.version)) e.versions.push(f.version);
      byField.set(f.field, e);
    }
    for (const [field, e] of [...byField].slice(0, 5)) {
      out.push(`  ${field}: ${countText(e.count)} ${e.count === 1 ? 'line' : 'lines'}${e.versions.length === 0 ? '' : `, Claude Code ${e.versions.slice(0, 3).join(', ')}${e.versions.length > 3 ? ' and more' : ''}`}`);
    }
  }
  if (h.versions.length > 0) {
    out.push('');
    out.push('Claude Code versions seen (responses)');
    out.push(`  ${h.versions.slice(0, 8).map((v) => `${v.version === '' ? 'not recorded' : v.version} ${countText(v.responses)}`).join(', ')}${h.versions.length > 8 ? `, and ${h.versions.length - 8} more` : ''}`);
  }
  if (h.costCheck.exceptions.length > 0) {
    out.push('');
    out.push('Cost record check, worst differences (session, ours, theirs, difference)');
    for (const e of h.costCheck.exceptions.slice(0, 5)) out.push(`  ${shortId(e.sessionId)} ${countText(e.ours)} ${countText(e.theirs)} ${e.percent >= 0 ? '+' : ''}${e.percent.toFixed(1)}%`);
    out.push(`  ${COST_CHECK_WHY}`);
  }
  out.push('');
  out.push('Exit code 1 means the sync status is degraded or the transcript check warns.');
  return out.map((l) => cap(l, 400)).slice(0, 70);
}

export async function cmdDoctor(args: string[]): Promise<number> {
  if (args.length > 0) {
    console.error(`doctor takes no options, not "${(args[0] ?? '').slice(0, 40)}".`);
    return 1;
  }
  let zone: string;
  try {
    zone = configuredTz();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  let file: string;
  try {
    file = dbPath();
    dataDir();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!existsSync(file) || statSync(file).size === 0) {
    console.log(['Usage Ledger doctor', `There is no archive yet at ${file}.`, 'Run "node src/cli.ts ingest" once, or start the service with "node src/cli.ts serve", then run doctor again.'].join('\n'));
    return 1;
  }
  let db: Db;
  try {
    db = openDb(file);
  } catch (err) {
    console.error(`The archive at ${file} could not be opened: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return 1;
  }
  try {
    db.exec('PRAGMA query_only = ON'); // nothing below may write
    const pending = pendingMigrations(db);
    if (pending.length > 0) {
      console.log(
        ['Usage Ledger doctor', `The archive at ${file} is from an older version (missing schema ${pending.join(', ')}).`, 'Start the service or run "node src/cli.ts ingest" once, which updates it, then run doctor again.'].join('\n'),
      );
      return 1;
    }
    const service = runningService();
    const h = health({ db, tz: zone, now: Date.now }, syncFromRuns(db, service !== null));
    console.log(renderDoctor(h, { now: Date.now(), service, dbFile: file }).join('\n'));
    return needsAttention(h) ? 1 : 0;
  } catch (err) {
    console.error(`doctor could not read the archive: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
