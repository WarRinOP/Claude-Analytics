import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { dbPath, sourceRoot } from './config/paths.ts';
import { costAgreement, costStateCrossCheck, grandTotals, totalsPerModel, type VariantResult } from './ingest/crosscheck.ts';
import { appendLog, logPass } from './config/log.ts';
import { port as configuredPort, retentionDays as configuredRetention, tz as configuredTz } from './config/settings.ts';
import { runIngest, type RunSummary } from './ingest/ingest.ts';
import { acquireLock, LockHeldError } from './ingest/lock.ts';
import { createSync, type Sync, type SyncStatus } from './ingest/scheduler.ts';
import { PRICE_TABLE_DATE } from './metrics/prices.ts';
import { ensureRollups } from './metrics/rollups.ts';
import { formatClock } from './metrics/time.ts';
import { startServer, type RunningServer } from './server/http.ts';
import { handlePass } from './server/live.ts';
import { createSseHub } from './server/sse.ts';
import { openAndMigrate } from './store/migrate.ts';
import { cmdDoctor } from './cli/doctor.ts';
import { cmdExport } from './cli/export.ts';
import { cmdInstall, cmdUninstall } from './cli/launchagent.ts';

const COMMANDS: Array<[string, string]> = [
  ['serve', 'start the local dashboard and background sync (--root <dir> adds a folder; LEDGER_PORT and LEDGER_TZ change the port and time zone)'],
  ['watch', 'keep the archive current: watch the transcript folder and poll every 60 seconds (--root <dir> adds a folder)'],
  ['ingest', 'read new transcript lines into the archive (--full rereads everything, --root <dir> adds a folder)'],
  ['verify', 'check the archive against the source files'],
  ['doctor', 'print diagnostics about paths, data and versions'],
  ['export', 'write the archive to a file you choose'],
  ['install', 'start the ledger at login with a LaunchAgent'],
  ['uninstall', 'remove the LaunchAgent (the archive is kept unless you ask)'],
];

function help(): string {
  const lines = ['Usage Ledger: Claude Code usage analytics for this Mac', '', 'Usage: node src/cli.ts <command>', '', 'Commands:'];
  for (const [name, desc] of COMMANDS) lines.push(`  ${name.padEnd(15)}${desc}`);
  lines.push('  --help         show this list');
  return lines.join('\n');
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;

function parseIngestArgs(args: string[], command = 'ingest'): { full: boolean; roots: string[] } | string {
  let full = false;
  const roots: string[] = [sourceRoot()];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--full' && command === 'ingest') full = true;
    else if (a === '--root' || a.startsWith('--root=')) {
      const value = a === '--root' ? args[++i] : a.slice('--root='.length);
      if (value === undefined || value === '') return '--root needs a folder.';
      const abs = resolve(value);
      let ok: boolean;
      try {
        ok = statSync(abs).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) return `The folder given to --root does not exist: ${abs}`;
      roots.push(abs);
    } else return `Unknown option for ${command}: ${a.slice(0, 40)}`;
  }
  return { full, roots };
}

async function cmdIngest(args: string[]): Promise<number> {
  const parsed = parseIngestArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }
  let release: () => void;
  try {
    release = acquireLock();
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const { db } = openAndMigrate(dbPath());
  try {
    const sum = await runIngest(db, { roots: parsed.roots, full: parsed.full, trigger: parsed.full ? 'cli-full' : 'cli' });
    const t = grandTotals(db);
    const kinds = Object.entries(sum.factsByKind)
      .sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([k, n]) => `${k} ${fmt(n)}`)
      .join(', ');
    console.log(
      [
        `ingest ${parsed.full ? '--full ' : ''}done in ${(sum.durationMs / 1000).toFixed(1)} s (run ${sum.runId}, ${parsed.roots.length} root${parsed.roots.length === 1 ? '' : 's'})`,
        `files: ${fmt(sum.filesScanned)} scanned, ${fmt(sum.filesChanged)} changed`,
        `lines read: ${fmt(sum.linesRead)}, errors: ${fmt(sum.errors)}`,
        `lines by kind: ${kinds === '' ? 'none' : kinds}`,
        `usage events written (after folding): ${fmt(sum.eventsUpserted)}`,
        `usage_events rows: ${fmt(t.rows)}`,
        `input: ${fmt(t.input)}`,
        `output: ${fmt(t.output)}`,
        `cache read: ${fmt(t.cacheRead)}`,
        `cache write: ${fmt(t.cacheWrite)}`,
        `sum: ${fmt(t.sum)}`,
      ].join('\n'),
    );
    return 0;
  } finally {
    db.close();
    release();
  }
}

function passText(s: RunSummary, zone: string): string {
  const parts = [`${s.filesChanged} of ${s.filesScanned} files changed`, `${fmt(s.linesRead)} lines`, `${fmt(s.eventsUpserted)} events`];
  if (s.filesMarkedDeleted > 0) parts.push(`${s.filesMarkedDeleted} files gone`);
  if (s.errors > 0) parts.push(`${s.errors} errors`);
  return `${formatClock(Date.now(), zone)} ${s.trigger}: ${parts.join(', ')} (${s.durationMs} ms)`;
}

function safeLog(text: string): void {
  try {
    appendLog(text);
  } catch {
    // logging must never stop the sync
  }
}

// The configured time zone, or a printed message and null when LEDGER_TZ is not a zone.
function zoneOrComplain(): string | null {
  try {
    return configuredTz();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return null;
  }
}

function reportSyncProblem(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  safeLog(`error ${msg}`);
  console.error(`sync problem: ${msg.slice(0, 200)}`);
}

async function cmdWatch(args: string[]): Promise<number> {
  const parsed = parseIngestArgs(args, 'watch');
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }
  const zone = zoneOrComplain();
  if (zone === null) return 1;
  let release: () => void;
  try {
    release = acquireLock();
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const { db } = openAndMigrate(dbPath());
  const sync = createSync({
    db,
    roots: parsed.roots,
    onPass: (s) => {
      try {
        logPass(s);
      } catch {
        // see safeLog
      }
      // The startup pass always reports; later passes only when something changed.
      if (s.trigger === 'startup' || s.filesChanged > 0 || s.filesMarkedDeleted > 0 || s.errors > 0) console.log(passText(s, zone));
    },
    onError: reportSyncProblem,
  });
  const stopped = new Promise<void>((resolveStop) => {
    const onSignal = (): void => resolveStop();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
  console.log(`watching ${parsed.roots.length} folder${parsed.roots.length === 1 ? '' : 's'}, first: ${parsed.roots[0]}`);
  safeLog(`start roots=${parsed.roots.length}`);
  try {
    // Signals are heard while the startup pass runs; stop() then waits for that pass to finish.
    const started = sync.start();
    await Promise.race([stopped, started.then(() => stopped)]);
    await sync.stop();
    await started;
  } finally {
    db.close();
    release();
  }
  safeLog('stop');
  console.log('stopped');
  return 0;
}

const IDLE_STATUS: SyncStatus = { running: false, lastPassAt: null, lastSuccessAt: null, lastError: null, watcherAlive: false };

async function cmdServe(args: string[]): Promise<number> {
  const parsed = parseIngestArgs(args, 'serve');
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }
  const zone = zoneOrComplain();
  if (zone === null) return 1;
  let portNumber: number;
  try {
    portNumber = configuredPort();
    configuredRetention(); // refuse a bad LEDGER_RETENTION_DAYS now, not on the first request
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  let release: () => void;
  try {
    release = acquireLock();
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const { db } = openAndMigrate(dbPath());
  let server: RunningServer | null = null;
  let sync: Sync | null = null;
  const stopped = new Promise<void>((resolveStop) => {
    const onSignal = (): void => resolveStop();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
  try {
    if (ensureRollups(db, zone)) safeLog(`rollups rebuilt tz=${zone}`);
    const hub = createSseHub();
    try {
      server = await startServer({ db, tz: zone, port: portNumber, hub, syncStatus: () => sync?.status() ?? IDLE_STATUS });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    const running = server;
    sync = createSync({
      db,
      roots: parsed.roots,
      onPass: (s) => {
        try {
          logPass(s);
        } catch {
          // see safeLog
        }
        // Rollups follow every pass that changed something; open dashboards are told which local days to refetch.
        handlePass(db, zone, running.hub, s);
        if (s.trigger === 'startup' || s.filesChanged > 0 || s.filesMarkedDeleted > 0 || s.errors > 0) console.log(passText(s, zone));
      },
      onError: reportSyncProblem,
    });
    console.log(`Dashboard: ${server.url}`);
    console.log(`watching ${parsed.roots.length} folder${parsed.roots.length === 1 ? '' : 's'}, first: ${parsed.roots[0]} (times in ${zone})`);
    safeLog(`start serve port=${server.port} tz=${zone} roots=${parsed.roots.length}`);
    const started = sync.start();
    await Promise.race([stopped, started.then(() => stopped)]);
    await sync.stop();
    await started;
  } finally {
    if (server !== null) await server.close();
    db.close();
    release();
  }
  safeLog('stop serve');
  console.log('stopped');
  return 0;
}

function variantLine(name: string, v: VariantResult): string {
  return `${name}: ${fmt(v.agree)} of ${fmt(v.compared)} sessions within 1 percent (${pct(v.rate)})`;
}

function cmdVerify(): number {
  const { db } = openAndMigrate(dbPath());
  try {
    const out: string[] = [];
    const models = totalsPerModel(db);
    out.push('Totals per model (rows, input, output, cache read, cache write):');
    for (const m of models.slice(0, 8)) {
      out.push(`  ${m.model}: ${fmt(m.rows)}, ${fmt(m.input)}, ${fmt(m.output)}, ${fmt(m.cacheRead)}, ${fmt(m.cacheWrite)}`);
    }
    if (models.length > 8) out.push(`  and ${models.length - 8} more models`);
    const x = costStateCrossCheck(db);
    out.push(
      `cost-state cross check: ${fmt(x.snapshots)} sessions with a snapshot, ${fmt(x.excludedZero)} excluded (total 0), ${fmt(x.excludedNoCommon)} excluded (no common model)`,
    );
    out.push(variantLine('Variant A, all events of the session', x.a));
    out.push(variantLine('Variant B, main file events only', x.b));
    const best = x.better === 'A' ? x.a : x.b;
    out.push(`Worst exceptions for variant ${x.better} (session, ours, theirs, percent):`);
    if (best.worst.length === 0) out.push('  none');
    for (const e of best.worst.slice(0, 5)) out.push(`  ${e.sessionId} ${fmt(e.ours)} ${fmt(e.theirs)} ${e.percent.toFixed(1)}%`);
    const c = costAgreement(db);
    out.push(
      `cost agreement (API price equivalent, table of ${PRICE_TABLE_DATE}): ${fmt(c.sessions)} sessions have tokens equal to their last snapshot exactly; ${fmt(c.pairs)} session models compared`,
    );
    out.push(`  within $0.01 of its costUSD: ${fmt(c.within)}`);
    out.push(`  differs only by the corrected Sonnet 5.5 cache read rate (older Claude Code versions): ${fmt(c.explained)}`);
    out.push(`  other: ${fmt(c.other)}`);
    if (c.other > 0) out.push(`Worst "other" cost differences (session, model, ours, theirs, difference in USD):`);
    for (const e of c.worst) out.push(`  ${e.sessionId} ${e.model} ${e.ours.toFixed(4)} ${e.theirs.toFixed(4)} ${e.diff >= 0 ? '+' : ''}${e.diff.toFixed(4)}`);
    console.log(out.slice(0, 30).join('\n'));
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    console.log(help());
    return 0;
  }
  const known = COMMANDS.map(([n]) => n.split(' ')[0]);
  if (!known.includes(first)) {
    console.error(`Unknown command: ${first.slice(0, 40)}`);
    console.error('Run with --help to see the commands.');
    return 1;
  }
  if (first === 'ingest') return cmdIngest(argv.slice(1));
  if (first === 'watch') return cmdWatch(argv.slice(1));
  if (first === 'serve') return cmdServe(argv.slice(1));
  if (first === 'verify') return cmdVerify();
  if (first === 'doctor') return cmdDoctor(argv.slice(1));
  if (first === 'export') return cmdExport(argv.slice(1));
  if (first === 'install') return cmdInstall(argv.slice(1));
  return cmdUninstall(argv.slice(1));
}

process.exitCode = await main(process.argv.slice(2));
