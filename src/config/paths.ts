import { lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// True when `target` is `base` itself or lies inside it. Compares path segments, never string prefixes.
export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + sep);
}

// Resolves symlinks of the nearest existing ancestor and re-appends the missing tail.
// A dangling symlink is refused (throws) because its real target cannot be known.
export function realpathNearest(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      let exists = true;
      try {
        lstatSync(cur);
      } catch {
        exists = false;
      }
      if (exists) throw new Error('path guard: dangling symlink in path', { cause: err });
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

export function home(): string {
  return homedir();
}

// Where Claude Code keeps transcripts. Read only for this app.
export function sourceRoot(): string {
  const cfg = process.env['CLAUDE_CONFIG_DIR'];
  if (cfg !== undefined && cfg !== '') return join(resolve(cfg), 'projects');
  return join(home(), '.claude', 'projects');
}

export function defaultDataDir(): string {
  return join(home(), 'Library', 'Application Support', 'UsageLedger');
}

// App data folder. LEDGER_DATA_DIR is honoured only inside the real path of os.tmpdir() (tests).
export function dataDir(): string {
  const override = process.env['LEDGER_DATA_DIR'];
  if (override === undefined || override === '') return defaultDataDir();
  const candidate = realpathNearest(resolve(override));
  const tmpReal = realpathSync(tmpdir());
  if (candidate === tmpReal || !isInside(tmpReal, candidate)) {
    throw new Error('LEDGER_DATA_DIR must resolve inside the system temp folder');
  }
  return candidate;
}

export function dbPath(): string {
  return join(dataDir(), 'ledger.db');
}

export function logsDir(): string {
  return join(dataDir(), 'logs');
}
