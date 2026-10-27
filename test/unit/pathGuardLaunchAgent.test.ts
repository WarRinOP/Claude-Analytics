import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAUNCH_AGENT_FILE, assertLaunchAgentPlistPath, launchAgentPlistPath, launchAgentsDir } from '../../src/config/pathGuard.ts';
import { removeTemp } from './helpers.ts';

// ~/Library exists only on macOS. Windows has its own tests for its start at login code.
const mac = process.platform === 'darwin';

let base: string;
let agents: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-la-guard-')));
  agents = join(base, 'LaunchAgents');
  mkdirSync(agents);
});
afterEach(() => removeTemp(base));

describe('assertLaunchAgentPlistPath', () => {
  it.runIf(mac)('names exactly one file in the real LaunchAgents folder by default', () => {
    expect(launchAgentsDir()).toBe(join(homedir(), 'Library', 'LaunchAgents'));
    expect(LAUNCH_AGENT_FILE).toBe('com.usageledger.agent.plist');
    const want = join(realpathSync(join(homedir(), 'Library')), 'LaunchAgents', LAUNCH_AGENT_FILE);
    expect(launchAgentPlistPath()).toBe(want);
    expect(assertLaunchAgentPlistPath(join(homedir(), 'Library', 'LaunchAgents', LAUNCH_AGENT_FILE))).toBe(want);
  });

  it('allows the plist in the override folder', () => {
    const p = join(agents, LAUNCH_AGENT_FILE);
    expect(assertLaunchAgentPlistPath(p, agents)).toBe(p);
    writeFileSync(p, 'x');
    expect(assertLaunchAgentPlistPath(p, agents)).toBe(p);
  });

  it('refuses any other path in the real LaunchAgents folder', () => {
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    for (const name of ['other.plist', 'com.usageledger.agent.plist.bak', 'com.usageledger.agent.PLIST', 'com.apple.thing.plist']) {
      expect(() => assertLaunchAgentPlistPath(join(dir, name))).toThrow(/path guard/);
    }
    expect(() => assertLaunchAgentPlistPath(dir)).toThrow(/path guard/);
    expect(() => assertLaunchAgentPlistPath(join(dir, 'sub', LAUNCH_AGENT_FILE))).toThrow(/path guard/);
    expect(() => assertLaunchAgentPlistPath(join(dir, '..', LAUNCH_AGENT_FILE))).toThrow(/path guard/);
  });

  it('refuses other files, folders, parents and tricks in the override folder', () => {
    const bad = [
      join(agents, 'other.plist'),
      join(agents, `${LAUNCH_AGENT_FILE}.bak`),
      join(agents, 'sub', LAUNCH_AGENT_FILE),
      join(agents, '..', LAUNCH_AGENT_FILE),
      join(agents, 'x', '..', 'x', '..', '..', LAUNCH_AGENT_FILE),
      agents,
      join(base, LAUNCH_AGENT_FILE),
      join(homedir(), '.claude', LAUNCH_AGENT_FILE),
      join(homedir(), 'Library', 'Application Support', 'Claude', LAUNCH_AGENT_FILE),
      '',
      `${agents}/a\0b`,
    ];
    for (const p of bad) expect(() => assertLaunchAgentPlistPath(p, agents), p).toThrow(/path guard/);
  });

  it('refuses the plist when it is a symlink to another file or a dangling link', () => {
    const target = join(base, 'elsewhere.plist');
    writeFileSync(target, 'x');
    const link = join(agents, LAUNCH_AGENT_FILE);
    symlinkSync(target, link);
    expect(() => assertLaunchAgentPlistPath(link, agents)).toThrow(/path guard/);
    rmSync(link);
    symlinkSync(join(base, 'missing.plist'), link);
    expect(() => assertLaunchAgentPlistPath(link, agents)).toThrow(/path guard/);
  });

  it('follows a symlinked folder to the same real place and refuses another folder', () => {
    const alias = join(base, 'alias');
    symlinkSync(agents, alias);
    expect(assertLaunchAgentPlistPath(join(alias, LAUNCH_AGENT_FILE), agents)).toBe(join(agents, LAUNCH_AGENT_FILE));
    const other = join(base, 'other');
    mkdirSync(other);
    expect(() => assertLaunchAgentPlistPath(join(other, LAUNCH_AGENT_FILE), agents)).toThrow(/path guard/);
  });

  it('honours a folder override only inside the system temp folder', () => {
    expect(() => launchAgentsDir(homedir())).toThrow(/temp folder/);
    expect(() => launchAgentsDir(join(homedir(), 'Library', 'LaunchAgents'))).toThrow(/temp folder/);
    expect(() => launchAgentsDir(realpathSync(tmpdir()))).toThrow(/temp folder/);
    expect(launchAgentsDir(agents)).toBe(agents);
  });
});
