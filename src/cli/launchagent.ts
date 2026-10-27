// `node src/cli.ts install` and `uninstall`: a user LaunchAgent that starts the ledger at login.
// The plist is the only file written outside the app data folder, and only through assertLaunchAgentPlistPath.
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dataDir, isInside, logsDir, realpathNearest } from '../config/paths.ts';
import { LAUNCH_AGENT_LABEL, assertLaunchAgentPlistPath, assertWritablePath, guardedMkdir, launchAgentPlistPath } from '../config/pathGuard.ts';
import { DEFAULT_PORT, retentionDays as configuredRetention, tz as configuredTz } from '../config/settings.ts';

export const STANDARD_NODE = '/usr/local/bin/node';
const HEALTH_WAIT_MS = 10_000;
const HEALTH_STEP_MS = 500;

// ---------------------------------------------------------------- pure helpers (tested directly)

// Escapes text for an XML element body.
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface PlistInput {
  nodePath: string;
  cliPath: string; // absolute path of src/cli.ts in the project folder
  projectDir: string;
  stdoutPath: string;
  stderrPath: string;
  tz?: string; // LEDGER_TZ as set at install time, else omitted
  retentionDays?: number; // LEDGER_RETENTION_DAYS as set at install time, else omitted
}

export function buildPlist(i: PlistInput): string {
  const s = (v: string): string => `<string>${xmlEscape(v)}</string>`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${s(LAUNCH_AGENT_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${s(i.nodePath)}`,
    `    ${s('--disable-warning=ExperimentalWarning')}`,
    `    ${s(i.cliPath)}`,
    `    ${s('serve')}`,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${s(i.projectDir)}`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    `  ${s(i.stdoutPath)}`,
    '  <key>StandardErrorPath</key>',
    `  ${s(i.stderrPath)}`,
  ];
  const env: Array<[string, string]> = [];
  if (i.tz !== undefined && i.tz !== '') env.push(['LEDGER_TZ', i.tz]);
  if (i.retentionDays !== undefined) env.push(['LEDGER_RETENTION_DAYS', String(i.retentionDays)]);
  if (env.length > 0) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [k, v] of env) lines.push(`    <key>${k}</key>`, `    ${s(v)}`);
    lines.push('  </dict>');
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

// The node binary written into the plist: /usr/local/bin/node when that is the node running this command, else the
// running node, with a warning for the person installing.
export function chooseNode(execPath: string, standard: string = STANDARD_NODE): { path: string; warning: string | null } {
  let same = execPath === standard;
  if (!same) {
    try {
      same = realpathSync(execPath) === realpathSync(standard);
    } catch {
      same = false;
    }
  }
  if (same) return { path: standard, warning: null };
  return {
    path: execPath,
    warning: `Warning: this command runs on ${execPath}, not ${standard}. The login service will use ${execPath}. Install Node there again if you move it.`,
  };
}

// True when a folder is a temp copy, which is gone or stale tomorrow.
export function isWorktreeOrTempPath(dir: string): boolean {
  const abs = resolve(dir);
  const temps = new Set<string>(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']);
  try {
    temps.add(realpathSync(tmpdir()));
  } catch {
    // no temp folder to compare with
  }
  const real = realpathNearest(abs);
  for (const t of temps) if (isInside(t, abs) || isInside(t, real)) return true;
  return false;
}

// The project folder the agent runs from: --project-dir, else the folder this module sits in (two levels up from
// src/cli). Refuses a temp folder unless --project-dir was given. Returns the folder or a plain sentence.
export function resolveProjectDir(given: string | undefined, moduleDir: string): { dir: string } | { error: string } {
  const dir = given !== undefined ? resolve(given) : resolve(moduleDir, '..', '..');
  if (given === undefined && isWorktreeOrTempPath(dir)) {
    return { error: `This copy of the ledger sits in a temp folder (${dir}). Run install from the main project folder, or give --project-dir <folder>.` };
  }
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { error: `The project folder does not exist: ${dir}` };
  if (!existsSync(join(dir, 'src', 'cli.ts'))) return { error: `The folder is not the ledger project (src/cli.ts is missing): ${dir}` };
  return { dir };
}

// ---------------------------------------------------------------- options

interface Opts {
  flags: Set<string>;
  values: Map<string, string>;
}

function parseOpts(args: string[], command: string, flags: string[], values: string[]): Opts | string {
  const out: Opts = { flags: new Set(), values: new Map() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (flags.includes(name) && eq === -1) out.flags.add(name);
    else if (values.includes(name)) {
      const v = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') return `${name} needs a value.`;
      out.values.set(name, v);
    } else return `Unknown option for ${command}: ${a.slice(0, 40)}`;
  }
  return out;
}

const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 501);
const domain = (): string => `gui/${uid()}`;

function launchctl(args: string[]): { code: number; text: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { code: r.status ?? 1, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function healthOnce(port: number): Promise<boolean> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 1500 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}

async function waitForHealth(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await healthOnce(port)) return true;
    if (Date.now() >= end) return false;
    await sleep(HEALTH_STEP_MS);
  }
}

// ---------------------------------------------------------------- install

const INSTALL_FLAGS = ['--dry-run', '--no-launchctl'];
const INSTALL_VALUES = ['--project-dir', '--launch-agents-dir'];

export async function cmdInstall(args: string[]): Promise<number> {
  const o = parseOpts(args, 'install', INSTALL_FLAGS, INSTALL_VALUES);
  if (typeof o === 'string') {
    console.error(o);
    return 1;
  }
  const dry = o.flags.has('--dry-run');
  const noCtl = o.flags.has('--no-launchctl');
  const agentsDirArg = o.values.get('--launch-agents-dir');
  if (agentsDirArg !== undefined && !noCtl && !dry) {
    console.error('--launch-agents-dir is for tests and needs --no-launchctl.');
    return 1;
  }

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

  let plistPath: string;
  let logs: string;
  try {
    plistPath = launchAgentPlistPath(agentsDirArg);
    logs = logsDir();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const node = chooseNode(process.execPath);
  const plist = buildPlist({
    nodePath: node.path,
    cliPath: join(project.dir, 'src', 'cli.ts'),
    projectDir: project.dir,
    stdoutPath: join(logs, 'launchagent.out.log'),
    stderrPath: join(logs, 'launchagent.err.log'),
    ...(zone !== undefined ? { tz: zone } : {}),
    ...(retention !== undefined ? { retentionDays: retention } : {}),
  });
  const bootout = ['bootout', `${domain()}/${LAUNCH_AGENT_LABEL}`];
  const bootstrap = ['bootstrap', domain(), plistPath];
  const portNote = process.env['LEDGER_PORT'] !== undefined && process.env['LEDGER_PORT'] !== '' ? `Note: LEDGER_PORT is not carried into the login service. It listens on port ${DEFAULT_PORT}.` : null;

  if (dry) {
    const out = [
      'Dry run: nothing was changed.',
      '',
      `The plist would be written to ${plistPath} (mode 644):`,
      '',
      plist.trimEnd(),
      '',
      'These commands would run, in this order:',
      `  launchctl ${bootout.join(' ')}   (the answer "not loaded" is ignored)`,
      `  launchctl ${bootstrap.join(' ')}`,
      `Then http://127.0.0.1:${DEFAULT_PORT}/api/health is checked for up to ${HEALTH_WAIT_MS / 1000} seconds.`,
    ];
    if (node.warning !== null) out.push('', node.warning);
    if (portNote !== null) out.push('', portNote);
    console.log(out.join('\n'));
    return 0;
  }

  if (node.warning !== null) console.log(node.warning);
  if (portNote !== null) console.log(portNote);
  try {
    guardedMkdir(logs);
    const real = assertLaunchAgentPlistPath(plistPath, agentsDirArg);
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, plist, { mode: 0o644 });
    chmodSync(real, 0o644);
  } catch (err) {
    console.error(`Could not write the plist: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log(`Wrote ${plistPath}`);
  if (noCtl) {
    console.log('launchctl was skipped (--no-launchctl). The agent is not loaded.');
    return 0;
  }

  const out = launchctl(bootout);
  console.log(out.code === 0 ? 'An earlier copy of the agent was stopped.' : 'No earlier copy of the agent was loaded.');
  await sleep(500);
  if (await healthOnce(DEFAULT_PORT)) {
    console.error(
      `Something already answers on http://127.0.0.1:${DEFAULT_PORT} (probably a ledger started by hand). Stop it, then run install again. The plist is written but the agent is not loaded.`,
    );
    return 1;
  }
  let boot = launchctl(bootstrap);
  for (let tries = 0; boot.code !== 0 && tries < 3; tries++) {
    await sleep(1000);
    boot = launchctl(bootstrap);
  }
  if (boot.code !== 0) {
    console.error(`launchctl could not load the agent: ${boot.text.slice(0, 300)}`);
    return 1;
  }
  console.log('The agent is loaded. Waiting for the dashboard to answer.');
  if (await waitForHealth(DEFAULT_PORT, HEALTH_WAIT_MS)) {
    console.log(`The ledger is running. Open http://127.0.0.1:${DEFAULT_PORT}`);
    return 0;
  }
  console.error(`The agent is loaded but the dashboard did not answer within ${HEALTH_WAIT_MS / 1000} seconds. Look at ${join(logs, 'launchagent.err.log')} and run node src/cli.ts doctor.`);
  return 1;
}

// ---------------------------------------------------------------- uninstall

const UNINSTALL_FLAGS = ['--dry-run', '--no-launchctl', '--delete-data', '--yes'];
const UNINSTALL_VALUES = ['--launch-agents-dir'];

export async function cmdUninstall(args: string[]): Promise<number> {
  const o = parseOpts(args, 'uninstall', UNINSTALL_FLAGS, UNINSTALL_VALUES);
  if (typeof o === 'string') {
    console.error(o);
    return 1;
  }
  const dry = o.flags.has('--dry-run');
  const noCtl = o.flags.has('--no-launchctl');
  const del = o.flags.has('--delete-data');
  const agentsDirArg = o.values.get('--launch-agents-dir');
  if (o.flags.has('--yes') && !del) {
    console.error('--yes only goes with --delete-data.');
    return 1;
  }
  if (del && !o.flags.has('--yes')) {
    console.error('--delete-data removes the whole archive and cannot be undone. Add --yes to confirm it.');
    return 1;
  }
  if (agentsDirArg !== undefined && !noCtl && !dry) {
    console.error('--launch-agents-dir is for tests and needs --no-launchctl.');
    return 1;
  }

  let plistPath: string;
  let data: string;
  try {
    plistPath = launchAgentPlistPath(agentsDirArg);
    data = dataDir();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const bootout = ['bootout', `${domain()}/${LAUNCH_AGENT_LABEL}`];

  if (dry) {
    const out = ['Dry run: nothing was changed.', '', 'These steps would run, in this order:'];
    if (!noCtl) out.push(`  launchctl ${bootout.join(' ')}   (the answer "not loaded" is ignored)`);
    out.push(`  remove ${plistPath}${existsSync(plistPath) ? '' : ' (not there now)'}`);
    out.push(del ? `  delete the archive folder ${data} and everything in it` : `  keep the archive in ${data}`);
    out.push('Nothing under ~/.claude is touched.');
    console.log(out.join('\n'));
    return 0;
  }

  if (!noCtl) {
    const r = launchctl(bootout);
    console.log(r.code === 0 ? 'The agent was stopped.' : 'The agent was not loaded.');
  }
  try {
    const real = assertLaunchAgentPlistPath(plistPath, agentsDirArg);
    try {
      unlinkSync(real);
      console.log(`Removed ${plistPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      console.log(`No plist at ${plistPath}, nothing to remove.`);
    }
  } catch (err) {
    console.error(`Could not remove the plist: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (del) {
    try {
      // The path guard only allows paths inside the app data folder; the folder itself must also be the whole target.
      const real = assertWritablePath(data);
      if (real !== realpathNearest(dataDir())) throw new Error('the data folder resolved to an unexpected place');
      if (!existsSync(real)) console.log(`No archive folder at ${data}.`);
      else {
        rmSync(real, { recursive: true, force: true });
        console.log(`Deleted the archive folder ${data}`);
      }
    } catch (err) {
      console.error(`Could not delete the archive: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  } else {
    console.log(`The archive in ${data} was kept. Add --delete-data --yes to remove it too.`);
  }
  return 0;
}
