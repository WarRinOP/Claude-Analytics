// Append only log in the app data folder. One line per pass, counts and paths only, never content.
// Rotates at 5 MB and keeps 3 files: ledger.log, ledger.log.1, ledger.log.2. Every path goes through the path guard.
import { appendFileSync, chmodSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary } from '../ingest/ingest.ts';
import { logsDir } from './paths.ts';
import { assertWritablePath, guardedMkdir } from './pathGuard.ts';

export interface LogOptions {
  maxBytes?: number; // default 5 MB
  keep?: number; // files kept including the current one, default 3
  now?: () => number;
}

const DEFAULT_MAX = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

export function logFilePath(): string {
  return assertWritablePath(join(logsDir(), 'ledger.log'));
}

function rotate(base: string, keep: number): void {
  const name = (i: number): string => (i === 0 ? base : `${base}.${i}`);
  const drop = (p: string): void => {
    try {
      unlinkSync(assertWritablePath(p));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };
  drop(name(keep - 1));
  for (let i = keep - 2; i >= 0; i--) {
    try {
      renameSync(assertWritablePath(name(i)), assertWritablePath(name(i + 1)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

// Writes one line. Newlines in `text` are replaced, so a line stays a line.
export function appendLog(text: string, opts: LogOptions = {}): void {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX;
  const keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
  const at = new Date((opts.now ?? Date.now)()).toISOString();
  const line = `${at} ${text.replace(/[\r\n]+/g, ' ')}\n`;
  guardedMkdir(logsDir());
  const file = logFilePath();
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    // first line
  }
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate(file, keep);
  appendFileSync(file, line, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function passLine(s: RunSummary): string {
  return [
    'pass',
    `trigger=${s.trigger}`,
    `run=${s.runId}`,
    `scanned=${s.filesScanned}`,
    `changed=${s.filesChanged}`,
    `lines=${s.linesRead}`,
    `events=${s.eventsUpserted}`,
    `deleted=${s.filesMarkedDeleted}`,
    `errors=${s.errors}`,
    `ms=${s.durationMs}`,
  ].join(' ');
}

export function logPass(s: RunSummary, opts: LogOptions = {}): void {
  appendLog(passLine(s), opts);
}
