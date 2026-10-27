import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLauncher, cmdWinInstall, cmdWinUninstall, type Deps } from '../../src/cli/winstartup.ts';
import { removeTemp } from '../unit/helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..');

let work: string;
let proj: string;
let data: string;
const saved = new Map<string, string | undefined>();
const KEYS = ['LEDGER_DATA_DIR', 'LEDGER_TZ', 'LEDGER_RETENTION_DAYS', 'LEDGER_PORT'];
let out: string[];
let err: string[];

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-ws-')));
  proj = join(work, 'proj');
  data = join(work, 'data');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'web', 'dist'), { recursive: true });
  writeFileSync(join(proj, 'src', 'cli.ts'), '');
  writeFileSync(join(proj, 'web', 'dist', 'index.html'), '<html></html>');
  mkdirSync(data);
  for (const k of KEYS) saved.set(k, process.env[k]);
  for (const k of KEYS) delete process.env[k];
  process.env['LEDGER_DATA_DIR'] = data;
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeTemp(work);
});

const files = (): string[] => readdirSync(data).sort();
const text = (): string => out.join('\n');

interface Fake extends Deps {
  calls: string[];
}

// Deps that never touch Windows: commands are recorded, answers come from `answer`, and the dashboard answers per `health`.
function fake(over: { answer?: (cmd: string) => { code: number; text: string } | undefined; health?: () => boolean; wscript?: boolean } = {}): Fake {
  const calls: string[] = [];
  return {
    calls,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    userName: () => 'ana',
    exists: () => over.wscript ?? true,
    run: (program, args) => {
      const cmd = [program, ...args].join(' ');
      calls.push(cmd);
      return over.answer?.(cmd) ?? { code: 0, text: '' };
    },
    health: async () => over.health?.() ?? false,
    sleep: async () => undefined,
    now: () => new Date(2026, 9, 28, 9, 5, 3),
  };
}

describe('install and uninstall with --no-schtasks', () => {
  it('writes exactly the two files and runs no command', async () => {
    const d = fake();
    const code = await cmdWinInstall(['--project-dir', proj, '--no-schtasks'], d);
    expect(code, err.join('\n')).toBe(0);
    expect(files()).toEqual(['launcher.js', 'task.xml']);
    expect(d.calls).toEqual([]);
    expect(text()).toContain('schtasks was skipped');
    const xml = readFileSync(join(data, 'task.xml'));
    expect([xml[0], xml[1]]).toEqual([0xff, 0xfe]);
    const task = new TextDecoder('utf-16le', { ignoreBOM: true }).decode(xml.subarray(2));
    expect(task).toContain('<Command>%SystemRoot%\\System32\\wscript.exe</Command>');
    expect(task).toContain(`launcher.js&quot;</Arguments>`);
    expect(task).toContain(`<WorkingDirectory>${proj}</WorkingDirectory>`);
    const launcher = readFileSync(join(data, 'launcher.js'), 'utf8');
    expect(launcher).toContain(`var cli = ${JSON.stringify(join(proj, 'src', 'cli.ts'))};`);
    expect(launcher).toContain('serve');
    expect(launcher).not.toContain('LEDGER_');
  });

  it('writes a launcher that a JavaScript parser accepts, with the settings that were set', async () => {
    process.env['LEDGER_TZ'] = 'Asia/Dhaka';
    process.env['LEDGER_RETENTION_DAYS'] = '45';
    const code = await cmdWinInstall(['--project-dir', proj, '--no-schtasks'], fake());
    expect(code, err.join('\n')).toBe(0);
    const launcher = readFileSync(join(data, 'launcher.js'), 'utf8');
    expect(launcher).toContain('env("LEDGER_TZ") = "Asia/Dhaka";');
    expect(launcher).toContain('env("LEDGER_RETENTION_DAYS") = "45";');
    const check = join(work, 'launcher-check.cjs');
    copyFileSync(join(data, 'launcher.js'), check);
    const r = spawnSync(process.execPath, ['--check', check], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('uses the PowerShell fallback and says so when wscript.exe is missing', async () => {
    const code = await cmdWinInstall(['--project-dir', proj, '--no-schtasks'], fake({ wscript: false }));
    expect(code).toBe(0);
    expect(text()).toContain('A small window may flash');
    const xml = readFileSync(join(data, 'task.xml'));
    expect(new TextDecoder('utf-16le', { ignoreBOM: true }).decode(xml.subarray(2))).toContain('powershell.exe</Command>');
  });

  it('removes exactly those two files and keeps the archive', async () => {
    await cmdWinInstall(['--project-dir', proj, '--no-schtasks'], fake());
    writeFileSync(join(data, 'ledger.db'), 'archive');
    mkdirSync(join(data, 'logs'));
    out.length = 0;
    const d = fake();
    const code = await cmdWinUninstall(['--no-schtasks'], d);
    expect(code, err.join('\n')).toBe(0);
    expect(files()).toEqual(['ledger.db', 'logs']);
    expect(d.calls).toEqual([]);
    expect(text()).toContain('was kept');
    // a second uninstall has nothing to remove and is not an error
    out.length = 0;
    expect(await cmdWinUninstall(['--no-schtasks'], d)).toBe(0);
    expect(text()).toContain('nothing to remove');
    expect(files()).toEqual(['ledger.db', 'logs']);
  });

  it('deletes the data folder only with --delete-data --yes', async () => {
    writeFileSync(join(data, 'ledger.db'), 'archive');
    expect(await cmdWinUninstall(['--no-schtasks', '--delete-data'], fake())).toBe(1);
    expect(err.join('\n')).toContain('Add --yes');
    expect(await cmdWinUninstall(['--no-schtasks', '--yes'], fake())).toBe(1);
    expect(err.join('\n')).toContain('--yes only goes with --delete-data');
    expect(existsSync(join(data, 'ledger.db'))).toBe(true);
    expect(await cmdWinUninstall(['--no-schtasks', '--delete-data', '--yes'], fake())).toBe(0);
    expect(existsSync(data)).toBe(false);
    expect(text()).toContain('Deleted the archive folder');
  });

  it('refuses unknown flags, including the macOS ones', async () => {
    expect(await cmdWinInstall(['--no-launchctl'], fake())).toBe(1);
    expect(err.join('\n')).toContain('Unknown option for install');
    expect(await cmdWinInstall(['--launch-agents-dir', '/x'], fake())).toBe(1);
    expect(await cmdWinUninstall(['--nope'], fake())).toBe(1);
    expect(err.join('\n')).toContain('Unknown option for uninstall');
    expect(files()).toEqual([]);
  });

  it('stops with a sentence when the dashboard is not built or the project folder is wrong', async () => {
    expect(await cmdWinInstall(['--project-dir', join(work, 'missing'), '--no-schtasks'], fake())).toBe(1);
    expect(err.join('\n')).toContain('does not exist');
    removeTemp(join(proj, 'web'));
    expect(await cmdWinInstall(['--project-dir', proj, '--no-schtasks'], fake())).toBe(1);
    expect(err.join('\n')).toContain('pnpm build:web');
    expect(files()).toEqual([]);
  });
});

describe('dry run', () => {
  it('install prints the launcher, the XML and every command, and changes nothing', async () => {
    process.env['LEDGER_TZ'] = 'Asia/Dhaka';
    const d = fake();
    const code = await cmdWinInstall(['--project-dir', proj, '--dry-run'], d);
    expect(code, err.join('\n')).toBe(0);
    const t = text();
    expect(t).toContain('Dry run: nothing was changed.');
    expect(t).toContain(`The launcher would be written to ${join(data, 'launcher.js')}`);
    expect(t).toContain('WScript.Quit(code);');
    expect(t).toContain('env("LEDGER_TZ") = "Asia/Dhaka";');
    expect(t).toContain(`The task definition would be written to ${join(data, 'task.xml')}`);
    expect(t).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(t).toContain('schtasks /Change /TN UsageLedger /DISABLE');
    expect(t.indexOf('schtasks /Change /TN UsageLedger /DISABLE')).toBeLessThan(t.indexOf('schtasks /End /TN UsageLedger'));
    expect(t).toContain('<StartBoundary>2026-10-28T09:05:03</StartBoundary>');
    expect(t).toContain('<TimeTrigger>');
    expect(t).toContain('a trigger that fires every minute');
    expect(t).toContain('schtasks /End /TN UsageLedger');
    expect(t).toContain(`schtasks /Create /TN UsageLedger /XML ${join(data, 'task.xml')} /F`);
    expect(t).toContain('schtasks /Run /TN UsageLedger');
    expect(t).toContain('http://127.0.0.1:47821/api/health');
    expect(files()).toEqual([]);
    expect(d.calls).toEqual([]);
  });

  it('uninstall lists every step and removes nothing', async () => {
    await cmdWinInstall(['--project-dir', proj, '--no-schtasks'], fake());
    out.length = 0;
    const d = fake();
    expect(await cmdWinUninstall(['--dry-run', '--delete-data', '--yes'], d)).toBe(0);
    const t = text();
    expect(t).toContain('schtasks /Change /TN UsageLedger /DISABLE');
    expect(t.indexOf('schtasks /Change /TN UsageLedger /DISABLE')).toBeLessThan(t.indexOf('schtasks /End /TN UsageLedger'));
    expect(t).toContain('schtasks /End /TN UsageLedger');
    expect(t).toContain('taskkill /PID <number> /T /F');
    expect(t).toContain('schtasks /Delete /TN UsageLedger /F');
    expect(t).toContain(`remove ${join(data, 'launcher.js')}`);
    expect(t).toContain(`delete the archive folder ${data}`);
    expect(files()).toEqual(['launcher.js', 'task.xml']);
    expect(d.calls).toEqual([]);
  });
});

describe('install with the commands faked', () => {
  it('registers, starts and waits for the dashboard, in order', async () => {
    let asked = 0;
    const d = fake({ health: () => ++asked > 1 });
    const code = await cmdWinInstall(['--project-dir', proj], d);
    expect(code, err.join('\n')).toBe(0);
    expect(d.calls).toEqual([
      'schtasks /Change /TN UsageLedger /DISABLE',
      'schtasks /End /TN UsageLedger',
      `schtasks /Create /TN UsageLedger /XML ${join(data, 'task.xml')} /F`,
      'schtasks /Run /TN UsageLedger',
    ]);
    expect(files()).toEqual(['launcher.js', 'task.xml']);
    const xml = readFileSync(join(data, 'task.xml'));
    expect(new TextDecoder('utf-16le', { ignoreBOM: true }).decode(xml.subarray(2))).toContain('<StartBoundary>2026-10-28T09:05:03</StartBoundary>');
    expect(text()).toContain('The ledger is running. Open http://127.0.0.1:47821');
  });

  it('goes on when there is no task to switch off yet (a first install)', async () => {
    let asked = 0;
    const d = fake({
      answer: (c) => (c.startsWith('schtasks /Change') || c.startsWith('schtasks /End') ? { code: 1, text: 'ERROR: The system cannot find the file specified.' } : undefined),
      health: () => ++asked > 1,
    });
    expect(await cmdWinInstall(['--project-dir', proj], d)).toBe(0);
    expect(text()).toContain('There was no task to switch off.');
    expect(d.calls[0]).toBe('schtasks /Change /TN UsageLedger /DISABLE');
    expect(d.calls).toContain(`schtasks /Create /TN UsageLedger /XML ${join(data, 'task.xml')} /F`);
  });

  it('stops without registering when a dashboard already answers', async () => {
    const d = fake({ health: () => true });
    expect(await cmdWinInstall(['--project-dir', proj], d)).toBe(1);
    expect(err.join('\n')).toContain('Something already answers on http://127.0.0.1:47821');
    expect(d.calls).toEqual(['schtasks /Change /TN UsageLedger /DISABLE', 'schtasks /End /TN UsageLedger']);
  });

  it('prints what schtasks said when it fails', async () => {
    const d = fake({ answer: (c) => (c.startsWith('schtasks /Create') ? { code: 1, text: 'ERROR: Access is denied.' } : undefined) });
    expect(await cmdWinInstall(['--project-dir', proj], d)).toBe(1);
    expect(err.join('\n')).toContain('Windows could not register the task: ERROR: Access is denied.');
    expect(d.calls.some((c) => c.startsWith('schtasks /Run'))).toBe(false);
  });
});

describe('uninstall with the commands faked', () => {
  const lock = (): string => join(data, 'ingest.lock');
  const NODE_ROW = '"node.exe","4242","Console","1","80,000 K"';

  // tasklist answers with the row until taskkill has been called, then with the "no tasks" sentence.
  function serveAlive(row = NODE_ROW) {
    let killed = false;
    return {
      answer: (cmd: string) => {
        if (cmd.startsWith('taskkill')) {
          killed = true;
          return { code: 0, text: 'SUCCESS' };
        }
        if (cmd.startsWith('tasklist')) return { code: 0, text: killed ? 'INFO: No tasks are running which match the specified criteria.' : row };
        return undefined;
      },
    };
  }

  it('ends the task, kills the serve process by the pid in the lock, deletes the task and the files', async () => {
    await cmdWinInstall(['--project-dir', proj, '--no-schtasks'], fake());
    writeFileSync(lock(), '4242\n');
    out.length = 0;
    const d = fake({ ...serveAlive(), health: () => true });
    const code = await cmdWinUninstall([], d);
    expect(code, err.join('\n')).toBe(0);
    expect(d.calls).toEqual([
      'schtasks /Change /TN UsageLedger /DISABLE',
      'schtasks /End /TN UsageLedger',
      'tasklist /FI PID eq 4242 /FO CSV /NH',
      'taskkill /PID 4242 /T /F',
      'tasklist /FI PID eq 4242 /FO CSV /NH',
      'schtasks /Delete /TN UsageLedger /F',
    ]);
    expect(files()).toEqual([]);
    expect(text()).toContain('The ledger process (4242) was stopped.');
    expect(text()).toContain('The task was removed.');
  });

  it('kills nothing when no process is alive for the lock (a stale lock)', async () => {
    writeFileSync(lock(), '4242\n');
    const d = fake({ answer: (c) => (c.startsWith('tasklist') ? { code: 0, text: 'INFO: No tasks are running which match the specified criteria.' } : undefined), health: () => true });
    expect(await cmdWinUninstall([], d)).toBe(0);
    expect(d.calls.some((c) => c.startsWith('taskkill'))).toBe(false);
    expect(text()).toContain('No running ledger process was found.');
  });

  it('leaves a process alone when the pid now belongs to another program', async () => {
    writeFileSync(lock(), '4242\n');
    const d = fake({ ...serveAlive('"chrome.exe","4242","Console","1","80,000 K"'), health: () => true });
    expect(await cmdWinUninstall([], d)).toBe(0);
    expect(d.calls.some((c) => c.startsWith('taskkill'))).toBe(false);
    expect(text()).toContain('not a node program');
  });

  it('leaves a node process alone when no dashboard answers, and then refuses to delete the archive', async () => {
    writeFileSync(lock(), '4242\n');
    writeFileSync(join(data, 'ledger.db'), 'archive');
    const d = fake({ ...serveAlive(), health: () => false });
    expect(await cmdWinUninstall(['--delete-data', '--yes'], d)).toBe(1);
    expect(d.calls.some((c) => c.startsWith('taskkill'))).toBe(false);
    expect(text()).toContain('left alone');
    expect(err.join('\n')).toContain('The archive was not deleted');
    expect(existsSync(join(data, 'ledger.db'))).toBe(true);
  });

  it('treats a task that is not registered as fine, and a real failure as an error', async () => {
    const missing = fake({ answer: (c) => (c.startsWith('schtasks') && !c.startsWith('schtasks /Delete') ? { code: 1, text: '' } : c.startsWith('schtasks /Delete') ? { code: 1, text: 'ERROR: does not exist' } : undefined) });
    expect(await cmdWinUninstall([], missing)).toBe(0);
    expect(text()).toContain('The task was not registered, nothing to remove.');
    expect(text()).toContain('There was no task to switch off.');
    err.length = 0;
    const denied = fake({ answer: (c) => (c.startsWith('schtasks /Delete') ? { code: 1, text: 'ERROR: Access is denied.' } : undefined) });
    expect(await cmdWinUninstall([], denied)).toBe(1);
    expect(err.join('\n')).toContain('Windows could not remove the task: ERROR: Access is denied.');
  });
});

describe('dispatch from the command line', () => {
  it('sends install to this system start at login code and the help does not name a mechanism', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, LEDGER_DATA_DIR: data, LEDGER_TZ: undefined, LEDGER_RETENTION_DAYS: undefined };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const r = spawnSync(process.execPath, ['src/cli.ts', 'install', '--dry-run', '--project-dir', proj], { cwd: ROOT, env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    if (process.platform === 'darwin') {
      expect(r.stdout).toContain('launchctl bootstrap');
      expect(r.stdout).toContain('com.usageledger.agent.plist');
      expect(r.stdout).not.toContain('schtasks');
    } else {
      expect(r.stdout).toContain('schtasks /Create /TN UsageLedger');
      expect(r.stdout).not.toContain('launchctl');
    }
    const help = spawnSync(process.execPath, ['src/cli.ts', '--help'], { cwd: ROOT, env, encoding: 'utf8' }).stdout;
    expect(help).toMatch(/install\s+start the ledger at login\n/);
    expect(help).not.toContain('LaunchAgent');
    expect(help).not.toContain('Task Scheduler');
  });

  it('the launcher text in the module is the one the install writes', async () => {
    await cmdWinInstall(['--project-dir', proj, '--no-schtasks'], fake());
    const written = readFileSync(join(data, 'launcher.js'), 'utf8');
    expect(written).toBe(
      buildLauncher({
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        projectDir: proj,
        cliPath: join(proj, 'src', 'cli.ts'),
        dataDir: data,
        userId: 'x',
        wscriptExists: true,
        startBoundary: '2026-10-28T09:05:03',
      }),
    );
  });
});
