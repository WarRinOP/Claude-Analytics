// `node src/cli.ts install` and `uninstall` on Windows.
// A per user Task Scheduler task starts `serve` at every login through a small JScript launcher run by wscript.exe,
// so no console window stays open. No administrator rights, nothing outside the app data folder except the task itself.
//
// The builders (launcher text, task XML, install and uninstall plans) are pure and tested on any system. The commands
// only execute a plan. Programs are started with spawnSync(program, args), never through a shell.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { dataDir, realpathNearest } from '../config/paths.ts';
import { assertWritablePath, guardedWriteFile } from '../config/pathGuard.ts';
import { DEFAULT_PORT, retentionDays as configuredRetention, tz as configuredTz } from '../config/settings.ts';
import { lockPath } from '../ingest/lock.ts';
import { healthOnce, parseOpts, resolveProjectDir, xmlEscape } from './launchagent.ts';

export const TASK_NAME = 'UsageLedger';
export const LAUNCHER_FILE = 'launcher.js';
export const TASK_FILE = 'task.xml';
const WSCRIPT = '%SystemRoot%\\System32\\wscript.exe';
const POWERSHELL = '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// Longer than the macOS wait: node and wscript start slower on a cold Windows machine with a virus scanner.
const HEALTH_WAIT_MS = 20_000;
const HEALTH_STEP_MS = 500;
const STOP_WAIT_MS = 5_000;

// ---------------------------------------------------------------- pure builders

export interface StartupInput {
  nodePath: string; // node.exe that runs this command
  projectDir: string;
  cliPath: string; // absolute path of src\cli.ts in the project folder
  dataDir: string; // the app data folder; launcher.js and task.xml live here
  userId: string; // DOMAIN\user, or the plain user name
  tz?: string; // LEDGER_TZ as set at install time, else omitted
  retentionDays?: number; // LEDGER_RETENTION_DAYS as set at install time, else omitted
  wscriptExists: boolean; // false switches the task to the hidden PowerShell fallback
  startBoundary: string; // install time in local time without an offset, YYYY-MM-DDTHH:MM:SS (see localStartBoundary)
}

// A moment as Task Scheduler's StartBoundary in local time with no offset, from the machine's own clock fields.
export function localStartBoundary(d: Date): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// A file inside the data folder. The separator follows the style of the folder, so a Windows folder gives backslashes
// and a test folder on another system gives its own separator.
function pathIn(dir: string, name: string): string {
  const windowsStyle = dir.includes('\\') || /^[A-Za-z]:/.test(dir);
  return `${dir.replace(/[\\/]+$/, '')}${windowsStyle ? '\\' : '/'}${name}`;
}

export const launcherPath = (i: Pick<StartupInput, 'dataDir'>): string => pathIn(i.dataDir, LAUNCHER_FILE);
export const taskXmlPath = (i: Pick<StartupInput, 'dataDir'>): string => pathIn(i.dataDir, TASK_FILE);

// A JScript string literal that is plain ASCII: quote and backslash are escaped, everything else outside printable ASCII
// becomes \uXXXX (so wscript reads the file correctly in any code page, and a literal can be parsed back as JSON).
export function jsString(s: string): string {
  let out = '"';
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c >= 0x20 && c <= 0x7e) out += String.fromCharCode(c);
    else out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `${out}"`;
}

// A PowerShell single quoted string. PowerShell also treats the curly single quotes as quote characters, so they double too.
export function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (m) => m + m)}'`;
}

// The launcher: plain ES3 JScript for `wscript.exe //B //Nologo`. It sets the two settings in its own process
// environment (only when they were set at install), runs node with window style 0 (hidden), waits and returns node's exit code.
export function buildLauncher(i: StartupInput): string {
  const lines = [
    '// Usage Ledger login launcher. Written by "node src/cli.ts install", removed by "node src/cli.ts uninstall". Do not edit.',
    '// Plain JScript for wscript.exe: starts the dashboard server with no window and waits for it to end.',
    'var shell = new ActiveXObject("WScript.Shell");',
  ];
  const env: Array<[string, string]> = [];
  if (i.tz !== undefined && i.tz !== '') env.push(['LEDGER_TZ', i.tz]);
  if (i.retentionDays !== undefined) env.push(['LEDGER_RETENTION_DAYS', String(i.retentionDays)]);
  if (env.length > 0) {
    lines.push('var env = shell.Environment("PROCESS");');
    for (const [k, v] of env) lines.push(`env(${jsString(k)}) = ${jsString(v)};`);
  }
  lines.push(
    `var node = ${jsString(i.nodePath)};`,
    `var cli = ${jsString(i.cliPath)};`,
    'var command = "\\"" + node + "\\" \\"" + cli + "\\" serve";',
    'var code = shell.Run(command, 0, true);',
    'WScript.Quit(code);',
    '',
  );
  return lines.join('\n');
}

// What the task runs: the launcher through wscript, or (when wscript.exe is missing) hidden PowerShell with the same command.
export function startAction(i: StartupInput): { command: string; args: string } {
  if (i.wscriptExists) return { command: WSCRIPT, args: `//B //Nologo "${launcherPath(i)}"` };
  const parts: string[] = [];
  if (i.tz !== undefined && i.tz !== '') parts.push(`$env:LEDGER_TZ = ${psQuote(i.tz)}`);
  if (i.retentionDays !== undefined) parts.push(`$env:LEDGER_RETENTION_DAYS = ${psQuote(String(i.retentionDays))}`);
  parts.push(`& ${psQuote(i.nodePath)} ${psQuote(i.cliPath)} serve`, 'exit $LASTEXITCODE');
  return { command: POWERSHELL, args: `-NoProfile -WindowStyle Hidden -Command "${parts.join('; ')}"` };
}

// The task definition for `schtasks /Create /XML`. Every value is XML escaped. Written as UTF-16 (see taskXmlBytes).
export function buildTaskXml(i: StartupInput): string {
  const x = xmlEscape;
  const action = startAction(i);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Starts the Usage Ledger dashboard when you sign in. Removed by node src/cli.ts uninstall.</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${x(i.userId)}</UserId>`,
    '    </LogonTrigger>',
    // Task Scheduler does not restart a task whose action ended later (RestartOnFailure only covers a failed start), so a
    // tick every minute, with no end, starts it again after a crash. IgnoreNew makes a tick do nothing while it runs.
    '    <TimeTrigger>',
    '      <Repetition>',
    '        <Interval>PT1M</Interval>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    `      <StartBoundary>${x(i.startBoundary)}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${x(i.userId)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>99</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${x(action.command)}</Command>`,
    `      <Arguments>${x(action.args)}</Arguments>`,
    `      <WorkingDirectory>${x(i.projectDir)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

// schtasks reads the file as the encoding it declares: UTF-16 little endian with a byte order mark.
export function taskXmlBytes(xml: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

// DOMAIN\user from the environment, else the plain user name.
export function currentUserId(env: Record<string, string | undefined>, username: string): string {
  const domain = env['USERDOMAIN'];
  const user = env['USERNAME'];
  if (domain !== undefined && domain.trim() !== '' && user !== undefined && user.trim() !== '') return `${domain.trim()}\\${user.trim()}`;
  return username;
}

// A sentence when a path cannot be carried safely into the task, else null. Windows does not allow a double quote in a
// file name; a percent sign would be expanded by Windows as an environment variable when the task starts.
export function unsafePath(i: StartupInput): string | null {
  const paths = [i.nodePath, i.projectDir, i.cliPath, launcherPath(i), taskXmlPath(i)];
  for (const p of paths) {
    if (p.includes('%')) return `The path ${p} contains a percent sign, which Windows would try to expand as a variable when the task starts. Move the project (or Node) to a folder without it, then run install again.`;
    if (p.includes('"')) return `The path ${p} contains a double quote, which Windows does not allow in a path.`;
  }
  return null;
}

export type Step =
  | { kind: 'write'; path: string; text: string; encoding: 'ascii' | 'utf16le' }
  | {
      kind: 'run';
      program: string;
      args: string[];
      note: string; // shown in the dry run
      ignoreFailure: boolean;
      okText: string;
      failText: string; // an information line when the failure is ignored, else the start of the error
      absentText?: string; // delete only: said instead of an error when no such task exists
    }
  | { kind: 'requirePortFree' }
  | { kind: 'waitForDashboard' }
  | { kind: 'stopServe' }
  | { kind: 'remove'; path: string }
  | { kind: 'deleteData'; path: string };

const schtasks = (...args: string[]): { program: string; args: string[] } => ({ program: 'schtasks', args });

// The first step of install and uninstall. While the task is on, its minute trigger could start a new copy between
// stopping the old process and replacing or deleting the task. A task that does not exist yet is fine.
const disableStep = (okText: string): Step => ({
  kind: 'run',
  ...schtasks('/Change', '/TN', TASK_NAME, '/DISABLE'),
  note: 'switches the task off first, so its minute trigger cannot start a new copy while the old one is replaced; a missing task is fine',
  ignoreFailure: true,
  okText,
  failText: 'There was no task to switch off.',
});

export function installPlan(i: StartupInput): Step[] {
  const xml = taskXmlPath(i);
  return [
    disableStep('The existing task was switched off while it is replaced.'),
    { kind: 'write', path: launcherPath(i), text: buildLauncher(i), encoding: 'ascii' },
    { kind: 'write', path: xml, text: buildTaskXml(i), encoding: 'utf16le' },
    {
      kind: 'run',
      ...schtasks('/End', '/TN', TASK_NAME),
      note: 'stops an earlier copy; the answer "not running" is ignored',
      ignoreFailure: true,
      okText: 'An earlier copy of the task was stopped.',
      failText: 'No earlier copy of the task was running.',
    },
    // Ending the task may leave its node process running; a reinstall (an update) stops the ledger the same guarded way
    // uninstall does, so the port check below only stops for a copy that is not ours.
    { kind: 'stopServe' },
    { kind: 'requirePortFree' },
    {
      kind: 'run',
      ...schtasks('/Create', '/TN', TASK_NAME, '/XML', xml, '/F'),
      note: 'registers the task for this user and replaces an older one',
      ignoreFailure: false,
      okText: 'The task is registered for this user.',
      failText: 'Windows could not register the task',
    },
    {
      kind: 'run',
      ...schtasks('/Run', '/TN', TASK_NAME),
      note: 'starts it now, so you do not have to log out',
      ignoreFailure: false,
      okText: 'The task was started. Waiting for the dashboard to answer.',
      failText: 'The task is registered but Windows could not start it',
    },
    { kind: 'waitForDashboard' },
  ];
}

export function uninstallPlan(i: { dataDir: string; deleteData: boolean }): Step[] {
  const steps: Step[] = [
    disableStep('The task was switched off.'),
    {
      kind: 'run',
      ...schtasks('/End', '/TN', TASK_NAME),
      note: 'the answer "not running" is ignored',
      ignoreFailure: true,
      okText: 'The task was stopped.',
      failText: 'The task was not running.',
    },
    { kind: 'stopServe' },
    {
      kind: 'run',
      ...schtasks('/Delete', '/TN', TASK_NAME, '/F'),
      note: 'a task that is not registered is fine',
      ignoreFailure: false,
      okText: 'The task was removed.',
      failText: 'Windows could not remove the task',
      absentText: 'The task was not registered, nothing to remove.',
    },
    { kind: 'remove', path: launcherPath(i) },
    { kind: 'remove', path: taskXmlPath(i) },
  ];
  if (i.deleteData) steps.push({ kind: 'deleteData', path: i.dataDir });
  return steps;
}

// The image name that tasklist reports for a pid, from its CSV output (`"node.exe","1234",...`), else null.
// Matches on the pid column, so the localized "no tasks" sentence never counts.
export function parseTasklist(text: string, pid: number): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m !== null && Number(m[2]) === pid) return m[1] as string;
  }
  return null;
}

// ---------------------------------------------------------------- running a plan

export interface Deps {
  execPath: string;
  userName: () => string;
  exists: (path: string) => boolean;
  run: (program: string, args: string[]) => { code: number; text: string };
  health: (port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date; // the install time that becomes the minute trigger's StartBoundary
}

export function defaultDeps(): Deps {
  return {
    execPath: process.execPath,
    userName: () => {
      try {
        return userInfo().username;
      } catch {
        return '';
      }
    },
    exists: existsSync,
    run: (program, args) => {
      const r = spawnSync(program, args, { encoding: 'utf8', windowsHide: true });
      if (r.error !== undefined) return { code: 1, text: r.error.message };
      return { code: r.status ?? 1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
    },
    health: healthOnce,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}

// A command as one readable line (for the dry run only).
function show(program: string, args: string[]): string {
  return [program, ...args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))].join(' ');
}

async function waitForHealth(deps: Deps, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await deps.health(DEFAULT_PORT)) return true;
    if (Date.now() >= end) return false;
    await deps.sleep(HEALTH_STEP_MS);
  }
}

function readLockPid(): number | null {
  try {
    const n = Number.parseInt(readFileSync(lockPath(), 'utf8').trim(), 10);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

type StopOutcome =
  | { outcome: 'none' } // no lock, or its process is gone (a stale lock)
  | { outcome: 'stopped'; pid: number }
  | { outcome: 'foreign'; pid: number } // a live process that is not node.exe (the pid was reused): left alone
  | { outcome: 'silent'; pid: number } // a node process holds the lock but the dashboard does not answer: left alone
  | { outcome: 'failed'; pid: number; text: string };

const imageOf = (deps: Deps, pid: number): string | null => parseTasklist(deps.run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).text, pid);

// Stops the ledger process that `serve` runs as. `serve` takes the ingest lock at start and keeps it until it ends, and
// the lock file holds its pid. The pid is killed only when it is a running node.exe (a stale lock may name a process
// that Windows has given to another program) and the dashboard answers (serve is the only command that listens; watch
// and ingest hold the same lock but do not). taskkill /T also ends any child of that process.
async function stopServe(deps: Deps): Promise<StopOutcome> {
  const pid = readLockPid();
  if (pid === null) return { outcome: 'none' };
  const image = imageOf(deps, pid);
  if (image === null) return { outcome: 'none' };
  if (image.toLowerCase() !== 'node.exe') return { outcome: 'foreign', pid };
  if (!(await deps.health(DEFAULT_PORT))) return { outcome: 'silent', pid };
  const k = deps.run('taskkill', ['/PID', String(pid), '/T', '/F']);
  const end = Date.now() + STOP_WAIT_MS;
  while (imageOf(deps, pid) !== null) {
    if (Date.now() >= end) return { outcome: 'failed', pid, text: k.code === 0 ? 'the process is still running' : k.text };
    await deps.sleep(250);
  }
  try {
    if (readLockPid() === pid) unlinkSync(lockPath()); // the killed process could not release it
  } catch {
    // already gone
  }
  return { outcome: 'stopped', pid };
}

// Runs the steps in order. Returns 0, or 1 after printing a plain sentence.
async function execute(plan: Step[], deps: Deps): Promise<number> {
  let stillRunning: number | null = null; // a process that holds the lock and was left alone
  for (const step of plan) {
    switch (step.kind) {
      case 'write': {
        try {
          guardedWriteFile(step.path, step.encoding === 'utf16le' ? taskXmlBytes(step.text) : step.text);
        } catch (err) {
          console.error(`Could not write ${step.path}: ${err instanceof Error ? err.message : String(err)}`);
          return 1;
        }
        console.log(`Wrote ${step.path}`);
        break;
      }
      case 'run': {
        const r = deps.run(step.program, step.args);
        if (r.code === 0) {
          console.log(step.okText);
        } else if (step.absentText !== undefined && deps.run('schtasks', ['/Query', '/TN', TASK_NAME]).code !== 0) {
          console.log(step.absentText);
        } else if (step.ignoreFailure) {
          console.log(step.failText);
        } else {
          console.error(`${step.failText}: ${r.text.slice(0, 500)}`);
          return 1;
        }
        break;
      }
      case 'requirePortFree': {
        await deps.sleep(500);
        if (await deps.health(DEFAULT_PORT)) {
          console.error(
            `Something already answers on http://127.0.0.1:${DEFAULT_PORT} (probably a ledger started by hand). Stop it, then run install again. The files are written but the task is not registered.`,
          );
          return 1;
        }
        break;
      }
      case 'waitForDashboard': {
        if (await waitForHealth(deps, HEALTH_WAIT_MS)) {
          console.log(`The ledger is running. Open http://127.0.0.1:${DEFAULT_PORT}`);
          return 0;
        }
        console.error(
          `The task is registered but the dashboard did not answer within ${HEALTH_WAIT_MS / 1000} seconds. Run node src/cli.ts doctor, or open Task Scheduler and look at the task ${TASK_NAME}.`,
        );
        return 1;
      }
      case 'stopServe': {
        const s = await stopServe(deps);
        if (s.outcome === 'none') console.log('No running ledger process was found.');
        else if (s.outcome === 'stopped') console.log(`The ledger process (${s.pid}) was stopped.`);
        else if (s.outcome === 'foreign') console.log(`The lock file names process ${s.pid}, which is not a node program (the number was reused), so it was left alone.`);
        else if (s.outcome === 'silent') {
          stillRunning = s.pid;
          console.log(`Process ${s.pid} holds the ledger lock but no dashboard answers on port ${DEFAULT_PORT}, so it was left alone. Close it yourself if it is a ledger you started.`);
        } else {
          console.error(`Could not stop the ledger process (${s.pid}): ${s.text.slice(0, 300)}`);
          return 1;
        }
        break;
      }
      case 'remove': {
        try {
          unlinkSync(assertWritablePath(step.path));
          console.log(`Removed ${step.path}`);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') console.log(`No file at ${step.path}, nothing to remove.`);
          else {
            console.error(`Could not remove ${step.path}: ${err instanceof Error ? err.message : String(err)}`);
            return 1;
          }
        }
        break;
      }
      case 'deleteData': {
        if (stillRunning !== null) {
          console.error(`The archive was not deleted: process ${stillRunning} still holds it. Close that program, then run uninstall again.`);
          return 1;
        }
        try {
          // The path guard only allows paths inside the app data folder; the folder itself must also be the whole target.
          const real = assertWritablePath(step.path);
          if (real !== realpathNearest(dataDir())) throw new Error('the data folder resolved to an unexpected place');
          if (!existsSync(real)) console.log(`No archive folder at ${step.path}.`);
          else {
            rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            console.log(`Deleted the archive folder ${step.path}`);
          }
        } catch (err) {
          console.error(`Could not delete the archive: ${err instanceof Error ? err.message : String(err)}`);
          return 1;
        }
        break;
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------- install

const INSTALL_FLAGS = ['--dry-run', '--no-schtasks'];
const INSTALL_VALUES = ['--project-dir'];

export async function cmdWinInstall(args: string[], deps: Deps = defaultDeps()): Promise<number> {
  const o = parseOpts(args, 'install', INSTALL_FLAGS, INSTALL_VALUES);
  if (typeof o === 'string') {
    console.error(o);
    return 1;
  }
  const dry = o.flags.has('--dry-run');
  const noTask = o.flags.has('--no-schtasks');

  const project = resolveProjectDir(o.values.get('--project-dir'), import.meta.dirname);
  if ('error' in project) {
    console.error(project.error);
    return 1;
  }
  if (!existsSync(join(project.dir, 'web', 'dist', 'index.html'))) {
    console.error(`The dashboard is not built yet (web/dist/index.html is missing in ${project.dir}). Run pnpm build:web first, then run install again.`);
    return 1;
  }

  let zone: string | undefined;
  let retention: number | undefined;
  try {
    const set = process.env['LEDGER_TZ'];
    if (set !== undefined && set.trim() !== '') zone = configuredTz();
    const days = process.env['LEDGER_RETENTION_DAYS'];
    if (days !== undefined && days.trim() !== '') retention = configuredRetention();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let data: string;
  try {
    data = dataDir();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const userId = currentUserId(process.env, deps.userName());
  if (userId === '') {
    console.error('Could not tell which Windows user this is, so the login task cannot be set up.');
    return 1;
  }
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  const input: StartupInput = {
    nodePath: deps.execPath,
    projectDir: project.dir,
    cliPath: join(project.dir, 'src', 'cli.ts'),
    dataDir: data,
    userId,
    wscriptExists: deps.exists(win32.join(systemRoot, 'System32', 'wscript.exe')),
    startBoundary: localStartBoundary(deps.now()),
    ...(zone !== undefined ? { tz: zone } : {}),
    ...(retention !== undefined ? { retentionDays: retention } : {}),
  };
  const unsafe = unsafePath(input);
  if (unsafe !== null) {
    console.error(unsafe);
    return 1;
  }

  const plan = installPlan(input);
  const notes: string[] = [];
  if (!input.wscriptExists) {
    notes.push('wscript.exe was not found on this PC, so the login task starts the ledger through PowerShell in a hidden window. A small window may flash for a moment at login.');
  }
  if (process.env['LEDGER_PORT'] !== undefined && process.env['LEDGER_PORT'] !== '') {
    notes.push(`Note: LEDGER_PORT is not carried into the login task. It listens on port ${DEFAULT_PORT}.`);
  }
  notes.push(`The login task uses Node at ${input.nodePath}. Run install again if you move or reinstall Node.`);

  if (dry) {
    const out = ['Dry run: nothing was changed.', ''];
    for (const s of plan) {
      if (s.kind !== 'write') continue;
      out.push(
        s.encoding === 'utf16le'
          ? `The task definition would be written to ${s.path} (saved as UTF-16 with a byte order mark, shown here as text):`
          : `The launcher would be written to ${s.path}:`,
        '',
        s.text.trimEnd(),
        '',
      );
    }
    if (noTask) out.push('schtasks would be skipped (--no-schtasks), so the task would not be registered.');
    else {
      out.push('These commands would run, in this order:');
      for (const s of plan) {
        if (s.kind === 'run') out.push(`  ${show(s.program, s.args)}   (${s.note})`);
        else if (s.kind === 'requirePortFree') out.push(`  stop here if http://127.0.0.1:${DEFAULT_PORT} already answers (a ledger is running)`);
        else if (s.kind === 'waitForDashboard') out.push(`  check http://127.0.0.1:${DEFAULT_PORT}/api/health for up to ${HEALTH_WAIT_MS / 1000} seconds`);
      }
      out.push('The task also has a trigger that fires every minute: nothing happens while the ledger runs, and within about a minute after it stops, the task starts it again.');
    }
    out.push('', ...notes);
    console.log(out.join('\n'));
    return 0;
  }

  for (const n of notes) console.log(n);
  if (noTask) {
    const code = await execute(plan.filter((s) => s.kind === 'write'), deps);
    if (code === 0) console.log('schtasks was skipped (--no-schtasks). The task is not registered.');
    return code;
  }
  return execute(plan, deps);
}

// ---------------------------------------------------------------- uninstall

const UNINSTALL_FLAGS = ['--dry-run', '--no-schtasks', '--delete-data', '--yes'];

export async function cmdWinUninstall(args: string[], deps: Deps = defaultDeps()): Promise<number> {
  const o = parseOpts(args, 'uninstall', UNINSTALL_FLAGS, []);
  if (typeof o === 'string') {
    console.error(o);
    return 1;
  }
  const dry = o.flags.has('--dry-run');
  const noTask = o.flags.has('--no-schtasks');
  const del = o.flags.has('--delete-data');
  if (o.flags.has('--yes') && !del) {
    console.error('--yes only goes with --delete-data.');
    return 1;
  }
  if (del && !o.flags.has('--yes')) {
    console.error('--delete-data removes the whole archive and cannot be undone. Add --yes to confirm it.');
    return 1;
  }

  let data: string;
  try {
    data = dataDir();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const plan = uninstallPlan({ dataDir: data, deleteData: del });

  if (dry) {
    const out = ['Dry run: nothing was changed.', '', 'These steps would run, in this order:'];
    for (const s of plan) {
      if (s.kind === 'run') {
        if (!noTask) out.push(`  ${show(s.program, s.args)}   (${s.note})`);
      } else if (s.kind === 'stopServe') {
        if (!noTask) out.push(`  end the ledger process named in the ingest lock (taskkill /PID <number> /T /F), only if it is a running node.exe and the dashboard on port ${DEFAULT_PORT} answers`);
      } else if (s.kind === 'remove') out.push(`  remove ${s.path}${existsSync(s.path) ? '' : ' (not there now)'}`);
      else if (s.kind === 'deleteData') out.push(`  delete the archive folder ${s.path} and everything in it`);
    }
    if (!del) out.push(`  keep the archive in ${data}`);
    out.push('Nothing under your .claude folder is touched.');
    console.log(out.join('\n'));
    return 0;
  }

  const steps = noTask ? plan.filter((s) => s.kind === 'remove' || s.kind === 'deleteData') : plan;
  if (noTask) console.log('schtasks and taskkill were skipped (--no-schtasks). The task was not touched.');
  const code = await execute(steps, deps);
  if (code !== 0) return code;
  if (!del) console.log(`The archive in ${data} was kept. Add --delete-data --yes to remove it too.`);
  return 0;
}
