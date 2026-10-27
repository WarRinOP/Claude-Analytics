import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dataDir, home, isInside, realpathNearest, sourceRoot } from './paths.ts';

function forbiddenRoots(): string[] {
  const roots = [
    join(home(), '.claude'),
    join(home(), 'Library', 'Application Support', 'Claude'),
    sourceRoot(),
  ];
  const out = new Set<string>();
  for (const r of roots) {
    out.add(resolve(r));
    out.add(realpathNearest(r));
  }
  return [...out];
}

// Returns the real, absolute form of `p` if the app may write there, else throws.
// Allowed only inside dataDir(). Never allowed under Claude Code's own folders,
// even when dataDir() is misconfigured to overlap them.
export function assertWritablePath(p: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) {
    throw new Error('path guard: invalid path');
  }
  const abs = resolve(p);
  const real = realpathNearest(abs);
  for (const root of forbiddenRoots()) {
    if (isInside(root, abs) || isInside(root, real)) {
      throw new Error('path guard: refusing to write under a Claude Code folder');
    }
  }
  const dataReal = realpathNearest(dataDir());
  if (isInside(dataReal, real)) return real;
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
  const tmpReal = realpathSync(tmpdir());
  if (candidate === tmpReal || !isInside(tmpReal, candidate)) {
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
