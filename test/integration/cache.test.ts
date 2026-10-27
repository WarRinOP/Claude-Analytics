import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleApi, type ApiDeps } from '../../src/server/routes.ts';
import { createQueryCache } from '../../src/metrics/cache.ts';
import { rebuildAll, resolvePromptModels } from '../../src/metrics/rollups.ts';
import { startServer, type RunningServer } from '../../src/server/http.ts';
import { createSseHub } from '../../src/server/sse.ts';
import { HOUR, IDLE, seeder, type Seeder } from '../unit/metricsHelpers.ts';
import { useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

const DHAKA = 'Asia/Dhaka';
const NOW = Date.parse('2026-10-27T06:00:00Z');

function archive(): Seeder {
  const s = seeder(env.dir, DHAKA);
  const t0 = Date.parse('2026-10-20T03:00:00Z');
  s.prompt('A', t0, { cwd: '/work/a' });
  s.response('A', t0 + 60_000, { model: 'claude-opus-5-5', cwd: '/work/a' });
  s.response('A', t0 + 2 * HOUR, { cwd: '/work/a', tools: 2 });
  s.response('A', t0 + 2 * HOUR + 1000, { sub: true, tools: 1 });
  s.prompt('B', t0 + 30 * HOUR, { cwd: '/work/b' });
  s.response('B', t0 + 30 * HOUR + 5000, { cwd: '/work/b' });
  resolvePromptModels(s.db);
  rebuildAll(s.db, DHAKA);
  return s;
}

const PATHS = [
  '/api/summary',
  '/api/summary?models=claude-opus-5-5',
  '/api/summary?projects=-work-a&includeSubagents=0',
  '/api/projects',
  '/api/sessions',
  '/api/sessions?sort=tokens&page=1&pageSize=1',
  '/api/hours?metric=sessions',
  '/api/heatmap?metric=sessions',
  '/api/daily?metric=sessions',
  '/api/day?date=2026-10-20',
  '/api/health',
];

function answer(deps: ApiDeps, target: string): string {
  const [path, qs = ''] = target.split('?') as [string, string?];
  const r = handleApi(deps, path, new URLSearchParams(qs));
  expect(r.status).toBe(200);
  return JSON.stringify(r.body);
}

describe('answer cache', () => {
  it('gives exactly the answers of the uncached queries, on the first and on every later request', () => {
    const s = archive();
    const plain: ApiDeps = { ...s.ctx, now: () => NOW, syncStatus: () => IDLE };
    const cached: ApiDeps = { ...plain, cache: createQueryCache() };
    for (const p of PATHS) {
      const want = answer(plain, p);
      expect(answer(cached, p)).toBe(want);
      expect(answer(cached, p)).toBe(want);
    }
    expect(cached.cache?.size()).toBeGreaterThan(0);
  });

  it('is not changed by callers that sort the session list they get', () => {
    const s = archive();
    const deps: ApiDeps = { ...s.ctx, now: () => NOW, syncStatus: () => IDLE, cache: createQueryCache() };
    const first = answer(deps, '/api/sessions?sort=tokens');
    answer(deps, '/api/sessions?sort=active');
    answer(deps, '/api/day?date=2026-10-20');
    expect(answer(deps, '/api/sessions?sort=tokens')).toBe(first);
  });

  it('keeps an answer until it is cleared, then reads the new facts', () => {
    const s = archive();
    const deps: ApiDeps = { ...s.ctx, now: () => NOW, syncStatus: () => IDLE, cache: createQueryCache() };
    const before = JSON.parse(answer(deps, '/api/summary')) as { sessions: number };
    expect(before.sessions).toBe(2);
    s.response('C', Date.parse('2026-10-22T03:00:00Z'), { cwd: '/work/c' });
    rebuildAll(s.db, DHAKA);
    // The session count comes from the fact tables, which are cached.
    expect((JSON.parse(answer(deps, '/api/summary')) as { sessions: number }).sessions).toBe(2);
    deps.cache?.clear();
    expect((JSON.parse(answer(deps, '/api/summary')) as { sessions: number }).sessions).toBe(3);
  });

  it('is cleared when the server announces a synced event', async () => {
    const s = archive();
    const hub = createSseHub();
    const srv: RunningServer = await startServer({ db: s.db, tz: DHAKA, port: 0, hub, syncStatus: () => IDLE, now: () => NOW });
    try {
      const ask = async (): Promise<number> => ((await (await fetch(`${srv.url}/api/summary`)).json()) as { sessions: number }).sessions;
      expect(await ask()).toBe(2);
      s.response('C', Date.parse('2026-10-22T03:00:00Z'), { cwd: '/work/c' });
      rebuildAll(s.db, DHAKA);
      expect(await ask()).toBe(2);
      hub.broadcast({ at: NOW, changedFrom: '2026-10-22', changedTo: '2026-10-22' });
      expect(await ask()).toBe(3);
    } finally {
      await srv.close();
    }
  });
});

describe('createQueryCache', () => {
  it('computes once per key until the time limit passes', () => {
    let t = 0;
    const c = createQueryCache({ ttlMs: 1000, now: () => t });
    let n = 0;
    const get = (): number => c.get('k', () => ++n);
    expect([get(), get()]).toEqual([1, 1]);
    t = 999;
    expect(get()).toBe(1);
    t = 1000;
    expect(get()).toBe(2);
  });

  it('drops the least recently used entry beyond its size, and everything on clear', () => {
    const c = createQueryCache({ maxEntries: 2 });
    c.get('a', () => 1);
    c.get('b', () => 2);
    c.get('a', () => 99); // a is now the newest
    c.get('c', () => 3); // b goes
    expect(c.size()).toBe(2);
    expect(c.get('a', () => 99)).toBe(1);
    expect(c.get('b', () => 4)).toBe(4);
    c.clear();
    expect(c.size()).toBe(0);
  });
});
