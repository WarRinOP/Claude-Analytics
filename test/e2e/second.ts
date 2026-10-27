// A second, separate `serve` process on its own synthetic transcripts, for tests that change the data (an injected malformed
// line, a deleted file) or need more of it (three pages of sessions) without disturbing the shared fixture the other specs read.
// Same safety rules as global-setup: a temp data folder, a temp CLAUDE_CONFIG_DIR, UTC, nothing under ~/.claude is touched.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTemp } from '../unit/helpers.ts';

const repo = resolve(import.meta.dirname, '..', '..');

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

export interface Second {
  url: string;
  projects: string; // <config>/projects, the transcript folder this server reads
  config: string;
  env: NodeJS.ProcessEnv;
  json<T>(path: string): Promise<T>;
  stop(): Promise<void>;
}

export async function startSecond(write: (projects: string) => void): Promise<Second> {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-e2e2-')));
  const config = join(work, 'claude');
  const projects = join(config, 'projects');
  const data = join(work, 'data');
  mkdirSync(data, { recursive: true });
  write(projects);
  const port = await freePort();
  const env = { ...process.env, LEDGER_DATA_DIR: data, CLAUDE_CONFIG_DIR: config, LEDGER_PORT: String(port), LEDGER_TZ: 'UTC' };
  const child: ChildProcess = spawn(process.execPath, ['src/cli.ts', 'serve'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  const url = `http://127.0.0.1:${port}`;
  const json = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${url}${path}`);
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as T;
  };
  const until = Date.now() + 30_000;
  for (;;) {
    try {
      const h = await json<{ sync: { lastSuccessAt: number | null } }>('/api/health');
      if (h.sync.lastSuccessAt !== null) break;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null) throw new Error(`serve exited early (${child.exitCode}): ${output.slice(-400)}`);
    if (Date.now() > until) {
      child.kill('SIGTERM');
      throw new Error(`serve did not start: ${output.slice(-400)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    url,
    projects,
    config,
    env,
    json,
    async stop() {
      if (child.exitCode === null) {
        await new Promise<void>((done) => {
          child.once('exit', () => done());
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        });
      }
      removeTemp(work);
    },
  };
}

// `node src/cli.ts doctor` with the same folders as the server.
export function runDoctor(s: Second): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['src/cli.ts', 'doctor'], { cwd: repo, env: s.env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}

export async function waitUntil(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out waiting for the archive to catch up');
}
