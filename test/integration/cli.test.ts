import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncedEvent } from '../../src/api/types.ts';
import { formatClock } from '../../src/metrics/time.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SID = 'aaaaaaaa-0000-0000-0000-00000000000a';

let env: TempEnv;
let work: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-cli-')));
});
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null) {
      c.kill('SIGKILL');
      await new Promise((r) => c.once('exit', r));
    }
  }
  env.restore();
  rmSync(work, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Cli {
  child: ChildProcess;
  out(): string;
  waitFor(re: RegExp, ms?: number): Promise<void>;
  exit(): Promise<number | null>;
}

function cli(args: string[], extraEnv: Record<string, string>): Cli {
  const child = spawn(process.execPath, ['src/cli.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, LEDGER_DATA_DIR: env.dir, CLAUDE_CONFIG_DIR: work, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let buf = '';
  const waiters: Array<{ re: RegExp; ok: () => void }> = [];
  const take = (c: Buffer): void => {
    buf += c.toString('utf8');
    for (const w of [...waiters]) {
      if (w.re.test(buf)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.ok();
      }
    }
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  return {
    child,
    out: () => buf,
    waitFor: (re, ms = 15_000) =>
      new Promise((ok, bad) => {
        if (re.test(buf)) return ok();
        const t = setTimeout(() => bad(new Error(`no ${re} in: ${buf}`)), ms);
        waiters.push({ re, ok: () => (clearTimeout(t), ok()) });
      }),
    exit: () => new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.once('exit', (code) => r(code)))),
  };
}

function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A pass line starts with the clock time of this Mac's configured zone. Returns the minutes between it and now there.
function clockOffsetMinutes(line: string, tz: string): number {
  const m = /^(\d\d):(\d\d):(\d\d) /m.exec(line);
  if (m === null) throw new Error(`no clock in: ${line}`);
  const printed = Number(m[1]) * 60 + Number(m[2]);
  const [h, mi] = formatClock(Date.now(), tz).split(':').map(Number) as [number, number];
  const diff = Math.abs(printed - (h * 60 + mi));
  return Math.min(diff, 1440 - diff);
}

function seedTranscript(): string {
  const file = join(work, 'projects', '-work-demo', `${SID}.jsonl`);
  const t = Date.now() - 3600_000;
  const usageSec = (ms: number): number => Math.round((ms - Date.UTC(2026, 9, 1, 10)) / 1000);
  const userSec = (ms: number): number => Math.round((ms - Date.UTC(2026, 9, 1, 9)) / 1000);
  put(file, [userLine(SID, 'u1', userSec(t), {}, '/work/demo'), usageLine(SID, 1, { stop: true, ts: usageSec(t + 1000), cwd: '/work/demo' })]);
  return file;
}

describe('node src/cli.ts serve', () => {
  it('syncs, serves the API on loopback with the Host check, pushes synced events, prints local times and stops cleanly', async () => {
    const file = seedTranscript();
    const port = await freePort();
    const s = cli(['serve'], { LEDGER_PORT: String(port), LEDGER_TZ: 'Asia/Dhaka' });
    await s.waitFor(new RegExp(`Dashboard: http://127\\.0\\.0\\.1:${port}`));
    await s.waitFor(/startup: 1 of 1 files changed/);
    expect(s.out()).toContain('times in Asia/Dhaka');
    // The clock in the pass line is Dhaka time (UTC+6), not UTC.
    expect(clockOffsetMinutes(s.out().split('\n').find((l) => l.includes('startup:')) as string, 'Asia/Dhaka')).toBeLessThanOrEqual(2);
    expect(clockOffsetMinutes(s.out().split('\n').find((l) => l.includes('startup:')) as string, 'UTC')).toBeGreaterThan(300);

    const sum = JSON.parse((await get(port, '/api/summary')).text) as { prompts: number; responses: number; range: { tz: string } };
    expect([sum.prompts, sum.responses, sum.range.tz]).toEqual([1, 1, 'Asia/Dhaka']);
    const health = JSON.parse((await get(port, '/api/health')).text) as { status: string; sync: { lastSuccessAt: number | null; watcherAlive: boolean }; files: { active: number } };
    expect(health.status).toBe('ok');
    expect(health.sync.lastSuccessAt).not.toBeNull();
    expect(health.files.active).toBe(1);
    expect((await get(port, '/api/summary', 'evil.example')).status).toBe(403);
    // The page is the built dashboard when web/dist exists, else the plain placeholder.
    expect((await get(port, '/')).text).toMatch(/has not been built yet|<div id="root">/);

    // Server Sent Events: append a line and wait for the synced event (watcher debounce is 1.5 s).
    const events: string[] = [];
    const sse = httpRequest({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => events.push(c));
    });
    sse.on('error', () => undefined);
    sse.end();
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now() - 1800_000;
    const usageSec = (ms: number): number => Math.round((ms - Date.UTC(2026, 9, 1, 10)) / 1000);
    put(file, [
      userLine(SID, 'u1', Math.round((t - 1800_000 - Date.UTC(2026, 9, 1, 9)) / 1000), {}, '/work/demo'),
      usageLine(SID, 1, { stop: true, ts: usageSec(t - 1800_000), cwd: '/work/demo' }),
      usageLine(SID, 2, { stop: true, ts: usageSec(t), cwd: '/work/demo' }),
    ]);
    const deadline = Date.now() + 15_000;
    while (!events.join('').includes('event: synced') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const text = events.join('');
    expect(text).toContain('event: synced');
    const ev = JSON.parse(/data: (.*)\n/.exec(text)?.[1] as string) as SyncedEvent;
    expect(typeof ev.at).toBe('number');
    expect(ev.changedFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((JSON.parse((await get(port, '/api/summary')).text) as { responses: number }).responses).toBe(2);
    sse.destroy();

    s.child.kill('SIGTERM');
    expect(await s.exit()).toBe(0);
    expect(s.out()).toContain('stopped');
  }, 40_000);

  it('refuses a second copy, a busy port, a bad zone and a bad port with a plain message', async () => {
    seedTranscript();
    const port = await freePort();
    const first = cli(['serve'], { LEDGER_PORT: String(port), LEDGER_TZ: 'UTC' });
    await first.waitFor(/startup:/);

    const second = cli(['serve'], { LEDGER_PORT: String(port), LEDGER_TZ: 'UTC' });
    expect(await second.exit()).toBe(2);
    expect(second.out()).toMatch(/Another ingest is already running/);

    first.child.kill('SIGTERM');
    expect(await first.exit()).toBe(0);

    // The port is taken by something else now.
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', r));
    const busy = cli(['serve'], { LEDGER_PORT: String(port), LEDGER_TZ: 'UTC' });
    expect(await busy.exit()).toBe(1);
    expect(busy.out()).toMatch(new RegExp(`Port ${port} is already in use`));
    await new Promise((r) => blocker.close(r));

    const badZone = cli(['serve'], { LEDGER_PORT: String(port), LEDGER_TZ: 'Mars/Olympus' });
    expect(await badZone.exit()).toBe(1);
    expect(badZone.out()).toMatch(/Mars\/Olympus.*not valid/);

    const badPort = cli(['serve'], { LEDGER_PORT: 'abc', LEDGER_TZ: 'UTC' });
    expect(await badPort.exit()).toBe(1);
    expect(badPort.out()).toMatch(/LEDGER_PORT/);
  }, 40_000);
});

describe('node src/cli.ts watch', () => {
  it('prints clock times in the configured zone', async () => {
    seedTranscript();
    const w = cli(['watch'], { LEDGER_TZ: 'Pacific/Auckland' });
    await w.waitFor(/startup: 1 of 1 files changed/);
    const line = w.out().split('\n').find((l) => l.includes('startup:')) as string;
    expect(clockOffsetMinutes(line, 'Pacific/Auckland')).toBeLessThanOrEqual(2);
    expect(clockOffsetMinutes(line, 'UTC')).toBeGreaterThan(300);
    w.child.kill('SIGTERM');
    expect(await w.exit()).toBe(0);
  }, 30_000);
});
