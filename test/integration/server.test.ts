import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncedEvent } from '../../src/api/types.ts';
import { runIngest } from '../../src/ingest/ingest.ts';
import { createSync } from '../../src/ingest/scheduler.ts';
import { ensureRollups, rebuildAll } from '../../src/metrics/rollups.ts';
import { startServer, type RunningServer } from '../../src/server/http.ts';
import { handlePass } from '../../src/server/live.ts';
import { hostAllowed } from '../../src/server/security.ts';
import { createSseHub } from '../../src/server/sse.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { HOUR, IDLE, seeder } from '../unit/metricsHelpers.ts';
import { openAndMigrate, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';
import { removeTemp } from '../unit/helpers.ts';

let env: TempEnv;
let work: string;
const running: RunningServer[] = [];
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-server-')));
});
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
  env.restore();
  removeTemp(work);
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function ask(port: number, path: string, o: { method?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { Host: o.host ?? `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function up(webRoot?: string, hub = createSseHub()): Promise<{ srv: RunningServer; db: ReturnType<typeof seeder>['db'] }> {
  const s = seeder(env.dir, 'Asia/Dhaka');
  s.response('A', Date.parse('2026-10-20T04:00:00Z'), { cwd: '/work/a' });
  s.prompt('A', Date.parse('2026-10-20T03:00:00Z'), { cwd: '/work/a' });
  rebuildAll(s.db, 'Asia/Dhaka');
  const srv = await startServer({ db: s.db, tz: 'Asia/Dhaka', port: 0, hub, syncStatus: () => IDLE, now: () => Date.parse('2026-10-27T06:00:00Z'), ...(webRoot === undefined ? {} : { webRoot }) });
  running.push(srv);
  return { srv, db: s.db };
}

const CSP = "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

function expectSecurityHeaders(r: Reply): void {
  expect(r.headers['content-security-policy']).toBe(CSP);
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  expect(r.headers['referrer-policy']).toBe('no-referrer');
  for (const k of Object.keys(r.headers)) expect(k.startsWith('access-control-'), k).toBe(false);
}

describe('F39 Host header', () => {
  it('answers 403 to Host: evil.example on every path', async () => {
    const { srv } = await up();
    for (const path of ['/api/summary', '/api/health', '/api/events', '/', '/index.html', '/nope']) {
      const r = await ask(srv.port, path, { host: 'evil.example' });
      expect(r.status, path).toBe(403);
      expect(JSON.parse(r.text)).toEqual({ error: expect.any(String) });
      expectSecurityHeaders(r);
    }
  });

  it('accepts exactly 127.0.0.1:<port> and localhost:<port>', async () => {
    const { srv } = await up();
    expect((await ask(srv.port, '/api/health', { host: `127.0.0.1:${srv.port}` })).status).toBe(200);
    expect((await ask(srv.port, '/api/health', { host: `localhost:${srv.port}` })).status).toBe(200);
    expect((await ask(srv.port, '/api/health', { host: `LOCALHOST:${srv.port}` })).status).toBe(200);
  });

  it.each([
    ['no port', '127.0.0.1'],
    ['wrong port', '127.0.0.1:1'],
    ['another name with the right port', 'evil.example:PORT'],
    ['a suffix trick', 'localhost.evil.example:PORT'],
    ['a prefix trick', 'evil127.0.0.1:PORT'],
    ['IPv6 loopback', '[::1]:PORT'],
    ['0.0.0.0', '0.0.0.0:PORT'],
    ['credentials in the host', 'user@127.0.0.1:PORT'],
  ])('refuses %s', async (_name, host) => {
    const { srv } = await up();
    const r = await ask(srv.port, '/api/health', { host: host.replace('PORT', String(srv.port)) });
    expect(r.status).toBe(403);
  });

  // The http client fills in a Host header of its own, so these two go over a raw socket.
  function raw(port: number, request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: '127.0.0.1', port });
      let out = '';
      sock.setEncoding('utf8');
      sock.on('data', (c: string) => (out += c));
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
      sock.write(request);
    });
  }

  it('refuses an empty Host header and a request with no Host header', async () => {
    const { srv } = await up();
    const empty = await raw(srv.port, 'GET /api/health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
    expect(empty).toMatch(/^HTTP\/1\.1 403 /);
    const none = await raw(srv.port, 'GET /api/health HTTP/1.0\r\n\r\n');
    expect(none).toMatch(/^HTTP\/1\.[01] 403 /);
  });

  it('is decided by a pure function too', () => {
    expect(hostAllowed('127.0.0.1:47821', 47821)).toBe(true);
    expect(hostAllowed('localhost:47821', 47821)).toBe(true);
    expect(hostAllowed(undefined, 47821)).toBe(false);
    expect(hostAllowed('127.0.0.1:47822', 47821)).toBe(false);
  });
});

describe('methods and headers', () => {
  it('allows GET and HEAD only, with an Allow header on 405', async () => {
    const { srv } = await up();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await ask(srv.port, '/api/summary', { method });
      expect(r.status, method).toBe(405);
      expect(r.headers['allow']).toBe('GET, HEAD');
      expectSecurityHeaders(r);
    }
    const head = await ask(srv.port, '/api/summary', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(Number(head.headers['content-length'])).toBeGreaterThan(10);
    expect(head.headers['content-type']).toContain('application/json');
  });

  it('checks the Host header before the method', async () => {
    const { srv } = await up();
    expect((await ask(srv.port, '/api/summary', { method: 'POST', host: 'evil.example' })).status).toBe(403);
  });

  it('puts the security headers, no CORS headers and no caching on every kind of answer', async () => {
    const { srv } = await up();
    const replies = await Promise.all([
      ask(srv.port, '/api/summary'),
      ask(srv.port, '/api/summary?from=zzz'),
      ask(srv.port, '/api/missing'),
      ask(srv.port, '/'),
      ask(srv.port, '/missing.js'),
      ask(srv.port, '/api/summary', { method: 'POST' }),
      ask(srv.port, '/api/summary', { host: 'evil.example' }),
    ]);
    expect(replies.map((r) => r.status)).toEqual([200, 400, 404, 200, 404, 405, 403]);
    for (const r of replies) expectSecurityHeaders(r);
    for (const r of [replies[0], replies[1], replies[2]]) {
      expect(r?.headers['cache-control']).toBe('no-store');
      expect(r?.headers['content-type']).toBe('application/json; charset=utf-8');
    }
  });

  it('answers a bad query with 400 and an ApiError body, an unknown API path with 404', async () => {
    const { srv } = await up();
    const bad = await ask(srv.port, '/api/summary?includeSubagents=maybe');
    expect(bad.status).toBe(400);
    expect(Object.keys(JSON.parse(bad.text) as object)).toEqual(['error']);
    expect((await ask(srv.port, '/api/nothing')).status).toBe(404);
    const ok = await ask(srv.port, '/api/summary');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toMatchObject({ sessions: 1, prompts: 1, responses: 1 });
  });

  it('serves the breakdown as JSON and as a CSV download', async () => {
    const { srv } = await up();
    const json = await ask(srv.port, '/api/breakdown?period=day&from=2026-10-20&to=2026-10-20');
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    const b = JSON.parse(json.text) as { rows: Array<{ key: string }>; range: { from: string; to: string } };
    expect(b.rows.map((r) => r.key)).toEqual(['2026-10-20']);
    const csv = await ask(srv.port, '/api/breakdown.csv?period=day&from=2026-10-20&to=2026-10-20');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="usage-day-2026-10-20-2026-10-20.csv"');
    expect(csv.headers['cache-control']).toBe('no-store');
    expectSecurityHeaders(csv);
    expect(csv.text.split('\r\n')[0]).toBe('period,label,from,to,partial,models,model,responses,input,output,cache_write,cache_read,total,cost_usd,unpriced_events');
    expect(csv.text.split('\r\n')).toHaveLength(4); // header, the day, its one model, and the empty piece after the last CRLF
    expect((await ask(srv.port, '/api/breakdown.csv?period=year')).status).toBe(400);
    expect((await ask(srv.port, '/api/breakdown.csv', { host: 'evil.example' })).status).toBe(403);
    expect((await ask(srv.port, '/api/breakdown.csv', { method: 'POST' })).status).toBe(405);
    const head = await ask(srv.port, '/api/breakdown.csv', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
  });
});

describe('F40 binding', () => {
  it('binds to the loopback address only', async () => {
    const { srv } = await up();
    expect(srv.host).toBe('127.0.0.1');
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}`);
  });

  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal);

  it.skipIf(lan === undefined)(`is not reachable on this Mac's own network address (${lan?.address ?? 'none found, test skipped'})`, async () => {
    const { srv } = await up();
    const outcome = await new Promise<string>((resolve) => {
      const sock = connect({ host: lan?.address as string, port: srv.port });
      sock.setTimeout(3000, () => {
        sock.destroy();
        resolve('timeout');
      });
      sock.once('connect', () => {
        sock.destroy();
        resolve('connected');
      });
      sock.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(outcome).not.toBe('connected');
    // The loopback address does answer.
    expect((await ask(srv.port, '/api/health')).status).toBe(200);
  });

  it('says which port is in use when it cannot listen', async () => {
    const { srv, db } = await up();
    await expect(startServer({ db, tz: 'UTC', port: srv.port, syncStatus: () => IDLE })).rejects.toThrow(new RegExp(`Port ${srv.port} is already in use`));
  });
});

describe('the dashboard files', () => {
  function webRoot(): string {
    const root = join(work, 'dist');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title><script type="module" src="/assets/app.js"></script>');
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(root, 'assets', 'style.css'), 'body{}');
    writeFileSync(join(root, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'assets', 'font.woff2'), 'x');
    writeFileSync(join(root, '.hidden'), 'hidden');
    writeFileSync(join(work, 'secret.txt'), 'TOP SECRET');
    symlinkSync(join(work, 'secret.txt'), join(root, 'assets', 'link.txt'));
    return root;
  }

  it('serves files with the right content types', async () => {
    const { srv } = await up(webRoot());
    const types: Array<[string, string]> = [
      ['/', 'text/html; charset=utf-8'],
      ['/index.html', 'text/html; charset=utf-8'],
      ['/assets/app.js', 'text/javascript; charset=utf-8'],
      ['/assets/style.css', 'text/css; charset=utf-8'],
      ['/assets/logo.svg', 'image/svg+xml'],
      ['/assets/font.woff2', 'font/woff2'],
    ];
    for (const [path, type] of types) {
      const r = await ask(srv.port, path);
      expect(r.status, path).toBe(200);
      expect(r.headers['content-type'], path).toBe(type);
      expectSecurityHeaders(r);
    }
    expect((await ask(srv.port, '/assets/app.js')).text).toBe('console.log(1)');
    expect((await ask(srv.port, '/assets/app.js', { method: 'HEAD' })).text).toBe('');
  });

  it('falls back to index.html for a path without extension and 404s a missing file', async () => {
    const { srv } = await up(webRoot());
    const spa = await ask(srv.port, '/sessions/today');
    expect(spa.status).toBe(200);
    expect(spa.text).toContain('<title>app</title>');
    expect((await ask(srv.port, '/assets/missing.js')).status).toBe(404);
  });

  it.each([
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/%2E%2E/secret.txt',
    '/assets/../../secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/..%5csecret.txt',
    '/assets/..%5c..%5csecret.txt',
    '/assets/link.txt',
    '/.hidden',
    '/%00',
    '/assets/%00.js',
    '/%',
    '/%E0%A4%A',
  ])('does not serve anything outside the folder for %s', async (path) => {
    const { srv } = await up(webRoot());
    const r = await ask(srv.port, path);
    expect(r.text).not.toContain('TOP SECRET');
    expect(r.text).not.toContain('hidden');
    expect([200, 400, 404]).toContain(r.status);
    if (r.status === 200) expect(r.text).toContain('<title>app</title>'); // only the fallback page
    expectSecurityHeaders(r);
  });

  it('shows a plain page that says the dashboard is not built when web/dist is missing', async () => {
    const { srv } = await up(join(work, 'does-not-exist'));
    const r = await ask(srv.port, '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.text).toContain('has not been built yet');
    expect(r.text).not.toMatch(/<script|style=|<style/); // nothing the content security policy would block
    expectSecurityHeaders(r);
    expect((await ask(srv.port, '/other')).status).toBe(404);
    expect((await ask(srv.port, '/api/health')).status).toBe(200);
  });
});

// ---------------------------------------------------------------- Server Sent Events

interface Stream {
  status: number;
  headers: IncomingHttpHeaders;
  text(): string;
  waitFor(re: RegExp, ms?: number): Promise<void>;
  close(): void;
}

function stream(port: number, path = '/api/events'): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      const waiters: Array<{ re: RegExp; ok: () => void }> = [];
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        for (const w of [...waiters]) {
          if (w.re.test(buf)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.ok();
          }
        }
      });
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => buf,
        waitFor: (re, ms = 3000) =>
          new Promise((ok, bad) => {
            if (re.test(buf)) return ok();
            const t = setTimeout(() => bad(new Error(`no ${re} in: ${buf}`)), ms);
            waiters.push({ re, ok: () => (clearTimeout(t), ok()) });
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
    });
    req.end();
  });
}

describe('Server Sent Events', () => {
  it('sends stream headers and a first comment, then a synced event to every client', async () => {
    const hub = createSseHub();
    const { srv } = await up(undefined, hub);
    const a = await stream(srv.port);
    const b = await stream(srv.port);
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.headers['content-security-policy']).toBe(CSP);
    await a.waitFor(/: connected/);
    await b.waitFor(/: connected/);
    expect(hub.size()).toBe(2);
    const e: SyncedEvent = { at: 123, changedFrom: '2026-10-20', changedTo: '2026-10-21' };
    hub.broadcast(e);
    for (const c of [a, b]) {
      await c.waitFor(/event: synced\ndata: .*\n\n/);
      const m = /event: synced\ndata: (.*)\n\n/.exec(c.text());
      expect(JSON.parse(m?.[1] as string)).toEqual(e);
    }
    a.close();
    b.close();
  });

  it('refuses a bad Host and a POST on the stream path', async () => {
    const { srv } = await up();
    expect((await ask(srv.port, '/api/events', { host: 'evil.example' })).status).toBe(403);
    expect((await ask(srv.port, '/api/events', { method: 'POST' })).status).toBe(405);
  });

  it('sends a heartbeat comment on the configured interval', async () => {
    const hub = createSseHub({ heartbeatMs: 40 });
    const { srv } = await up(undefined, hub);
    const c = await stream(srv.port);
    await c.waitFor(/: heartbeat\n\n[\s\S]*: heartbeat\n\n/);
    c.close();
  });

  it('drops clients that went away', async () => {
    const hub = createSseHub({ heartbeatMs: 30 });
    const { srv } = await up(undefined, hub);
    const a = await stream(srv.port);
    const b = await stream(srv.port);
    await b.waitFor(/: connected/);
    expect(hub.size()).toBe(2);
    a.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.size()).toBe(1);
    hub.broadcast({ at: 1, changedFrom: null, changedTo: null });
    await b.waitFor(/"changedFrom":null/);
    b.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.size()).toBe(0);
  });

  it('closes open streams when the server stops', async () => {
    const { srv } = await up();
    const c = await stream(srv.port);
    await c.waitFor(/: connected/);
    await srv.close();
    running.splice(running.indexOf(srv), 1);
    await new Promise((r) => setTimeout(r, 50));
    await expect(ask(srv.port, '/api/health')).rejects.toBeDefined();
  });

  it('delivers a synced event with the changed days after a real sync pass, and the new data is served', async () => {
    const root = join(work, 'projects');
    const sid = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const file = join(root, '-work-demo', `${sid}.jsonl`);
    const usageSec = (ms: number): number => Math.round((ms - Date.UTC(2026, 9, 1, 10)) / 1000);
    const userSec = (ms: number): number => Math.round((ms - Date.UTC(2026, 9, 1, 9)) / 1000);
    const t = Date.UTC(2026, 9, 20, 4); // 2026-10-20 10:00 in Dhaka
    const first = [userLine(sid, 'u1', userSec(t), {}, '/work/demo'), usageLine(sid, 1, { stop: true, ts: usageSec(t + 60_000), cwd: '/work/demo' })];
    put(file, first);

    const { db } = openAndMigrate(join(env.dir, 'live.db'));
    const hub = createSseHub();
    ensureRollups(db, 'Asia/Dhaka');
    const srv = await startServer({ db, tz: 'Asia/Dhaka', port: 0, hub, syncStatus: () => IDLE, now: () => Date.parse('2026-10-27T06:00:00Z') });
    running.push(srv);
    const client = await stream(srv.port);
    await client.waitFor(/: connected/);

    const sync = createSync({
      db,
      roots: [root],
      watch: false,
      pollMs: 3_600_000,
      ingest: runIngest,
      onPass: (s) => {
        handlePass(db, 'Asia/Dhaka', hub, s);
      },
    });
    await sync.start();
    await client.waitFor(/event: synced/);
    const ev = JSON.parse(/data: (.*)\n/.exec(client.text())?.[1] as string) as SyncedEvent;
    expect(ev.changedFrom).toBe('2026-10-20');
    expect(ev.changedTo).toBe('2026-10-20');
    expect(typeof ev.at).toBe('number');
    const s1 = JSON.parse((await ask(srv.port, '/api/summary')).text) as { messages: number; prompts: number };
    expect([s1.prompts, s1.messages]).toEqual([1, 2]);

    // A later pass that appends a line on another day.
    const second = usageLine(sid, 2, { stop: true, ts: usageSec(t + 25 * HOUR), cwd: '/work/demo' });
    put(file, [...first, second]);
    sync.trigger('cli');
    await client.waitFor(/"changedFrom":"2026-10-21"/);
    const s2 = JSON.parse((await ask(srv.port, '/api/summary')).text) as { messages: number; responses: number };
    expect([s2.responses, s2.messages]).toEqual([2, 3]);
    // A pass that finds nothing new sends nothing.
    const before = client.text();
    sync.trigger('cli');
    await new Promise((r) => setTimeout(r, 150));
    expect(client.text()).toBe(before);
    client.close();
    await sync.stop();
    db.close();
  });
});
