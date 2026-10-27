import { lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, type PlatformPath } from 'node:path';
import * as nodePath from 'node:path';
import { currentOs, folders, type Folders } from './platform.ts';

// The folders of the system this process runs on (macOS or Windows). Every folder the app uses comes from here.
export function platformFolders(): Folders {
  return folders({ os: currentOs(), home: homedir(), env: process.env });
}

// True when `target` is `base` itself or lies inside it. Compares path segments, never string prefixes.
// `p` is the path flavour: the running system's by default; path.win32 compares case insensitively and accepts both separators.
export function isInside(base: string, target: string, p: PlatformPath = nodePath): boolean {
  const rel = p.relative(base, target);
  if (rel === '') return true;
  if (p.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + p.sep);
}

// True when `target` lies inside `base` but is not `base` itself.
export function isStrictlyInside(base: string, target: string, p: PlatformPath = nodePath): boolean {
  return p.relative(base, target) !== '' && isInside(base, target, p);
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
  return platformFolders().sourceRoot;
}

export function defaultDataDir(): string {
  return platformFolders().dataDir;
}

// The real forms of the system temp folder: the JavaScript one and the native one. They differ on Windows when the temp path
// uses 8.3 short names (C:\Users\RUNNER~1\...), which only the native call expands.
export function tempRoots(): string[] {
  const t = tmpdir();
  return [...new Set([realpathSync(t), realpathSync.native(t)])];
}

// True when `candidate` (a real path) lies strictly inside the system temp folder, in either of its real forms.
export function isInsideTemp(candidate: string, p: PlatformPath = platformFolders().path, roots: string[] = tempRoots()): boolean {
  return roots.some((root) => isStrictlyInside(root, candidate, p));
}

// App data folder. LEDGER_DATA_DIR is honoured only inside the real path of os.tmpdir() (tests).
export function dataDir(): string {
  const override = process.env['LEDGER_DATA_DIR'];
  if (override === undefined || override === '') return defaultDataDir();
  const candidate = realpathNearest(resolve(override));
  if (!isInsideTemp(candidate)) {
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
