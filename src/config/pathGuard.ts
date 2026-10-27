import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, type PlatformPath } from 'node:path';
import { dataDir, home, isInside, isInsideTemp, platformFolders, realpathNearest } from './paths.ts';
import type { Folders } from './platform.ts';

// The folders the app never writes in, as they are named by the folders() contract plus their real forms.
export interface ForbiddenRules {
  roots: string[];
  // Children of `dir` whose name starts with `prefix` (the Microsoft Store install of the Claude desktop app).
  childPrefixes: { dir: string; prefix: string }[];
}

// Pure when `real` is left at its default (it maps a path to its real form; the running guard passes realpathNearest).
export function forbiddenRules(f: Folders, real: (p: string) => string = (p) => p): ForbiddenRules {
  const roots = new Set<string>();
  for (const r of f.forbidden) {
    roots.add(f.path.resolve(r));
    roots.add(real(r));
  }
  const childPrefixes: ForbiddenRules['childPrefixes'] = [];
  if (f.forbiddenChildPrefix !== null) {
    const { dir, prefix } = f.forbiddenChildPrefix;
    for (const d of new Set([f.path.resolve(dir), real(dir)])) childPrefixes.push({ dir: d, prefix });
  }
  return { roots: [...roots], childPrefixes };
}

// Pure. True when `target` lies in a forbidden folder, or in a child of a prefix folder whose name starts with the prefix.
// `p` is the path flavour of the rules (path.win32 compares case insensitively and accepts both separators).
export function isForbidden(p: PlatformPath, rules: ForbiddenRules, target: string): boolean {
  if (rules.roots.some((r) => isInside(r, target, p))) return true;
  for (const { dir, prefix } of rules.childPrefixes) {
    if (!isInside(dir, target, p)) continue;
    const rel = p.relative(dir, target);
    if (rel === '') continue;
    const first = rel.split(/[\\/]/)[0] ?? '';
    if (first.toLowerCase().startsWith(prefix.toLowerCase())) return true;
  }
  return false;
}

// Returns the real, absolute form of `p` if the app may write there, else throws.
// Allowed only inside dataDir(). Never allowed under Claude Code's own folders,
// even when dataDir() is misconfigured to overlap them.
export function assertWritablePath(p: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) {
    throw new Error('path guard: invalid path');
  }
  const f = platformFolders();
  const abs = resolve(p);
  const real = realpathNearest(abs);
  const rules = forbiddenRules(f, realpathNearest);
  if (isForbidden(f.path, rules, abs) || isForbidden(f.path, rules, real)) {
    throw new Error('path guard: refusing to write under a Claude Code folder');
  }
  const dataReal = realpathNearest(dataDir());
  if (isInside(dataReal, real, f.path)) return real;
  throw new Error('path guard: path is outside the app data folder');
}

export function guardedMkdir(p: string): string {
  const real = assertWritablePath(p);
  mkdirSync(real, { recursive: true, mode: 0o700 });
  return real;
}

export function guardedWriteFile(p: string, data: string | Uint8Array): string {
  const real = assertWritablePath(p);
  guardedMkdir(dirname(real));
  writeFileSync(real, data, { mode: 0o600 });
  chmodSync(real, 0o600);
  return real;
}

export const LAUNCH_AGENT_LABEL = 'com.usageledger.agent';
export const LAUNCH_AGENT_FILE = `${LAUNCH_AGENT_LABEL}.plist`;

// The folder that holds the LaunchAgent plist. Normally ~/Library/LaunchAgents. An override is honoured only when it
// resolves strictly inside the real system temp folder (tests), the same rule as LEDGER_DATA_DIR.
export function launchAgentsDir(override?: string): string {
  if (override === undefined || override === '') return join(home(), 'Library', 'LaunchAgents');
  const candidate = realpathNearest(resolve(override));
  if (!isInsideTemp(candidate)) {
    throw new Error('path guard: the LaunchAgents folder override must resolve inside the system temp folder');
  }
  return candidate;
}

// The one plist file the app may write or remove, in its real form.
export function launchAgentPlistPath(dir?: string): string {
  return join(realpathNearest(launchAgentsDir(dir)), LAUNCH_AGENT_FILE);
}

// Returns the real path of `p` when it is exactly com.usageledger.agent.plist in the LaunchAgents folder, else throws.
// Any other file in that folder, and a plist that is a symlink to somewhere else, is refused.
export function assertLaunchAgentPlistPath(p: string, dir?: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) {
    throw new Error('path guard: invalid path');
  }
  const real = realpathNearest(resolve(p));
  if (real !== launchAgentPlistPath(dir)) {
    throw new Error(`path guard: only ${LAUNCH_AGENT_FILE} in the LaunchAgents folder may be written or removed`);
  }
  return real;
}
