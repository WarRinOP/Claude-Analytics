// Single writer lock for the CLI ingest. A file `ingest.lock` in the app data
// folder holds the pid of the owner. A lock whose pid is no longer alive is stale and gets replaced.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../config/paths.ts';
import { assertWritablePath, guardedMkdir } from '../config/pathGuard.ts';

export class LockHeldError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`Another ingest is already running (process ${pid}). Wait for it to finish and try again.`);
    this.name = 'LockHeldError';
    this.pid = pid;
  }
}

export function lockPath(): string {
  return assertWritablePath(join(dataDir(), 'ingest.lock'));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(path: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Takes the lock or throws LockHeldError. Returns a function that releases it (only if it is still ours).
export function acquireLock(pid: number = process.pid): () => void {
  guardedMkdir(dataDir());
  const path = lockPath();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, `${pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => {
        if (readPid(path) === pid) {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = readPid(path);
    if (owner !== null && owner !== pid && isAlive(owner)) throw new LockHeldError(owner);
    // Stale (dead owner, unreadable content, or our own pid left by an earlier crash): replace it.
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new Error('Could not take the ingest lock. Try again.');
}
