import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STANDARD_NODE, buildPlist, chooseNode, isWorktreeOrTempPath, resolveProjectDir, xmlEscape } from '../../src/cli/launchagent.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const mac = process.platform === 'darwin';

let work: string;
let proj: string;
let agents: string;
let data: string;
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-la-')));
  proj = join(work, 'proj');
  agents = join(work, 'LaunchAgents');
  data = join(work, 'data');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'web', 'dist'), { recursive: true });
  writeFileSync(join(proj, 'src', 'cli.ts'), '');
  writeFileSync(join(proj, 'web', 'dist', 'index.html'), '<html></html>');
  mkdirSync(agents);
  mkdirSync(data);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const full: Record<string, string | undefined> = { ...process.env, LEDGER_DATA_DIR: data, CLAUDE_CONFIG_DIR: join(work, 'claude'), LEDGER_TZ: undefined, LEDGER_PORT: undefined, ...env };
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  const r = spawnSync(process.execPath, ['src/cli.ts', ...args], { cwd: ROOT, env: full as NodeJS.ProcessEnv, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const plistFile = (): string => join(agents, 'com.usageledger.agent.plist');
const testArgs = (): string[] => ['--project-dir', proj, '--launch-agents-dir', agents, '--no-launchctl'];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function asJson(file: string): Record<string, unknown> {
  const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe('plist content', () => {
  const base = {
    nodePath: '/usr/local/bin/node',
    cliPath: '/Users/me/Claude Analytics/src/cli.ts',
    projectDir: '/Users/me/Claude Analytics',
    stdoutPath: '/Users/me/Library/Application Support/UsageLedger/logs/launchagent.out.log',
    stderrPath: '/Users/me/Library/Application Support/UsageLedger/logs/launchagent.err.log',
  };

  it('holds the agreed keys and absolute paths', () => {
    const x = buildPlist(base);
    expect(x).toContain('<key>Label</key>\n  <string>com.usageledger.agent</string>');
    expect(x).toMatch(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/local\/bin\/node<\/string>\s*<string>--disable-warning=ExperimentalWarning<\/string>\s*<string>\/Users\/me\/Claude Analytics\/src\/cli\.ts<\/string>\s*<string>serve<\/string>\s*<\/array>/,
    );
    expect(x).toMatch(/<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/Claude Analytics<\/string>/);
    expect(x).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(x).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(x).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
    expect(x).toContain('launchagent.out.log</string>');
    expect(x).toContain('launchagent.err.log</string>');
    expect(x).not.toContain('EnvironmentVariables');
  });

  it('carries LEDGER_RETENTION_DAYS when given, next to LEDGER_TZ', () => {
    const x = buildPlist({ nodePath: '/usr/local/bin/node', cliPath: '/p/src/cli.ts', projectDir: '/p', stdoutPath: '/l/o', stderrPath: '/l/e', tz: 'Asia/Dhaka', retentionDays: 45 });
    expect(x).toMatch(/<key>LEDGER_TZ<\/key>\s*<string>Asia\/Dhaka<\/string>\s*<key>LEDGER_RETENTION_DAYS<\/key>\s*<string>45<\/string>\s*<\/dict>/);
    const y = buildPlist({ nodePath: '/usr/local/bin/node', cliPath: '/p/src/cli.ts', projectDir: '/p', stdoutPath: '/l/o', stderrPath: '/l/e', retentionDays: 60 });
    expect(y).toMatch(/<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>LEDGER_RETENTION_DAYS<\/key>\s*<string>60<\/string>/);
    expect(y).not.toContain('LEDGER_TZ');
  });

  it('adds LEDGER_TZ only when given', () => {
    const x = buildPlist({ ...base, tz: 'Asia/Dhaka' });
    expect(x).toMatch(/<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>LEDGER_TZ<\/key>\s*<string>Asia\/Dhaka<\/string>\s*<\/dict>/);
  });

  it('escapes XML in every value', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    const x = buildPlist({ ...base, projectDir: '/x/R&D <one>', cliPath: '/x/R&D <one>/src/cli.ts' });
    expect(x).toContain('/x/R&amp;D &lt;one&gt;/src/cli.ts');
    expect(x).not.toContain('R&D');
  });

  it.runIf(mac)('is a valid property list (plutil) with the same values after parsing', () => {
    const f = join(work, 'x.plist');
    writeFileSync(f, buildPlist({ ...base, projectDir: '/x/R&D <one>', tz: 'Asia/Dhaka' }));
    expect(spawnSync('plutil', ['-lint', f], { encoding: 'utf8' }).status).toBe(0);
    const j = asJson(f);
    expect(j['WorkingDirectory']).toBe('/x/R&D <one>');
    expect(j['KeepAlive']).toBe(true);
    expect(j['RunAtLoad']).toBe(true);
  });
});

describe('node and project folder choice', () => {
  it('uses /usr/local/bin/node without a warning when that is the running node', () => {
    expect(chooseNode(STANDARD_NODE)).toEqual({ path: STANDARD_NODE, warning: null });
  });

  it('uses the running node with a warning when it differs', () => {
    const r = chooseNode('/opt/other/bin/node', '/usr/local/bin/node');
    expect(r.path).toBe('/opt/other/bin/node');
    expect(r.warning).toContain('/opt/other/bin/node');
  });

  it('refuses a temp folder unless --project-dir is given', () => {
    expect(isWorktreeOrTempPath('/Users/me/Claude Analytics')).toBe(false);
    expect(isWorktreeOrTempPath(join(work, 'proj'))).toBe(true);
    const moduleDir = join(work, 'copy', 'src', 'cli');
    const r = resolveProjectDir(undefined, moduleDir);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/temp folder/);
    expect((r as { error: string }).error).toContain('--project-dir');
    expect(resolveProjectDir(undefined, join(proj, 'src', 'cli'))).toHaveProperty('error');
  });

  it('accepts --project-dir for a real project folder only', () => {
    expect(resolveProjectDir(proj, '/nowhere')).toEqual({ dir: proj });
    expect(resolveProjectDir(join(work, 'missing'), '/nowhere')).toHaveProperty('error');
    expect(resolveProjectDir(agents, '/nowhere')).toHaveProperty('error');
  });
});

describe('install', () => {
  it('--dry-run prints the plist and the launchctl commands and changes nothing', () => {
    const r = run(['install', '--dry-run', '--project-dir', proj, '--launch-agents-dir', agents]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Dry run: nothing was changed.');
    expect(r.out).toContain('<string>com.usageledger.agent</string>');
    expect(r.out).toContain(join(proj, 'src', 'cli.ts'));
    expect(r.out).toMatch(/launchctl bootout gui\/\d+\/com\.usageledger\.agent/);
    expect(r.out).toMatch(new RegExp(`launchctl bootstrap gui/\\d+ ${escapeRe(plistFile())}`));
    expect(r.out).toContain('/api/health');
    expect(readdirSync(agents)).toEqual([]);
    expect(readdirSync(data)).toEqual([]);
  });

  it('--dry-run against the real folder only prints the real path', () => {
    const r = run(['install', '--dry-run', '--project-dir', proj]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(join(realpathSync(join(homedir(), 'Library')), 'LaunchAgents', 'com.usageledger.agent.plist'));
    expect(readdirSync(data)).toEqual([]);
  });

  it('writes the plist with mode 644 and the log folder, without launchctl', () => {
    const r = run(['install', ...testArgs()]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('launchctl was skipped');
    expect(statSync(plistFile()).mode & 0o777).toBe(0o644);
    expect(existsSync(join(data, 'logs'))).toBe(true);
    const text = readFileSync(plistFile(), 'utf8');
    expect(text).toContain(`<string>${join(proj, 'src', 'cli.ts')}</string>`);
    expect(text).toContain(`<string>${join(data, 'logs', 'launchagent.out.log')}</string>`);
    expect(text).not.toContain('LEDGER_TZ');
    if (mac) {
      const j = asJson(plistFile());
      expect(j['Label']).toBe('com.usageledger.agent');
      const args = j['ProgramArguments'] as string[];
      expect(args.slice(1)).toEqual(['--disable-warning=ExperimentalWarning', join(proj, 'src', 'cli.ts'), 'serve']);
      expect(args[0]?.startsWith('/')).toBe(true);
      expect(j['ProcessType']).toBe('Background');
    }
  });

  it('carries LEDGER_TZ when it is set, replaces the file on a second install, and leaves other plists alone', () => {
    writeFileSync(join(agents, 'other.plist'), 'keep me');
    expect(run(['install', ...testArgs()]).code).toBe(0);
    expect(run(['install', ...testArgs()], { LEDGER_TZ: 'Asia/Dhaka' }).code).toBe(0);
    expect(readFileSync(plistFile(), 'utf8')).toContain('<string>Asia/Dhaka</string>');
    expect(readFileSync(join(agents, 'other.plist'), 'utf8')).toBe('keep me');
    expect(run(['install', ...testArgs()], { LEDGER_TZ: 'Not/AZone' }).code).toBe(1);
  });

  it('refuses with a plain sentence when the web build is missing', () => {
    rmSync(join(proj, 'web', 'dist'), { recursive: true });
    for (const extra of [[], ['--dry-run']]) {
      const r = run(['install', ...testArgs(), ...extra]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('pnpm build:web first');
    }
    expect(readdirSync(agents)).toEqual([]);
  });

  it('refuses a folder that is not the project, an unknown option and a folder override without --no-launchctl', () => {
    expect(run(['install', '--dry-run', '--project-dir', work]).err).toContain('src/cli.ts is missing');
    expect(run(['install', '--bogus']).err).toContain('Unknown option');
    const r = run(['install', '--project-dir', proj, '--launch-agents-dir', agents]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--no-launchctl');
    expect(readdirSync(agents)).toEqual([]);
  });

  it('refuses a LaunchAgents override outside the temp folder', () => {
    const r = run(['install', '--dry-run', '--project-dir', proj, '--launch-agents-dir', homedir()]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('temp folder');
  });
});

describe('uninstall', () => {
  it('--dry-run says what it would do and changes nothing', () => {
    run(['install', ...testArgs()]);
    const r = run(['uninstall', '--dry-run', '--launch-agents-dir', agents, '--delete-data', '--yes']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/launchctl bootout gui\/\d+\/com\.usageledger\.agent/);
    expect(r.out).toContain(plistFile());
    expect(r.out).toContain(`delete the archive folder ${data}`);
    expect(existsSync(plistFile())).toBe(true);
    expect(existsSync(data)).toBe(true);
    const keep = run(['uninstall', '--dry-run']);
    expect(keep.out).toContain(`keep the archive in ${data}`);
  });

  it('removes only its plist and keeps the archive by default', () => {
    writeFileSync(join(agents, 'other.plist'), 'keep me');
    writeFileSync(join(data, 'ledger.db'), 'db');
    run(['install', ...testArgs()]);
    const r = run(['uninstall', '--no-launchctl', '--launch-agents-dir', agents]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(plistFile())).toBe(false);
    expect(readdirSync(agents)).toEqual(['other.plist']);
    expect(readFileSync(join(data, 'ledger.db'), 'utf8')).toBe('db');
    expect(r.out).toContain('was kept');
    const again = run(['uninstall', '--no-launchctl', '--launch-agents-dir', agents]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('nothing to remove');
  });

  it('--delete-data needs --yes', () => {
    writeFileSync(join(data, 'ledger.db'), 'db');
    run(['install', ...testArgs()]);
    const r = run(['uninstall', '--no-launchctl', '--launch-agents-dir', agents, '--delete-data']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--yes');
    expect(existsSync(plistFile())).toBe(true);
    expect(existsSync(join(data, 'ledger.db'))).toBe(true);
    expect(run(['uninstall', '--yes']).code).toBe(1);
  });

  it('--delete-data --yes removes the data folder and nothing beside it', () => {
    writeFileSync(join(data, 'ledger.db'), 'db');
    mkdirSync(join(data, 'logs'));
    const claude = join(work, 'claude', 'projects');
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, 'a.jsonl'), 'transcript');
    writeFileSync(join(work, 'sibling.txt'), 'keep');
    run(['install', ...testArgs()]);
    const r = run(['uninstall', '--no-launchctl', '--launch-agents-dir', agents, '--delete-data', '--yes']);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(plistFile())).toBe(false);
    expect(readFileSync(join(claude, 'a.jsonl'), 'utf8')).toBe('transcript');
    expect(readFileSync(join(work, 'sibling.txt'), 'utf8')).toBe('keep');
    expect(existsSync(proj)).toBe(true);
  });

  it('refuses a data folder override outside the temp folder', () => {
    const r = run(['uninstall', '--dry-run'], { LEDGER_DATA_DIR: homedir() });
    expect(r.code).toBe(1);
    expect(r.err).toContain('LEDGER_DATA_DIR');
  });
});
