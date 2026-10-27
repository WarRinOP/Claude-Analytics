// Starts the real `serve` command against synthetic data and tells the tests where it is (LEDGER_E2E_URL, LEDGER_E2E_ROOT).
//   LEDGER_DATA_DIR    a temp folder (the app refuses anything outside the system temp folder)
//   CLAUDE_CONFIG_DIR  a temp folder, so the transcript root is <temp>/claude/projects and the real ~/.claude is never read
//   LEDGER_TZ=UTC      so the local day of every synthetic event is the same on every machine
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTemp } from '../unit/helpers.ts';
import { writeTranscripts } from './fixture.ts';

const root = resolve(import.meta.dirname, '..', '..');

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => done(port));
    });
  });
}

async function waitFor(url: string, ok: (body: string) => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      last = await res.text();
      if (res.ok && ok(last)) return;
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}: ${last.slice(0, 200)}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) {
    const built = spawnSync('pnpm', ['build:web'], { cwd: root, encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`build:web failed: ${built.stdout}${built.stderr}`);
  }
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-e2e-')));
  const config = join(work, 'claude');
  const projects = join(config, 'projects');
  const data = join(work, 'data');
  mkdirSync(data, { recursive: true });
  writeTranscripts(projects);

  const port = await freePort();
  let child: ChildProcess | null = spawn(process.execPath, ['src/cli.ts', 'serve'], {
    cwd: root,
    env: { ...process.env, LEDGER_DATA_DIR: data, CLAUDE_CONFIG_DIR: config, LEDGER_PORT: String(port), LEDGER_TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  const exited = new Promise<never>((_, fail) => child?.once('exit', (code) => fail(new Error(`serve exited early (${code}): ${output.slice(-400)}`))));

  exited.catch(() => undefined); // later exits (the teardown) are not errors
  const url = `http://127.0.0.1:${port}`;
  try {
    await Promise.race([
      waitFor(`${url}/api/health`, (b) => (JSON.parse(b) as { sync: { lastSuccessAt: number | null } }).sync.lastSuccessAt !== null, 30_000),
      exited,
    ]);
  } catch (err) {
    const dying = child;
    if (dying.exitCode === null) {
      await new Promise<void>((done) => {
        dying.once('exit', () => done());
        dying.kill('SIGTERM');
      });
    }
    removeTemp(work);
    throw err;
  }
  process.env['LEDGER_E2E_URL'] = url;
  process.env['LEDGER_E2E_ROOT'] = projects;

  return async () => {
    const c = child;
    child = null;
    if (c !== null && c.exitCode === null) {
      await new Promise<void>((done) => {
        c.once('exit', () => done());
        c.kill('SIGTERM');
        setTimeout(() => c.kill('SIGKILL'), 5000).unref();
      });
    }
    removeTemp(work);
  };
}
