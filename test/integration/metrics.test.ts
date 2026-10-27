import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Daily, DayDetail, Definitions, Filters, Health, Heatmap, Hours, Models, Projects, Sessions, Summary } from '../../src/api/types.ts';
import { DEFINITIONS } from '../../src/metrics/definitions.ts';
import { ensureRollups, getMeta, rebuildAll, resolvePromptModels } from '../../src/metrics/rollups.ts';
import { addDays, dayBounds, daysInRange } from '../../src/metrics/time.ts';
import { handleApi } from '../../src/server/routes.ts';
import { upsertCostSnapshot } from '../../src/store/repo.ts';
import { HOUR, IDLE, MIN, seeder, shapeErrors, type Seeder, type Shape } from '../unit/metricsHelpers.ts';
import { useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

const DHAKA = 'Asia/Dhaka';
const NY = 'America/New_York';

// Local wall clock time on a local day, for zones without a change on that day.
const local = (day: string, hh: number, mm = 0, tz = DHAKA): number => dayBounds(day, tz)[0] + hh * HOUR + mm * MIN;

function finish(s: Seeder): Seeder {
  resolvePromptModels(s.db);
  rebuildAll(s.db, s.ctx.tz);
  return s;
}

const TOK = 1160; // 10 + 100 + 1000 + 50, the default response

// The reference archive (all times Asia/Dhaka local):
//   2026-10-20  session A (/work/a): p1 09:00, R1 opus 09:01, p2 14:00, R2 sonnet 14:01, R3 sonnet 14:02 (2 tools),
//               S1 subagent sonnet 14:03 (1 tool)
//   2026-10-21  session B (/work/b): p3 23:30, R4 opus 23:31
//   2026-10-22  session A: R5 sonnet 00:30
function rich(zone = DHAKA): Seeder {
  const s = seeder(env.dir, zone);
  const t = (day: string, hh: number, mm = 0) => local(day, hh, mm);
  s.prompt('A', t('2026-10-20', 9), { cwd: '/work/a' });
  s.response('A', t('2026-10-20', 9, 1), { model: 'claude-opus-5-5', cwd: '/work/a' });
  s.prompt('A', t('2026-10-20', 14), { cwd: '/work/a' });
  s.response('A', t('2026-10-20', 14, 1), { cwd: '/work/a' });
  s.response('A', t('2026-10-20', 14, 2), { cwd: '/work/a', tools: 2 });
  s.response('A', t('2026-10-20', 14, 3), { sub: true, tools: 1 });
  s.prompt('B', t('2026-10-21', 23, 30), { cwd: '/work/b' });
  s.response('B', t('2026-10-21', 23, 31), { model: 'claude-opus-5-5', cwd: '/work/b' });
  s.response('A', t('2026-10-22', 0, 30), { cwd: '/work/a' });
  return finish(s);
}

const body = <T>(s: Seeder, path: string): T => {
  const r = s.get(path);
  if (r.status !== 200) throw new Error(`${path} gave ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
};

// ---------------------------------------------------------------- the contract

const tokenTotals: Shape = { input: 'int', output: 'int', cacheRead: 'int', cacheWrite: 'int', total: 'int' };
const range: Shape = { from: 'string', to: 'string', days: 'int', tz: 'string', archiveStart: { nullable: 'string' }, coverageGap: 'boolean', completeFrom: { nullable: 'string' }, partialGap: 'boolean' };
const SHAPES: Record<string, Shape> = {
  summary: {
    range,
    sessions: 'int',
    prompts: 'int',
    responses: 'int',
    messages: 'int',
    tokens: tokenTotals,
    backgroundTokens: { nullable: tokenTotals },
    cost: { usd: 'number', backgroundUsd: { nullable: 'number' }, unpricedResponses: 'int', priceTableDate: 'string' },
    activeDays: 'int',
    peakHour: { nullable: { hour: 'int', messages: 'int' } },
    peakDay: { nullable: { day: 'string', messages: 'int' } },
    favoriteModel: { nullable: { model: 'string', tokens: 'int' } },
    longestSession: { nullable: { sessionId: 'string', projectKey: 'string', displayName: 'string', title: { nullable: 'string' }, activeMs: 'int', wallMs: 'int' } },
    currentStreak: 'int',
    longestStreak: { nullable: { days: 'int', from: 'string', to: 'string' } },
    generatedAt: 'int',
  },
  heatmap: {
    range,
    metric: 'string',
    gridFrom: 'string',
    gridTo: 'string',
    cells: [{ day: 'string', value: 'number', beforeArchive: 'boolean', partial: 'boolean', afterToday: 'boolean' }],
    thresholds: ['number'],
  },
  day: {
    day: 'string',
    sessions: [{ sessionId: 'string', projectKey: 'string', displayName: 'string', title: { nullable: 'string' }, firstTs: 'int', lastTs: 'int', messages: 'int', tokens: 'int', costUsd: 'number' }],
  },
  daily: { range, metric: 'string', models: ['string'], days: [{ day: 'string', total: 'number', byModel: { record: 'number' }, partial: 'boolean' }] },
  hours: { range, metric: 'string', hours: [{ hour: 'int', value: 'number' }] },
  models: {
    range,
    rows: [{ model: 'string', responses: 'int', input: 'int', output: 'int', cacheRead: 'int', cacheWrite: 'int', total: 'int', share: 'number', favorite: 'boolean', costUsd: { nullable: 'number' }, costShare: 'number' }],
    background: [{ model: 'string', sessions: 'int', input: 'int', output: 'int', cacheRead: 'int', cacheWrite: 'int', total: 'int', costUsd: 'number' }],
  },
  projects: {
    range,
    rows: [{ projectKey: 'string', displayName: 'string', projectDir: 'string', aliases: ['string'], sessions: 'int', messages: 'int', tokens: 'int', lastActiveTs: { nullable: 'int' }, costUsd: 'number' }],
  },
  sessions: {
    range,
    total: 'int',
    page: 'int',
    pageSize: 'int',
    rows: [
      {
        sessionId: 'string',
        projectKey: 'string',
        displayName: 'string',
        title: { nullable: 'string' },
        firstTs: 'int',
        lastTs: 'int',
        activeMs: 'int',
        wallMs: 'int',
        prompts: 'int',
        responses: 'int',
        tokens: 'int',
        models: ['string'],
        hasSubagents: 'boolean',
        sourceDeleted: 'boolean',
        costUsd: 'number',
      },
    ],
  },
  filters: { models: ['string'], projects: [{ projectKey: 'string', displayName: 'string', aliases: ['string'] }], tz: 'string', archiveStart: { nullable: 'string' }, completeFrom: { nullable: 'string' }, today: 'string' },
  health: {
    status: 'string',
    appVersion: 'string',
    tz: 'string',
    archiveStart: { nullable: 'string' },
    sync: { running: 'boolean', lastPassAt: { nullable: 'int' }, lastSuccessAt: { nullable: 'int' }, lastError: { nullable: 'string' }, watcherAlive: 'boolean' },
    files: { active: 'int', deleted: 'int' },
    sessions: { total: 'int', sourceDeleted: 'int' },
    errors: { total: 'int' },
    dbBytes: 'int',
    completeFrom: { nullable: 'string' },
    retentionDays: 'int',
    sourceRoot: 'string',
    lastPass: { nullable: { at: 'int', durationMs: 'int', trigger: 'string', filesScanned: 'int', filesChanged: 'int', linesRead: 'int', errors: 'int' } },
    recentErrors: [{ file: 'string', lineNo: { nullable: 'int' }, byteOffset: { nullable: 'int' }, error: 'string', at: 'int' }],
    unknownTypes: [{ type: 'string', version: 'string', count: 'int', lastSeenAt: 'int' }],
    missingFields: [{ field: 'string', version: 'string', count: 'int' }],
    versions: [{ version: 'string', responses: 'int', firstTs: 'int', lastTs: 'int' }],
    entrypoints: [{ entrypoint: 'string', responses: 'int' }],
    aliases: [{ aliasDir: 'string', targetDir: 'string' }],
    costCheck: { sessionsWithSnapshot: 'int', compared: 'int', withinOnePercent: 'int', exceptions: [{ sessionId: 'string', ours: 'int', theirs: 'int', percent: 'number' }] },
    canary: { status: 'string', message: 'string' },
    prices: { tableDate: 'string', unpricedModels: [{ model: 'string', responses: 'int' }], cacheWriteRemainderEvents: 'int' },
  },
  definitions: { definitions: [{ id: 'string', term: 'string', text: 'string' }] },
};

const CALLS: Array<[string, string]> = [
  ['summary', '/api/summary'],
  ['summary', '/api/summary?includeBackground=1&includeSubagents=0&models=claude-opus-5-5&projects=/work/a&from=2026-10-20&to=2026-10-22'],
  ['heatmap', '/api/heatmap'],
  ['heatmap', '/api/heatmap?metric=tokens&models=claude-opus-5-5'],
  ['heatmap', '/api/heatmap?metric=sessions'],
  ['heatmap', '/api/heatmap?metric=cost&projects=/work/a'],
  ['day', '/api/day?date=2026-10-20'],
  ['day', '/api/day?date=2026-01-01'],
  ['daily', '/api/daily'],
  ['daily', '/api/daily?metric=messages&from=2026-10-19&to=2026-10-23'],
  ['daily', '/api/daily?metric=sessions'],
  ['daily', '/api/daily?metric=tokens&hideCacheRead=1'],
  ['daily', '/api/daily?metric=cost'],
  ['hours', '/api/hours'],
  ['hours', '/api/hours?metric=tokens'],
  ['hours', '/api/hours?metric=cost&includeSubagents=0'],
  ['hours', '/api/hours?metric=sessions&projects=/work/b'],
  ['models', '/api/models'],
  ['models', '/api/models?includeBackground=1'],
  ['projects', '/api/projects'],
  ['sessions', '/api/sessions'],
  ['sessions', '/api/sessions?page=2&pageSize=1&sort=tokens'],
  ['sessions', '/api/sessions?page=9'],
  ['filters', '/api/filters'],
  ['health', '/api/health'],
  ['definitions', '/api/definitions'],
];

describe('every endpoint returns exactly the contract shape', () => {
  it('on the reference archive', () => {
    const s = rich();
    for (const [name, path] of CALLS) {
      const r = s.get(path);
      expect(r.status, path).toBe(200);
      expect(shapeErrors(r.body, SHAPES[name] as Shape), path).toEqual([]);
    }
  });

  it('on an empty archive, with nulls and zeros where nothing exists', () => {
    const s = finish(seeder(env.dir, DHAKA));
    for (const [name, path] of CALLS) {
      const r = s.get(path);
      expect(r.status, path).toBe(200);
      expect(shapeErrors(r.body, SHAPES[name] as Shape), path).toEqual([]);
    }
    const sum = body<Summary>(s, '/api/summary');
    expect(sum).toMatchObject({ sessions: 0, messages: 0, activeDays: 0, peakHour: null, peakDay: null, favoriteModel: null, longestSession: null, currentStreak: 0, longestStreak: null });
    expect(sum.range).toMatchObject({ archiveStart: null, coverageGap: false, completeFrom: null, partialGap: false, days: 1 });
    expect(sum.tokens.total).toBe(0);
  });

  it('answers every contract path and refuses unknown ones with 404', () => {
    const s = rich();
    for (const name of Object.keys(SHAPES)) {
      const extra = name === 'day' ? '?date=2026-10-20' : '';
      expect(s.get(`/api/${name}${extra}`).status, name).toBe(200);
    }
    expect(s.get('/api/nothing').status).toBe(404);
    expect(s.get('/api/events').status).toBe(404); // the stream is handled by the server, not the router
  });

  it('keeps error texts free of dashes', () => {
    const s = rich();
    for (const bad of ['?from=x', '?from=2026-10-22&to=2026-10-20', '?includeBackground=7', '?metric=x', '?sort=x', '?date=x']) {
      for (const p of ['summary', 'heatmap', 'sessions', 'day']) {
        const r = s.get(`/api/${p}${bad}`);
        if (r.status === 400) expect((r.body as { error: string }).error).not.toMatch(/[-\u2013\u2014]/);
      }
    }
  });
});

describe('bad parameters give 400 with an error sentence', () => {
  const bad = [
    '/api/summary?from=2026-13-01',
    '/api/summary?to=abc',
    '/api/summary?from=2026-10-22&to=2026-10-20',
    '/api/summary?includeSubagents=maybe',
    '/api/summary?includeBackground=yes',
    '/api/heatmap?metric=price',
    '/api/daily?hideCacheRead=2',
    '/api/hours?metric=',
    '/api/day',
    '/api/day?date=2026-02-30',
    '/api/sessions?page=0',
    '/api/sessions?pageSize=500',
    '/api/sessions?sort=name',
    '/api/models?from=2000-01-01',
  ];
  it.each(bad)('%s', (path) => {
    const s = rich();
    const r = s.get(path);
    if (path === '/api/hours?metric=') {
      expect(r.status).toBe(200); // an empty value means the default
      return;
    }
    expect(r.status).toBe(400);
    const e = r.body as { error: unknown };
    expect(typeof e.error).toBe('string');
    expect(Object.keys(r.body as object)).toEqual(['error']);
  });
});

// ---------------------------------------------------------------- numbers on the reference archive

describe('summary numbers', () => {
  it('counts what the reference archive holds', () => {
    const s = rich();
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.range).toEqual({ from: '2026-10-20', to: '2026-10-27', days: 8, tz: DHAKA, archiveStart: '2026-10-20', coverageGap: false, completeFrom: '2026-10-20', partialGap: false });
    expect(sum).toMatchObject({ sessions: 2, prompts: 3, responses: 5, messages: 8, activeDays: 3 });
    expect(sum.tokens).toEqual({ input: 60, output: 600, cacheRead: 6000, cacheWrite: 300, total: 6 * TOK });
    expect(sum.backgroundTokens).toBeNull();
    expect(sum.peakHour).toEqual({ hour: 14, messages: 3 });
    expect(sum.peakDay).toEqual({ day: '2026-10-20', messages: 5 });
    expect(sum.favoriteModel).toEqual({ model: 'claude-sonnet-5-5', tokens: 4 * TOK });
    expect(sum.generatedAt).toBe(Date.parse('2026-10-27T06:00:00Z'));
  });

  it('counts subagent file events as tokens but not as responses or messages', () => {
    const s = rich();
    expect(body<Summary>(s, '/api/summary?includeSubagents=0').tokens.total).toBe(5 * TOK);
    expect(body<Summary>(s, '/api/summary?includeSubagents=0').responses).toBe(5);
    expect(body<Summary>(s, '/api/summary').responses).toBe(5);
  });

  it('counts a sidechain line in a main file as tokens, not as a response', () => {
    const s = seeder(env.dir, DHAKA);
    s.response('A', local('2026-10-20', 10), { side: true });
    s.response('A', local('2026-10-20', 10, 1));
    finish(s);
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.responses).toBe(1);
    expect(sum.tokens.total).toBe(2 * TOK);
  });

  it('ignores tool results, meta, compaction summaries and sidechain prompts', () => {
    const s = seeder(env.dir, DHAKA);
    s.prompt('A', local('2026-10-20', 10));
    for (const kind of ['tool_result', 'meta', 'compact_summary'] as const) s.prompt('A', local('2026-10-20', 10, 1), { kind });
    s.prompt('A', local('2026-10-20', 10, 2), { side: true });
    finish(s);
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.prompts).toBe(1);
    expect(sum.messages).toBe(1);
  });

  it('reports the longest session with its project, title, active and wall time', () => {
    const s = rich();
    s.db.prepare("INSERT INTO session_titles (session_id, source, title, updated_at) VALUES ('A', 'ai', 'Fix the chart', 1)").run();
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.longestSession).toEqual({
      sessionId: 'A',
      projectKey: '/work/a',
      displayName: 'a',
      title: 'Fix the chart',
      activeMs: 4 * MIN,
      wallMs: local('2026-10-22', 0, 30) - local('2026-10-20', 9),
    });
  });
});

describe('D26 local days', () => {
  it('buckets an event at 2026-10-26T18:30:00Z on local day 2026-10-27 in Asia/Dhaka', () => {
    const s = seeder(env.dir, DHAKA);
    s.response('A', Date.parse('2026-10-26T18:30:00Z'));
    finish(s);
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.peakDay).toEqual({ day: '2026-10-27', messages: 1 });
    expect(sum.range.archiveStart).toBe('2026-10-27');
    expect(sum.peakHour).toEqual({ hour: 0, messages: 1 });
    const same = seeder(env.dir, 'UTC');
    same.response('A', Date.parse('2026-10-26T18:30:00Z'));
    finish(same);
    expect(body<Summary>(same, '/api/summary').peakDay).toEqual({ day: '2026-10-26', messages: 1 });
  });
});

describe('D27 daylight saving: America/New_York around 2026-11-01', () => {
  // One response every 30 minutes from 2026-10-31 00:00 EDT up to (not including) 2026-11-03 00:00 EST.
  function dstArchive(): Seeder {
    const s = seeder(env.dir, NY, Date.parse('2026-11-04T12:00:00Z'));
    const start = dayBounds('2026-10-31', NY)[0];
    const end = dayBounds('2026-11-02', NY)[1];
    let i = 0;
    for (let ts = start; ts < end; ts += 30 * MIN) s.response(`s${Math.floor(i++ / 4)}`, ts);
    return finish(s);
  }

  it('has a 25 hour day with 50 messages, between two 24 hour days with 48', () => {
    const s = dstArchive();
    const d = body<Daily>(s, '/api/daily?metric=messages&from=2026-10-31&to=2026-11-02');
    expect(d.days.map((x) => [x.day, x.total])).toEqual([
      ['2026-10-31', 48],
      ['2026-11-01', 50],
      ['2026-11-02', 48],
    ]);
    expect(d.range.days).toBe(3);
    expect(body<Summary>(s, '/api/summary').messages).toBe(146);
  });

  it('shows no missing and no doubled hour: each hour has the same count except the repeated hour 1', () => {
    const s = dstArchive();
    const h = body<Hours>(s, '/api/hours?from=2026-10-31&to=2026-11-02');
    expect(h.hours).toHaveLength(24);
    expect(h.hours.map((x) => x.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(h.hours.map((x) => x.value)).toEqual(Array.from({ length: 24 }, (_, i) => (i === 1 ? 8 : 6)));
    expect(h.hours.reduce((a, x) => a + x.value, 0)).toBe(146);
  });

  it('draws a heatmap with one cell per calendar day and the right value on the 25 hour day', () => {
    const s = dstArchive();
    const m = body<Heatmap>(s, '/api/heatmap?metric=messages&from=2026-10-31&to=2026-11-02');
    expect(m.cells).toHaveLength(371);
    expect(m.gridTo).toBe('2026-11-08');
    expect(m.gridFrom).toBe('2025-11-03'); // the Monday 52 weeks before the Monday of the last week
    const days = m.cells.map((c) => c.day);
    expect(days).toEqual(daysInRange(m.gridFrom, m.gridTo));
    expect(new Set(days).size).toBe(371);
    expect(m.cells.find((c) => c.day === '2026-11-01')?.value).toBe(50);
    expect(m.cells.find((c) => c.day === '2026-10-31')?.value).toBe(48);
    expect(m.cells.find((c) => c.day === '2026-11-03')?.value).toBe(0);
  });

  it('counts sessions per day without losing the extra hour', () => {
    const s = dstArchive();
    const d = body<Daily>(s, '/api/daily?metric=sessions&from=2026-10-31&to=2026-11-02');
    // 4 responses per session, 2 hours of activity each: 24 hour day has 12 sessions, the 25 hour day 12.5 so 13 touched.
    expect(d.days.map((x) => x.total)).toEqual([12, 13, 13]);
    expect(body<Summary>(s, '/api/summary').sessions).toBe(37);
  });
});

describe('D28 time zone change', () => {
  it('rebuilds the rollups, and All time totals are equal in every zone', () => {
    const s = rich();
    const a = body<Summary>(s, '/api/summary');
    expect(getMeta(s.db, 'rollup_tz')).toBe(DHAKA);
    const rowsDhaka = s.db.prepare('SELECT day, hour FROM activity_rollup ORDER BY day, hour').all();

    expect(ensureRollups(s.db, 'America/Los_Angeles')).toBe(true);
    expect(getMeta(s.db, 'rollup_tz')).toBe('America/Los_Angeles');
    expect(s.db.prepare('SELECT day, hour FROM activity_rollup ORDER BY day, hour').all()).not.toEqual(rowsDhaka);

    const b = handleApi({ ...s.ctx, tz: 'America/Los_Angeles', syncStatus: () => IDLE }, '/api/summary', new URLSearchParams()).body as Summary;
    expect(b.range.tz).toBe('America/Los_Angeles');
    for (const k of ['sessions', 'prompts', 'responses', 'messages'] as const) expect(b[k], k).toBe(a[k]);
    expect(b.tokens).toEqual(a.tokens);
    expect(b.favoriteModel).toEqual(a.favoriteModel);
    expect(b.peakDay).not.toEqual(a.peakDay); // days move with the zone, totals do not
    expect(ensureRollups(s.db, 'America/Los_Angeles')).toBe(false);
  });

  it('rebuilds when the totals no longer match the facts', () => {
    const s = rich();
    s.db.prepare('DELETE FROM activity_rollup WHERE day = ?').run('2026-10-21');
    expect(ensureRollups(s.db, DHAKA)).toBe(true);
    expect(ensureRollups(s.db, DHAKA)).toBe(false);
    expect(body<Summary>(s, '/api/summary').messages).toBe(8);
  });
});

describe('D29 active time', () => {
  it('adds only gaps of at most 30 minutes: gaps of 10, 45 and 5 minutes give 15 minutes', () => {
    const s = seeder(env.dir, DHAKA);
    const t = local('2026-10-20', 10);
    s.prompt('A', t);
    s.response('A', t + 10 * MIN);
    s.response('A', t + 55 * MIN);
    s.response('A', t + 60 * MIN);
    finish(s);
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.longestSession?.activeMs).toBe(15 * MIN);
    expect(sum.longestSession?.wallMs).toBe(60 * MIN);
    const row = body<Sessions>(s, '/api/sessions').rows[0];
    expect([row?.activeMs, row?.wallMs, row?.prompts, row?.responses]).toEqual([15 * MIN, 60 * MIN, 1, 3]);
  });

  it('counts a gap of exactly 30 minutes and not one millisecond more', () => {
    const s = seeder(env.dir, DHAKA);
    const t = local('2026-10-20', 10);
    s.response('A', t);
    s.response('A', t + 30 * MIN);
    s.response('B', t);
    s.response('B', t + 30 * MIN + 1);
    finish(s);
    const rows = body<Sessions>(s, '/api/sessions?pageSize=10').rows;
    expect(rows.find((r) => r.sessionId === 'A')?.activeMs).toBe(30 * MIN);
    expect(rows.find((r) => r.sessionId === 'B')?.activeMs).toBe(0);
  });

  it('counts only events inside the range', () => {
    const s = seeder(env.dir, DHAKA);
    s.response('A', local('2026-10-20', 23, 50));
    s.response('A', local('2026-10-21', 0, 10));
    s.response('A', local('2026-10-21', 0, 20));
    finish(s);
    const both = body<Sessions>(s, '/api/sessions').rows[0];
    expect(both?.activeMs).toBe(30 * MIN);
    const day2 = body<Sessions>(s, '/api/sessions?from=2026-10-21&to=2026-10-21').rows[0];
    expect([day2?.activeMs, day2?.wallMs, day2?.firstTs]).toEqual([10 * MIN, 10 * MIN, local('2026-10-21', 0, 10)]);
    const day1 = body<Sessions>(s, '/api/sessions?from=2026-10-20&to=2026-10-20').rows[0];
    expect([day1?.activeMs, day1?.wallMs]).toEqual([0, 0]);
  });

  it('lets subagent file events fill a gap, unless subagents are excluded', () => {
    const s = seeder(env.dir, DHAKA);
    const t = local('2026-10-20', 10);
    s.response('A', t);
    s.response('A', t + 25 * MIN, { sub: true });
    s.response('A', t + 50 * MIN);
    finish(s);
    expect(body<Sessions>(s, '/api/sessions').rows[0]?.activeMs).toBe(50 * MIN);
    expect(body<Sessions>(s, '/api/sessions?includeSubagents=0').rows[0]?.activeMs).toBe(0);
  });
});

describe('D30 streaks', () => {
  function days(list: string[], now: string): Seeder {
    const s = seeder(env.dir, DHAKA, Date.parse(`${now}T06:00:00Z`));
    list.forEach((d, i) => s.response(`s${i}`, local(d, 12)));
    return finish(s);
  }
  const streakDays = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-25', '2026-10-26'];

  it('counts back from yesterday while today has no activity, and finds the longest run over gaps', () => {
    const s = days(streakDays, '2026-10-27');
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.currentStreak).toBe(2);
    expect(sum.longestStreak).toEqual({ days: 4, from: '2026-10-20', to: '2026-10-23' });
    expect(sum.activeDays).toBe(9);
  });

  it('counts back from today once today has activity', () => {
    const s = days([...streakDays, '2026-10-27'], '2026-10-27');
    expect(body<Summary>(s, '/api/summary').currentStreak).toBe(3);
  });

  it('is zero when neither today nor yesterday has activity', () => {
    const s = days(streakDays, '2026-10-28');
    expect(body<Summary>(s, '/api/summary').currentStreak).toBe(0);
    const t = days(streakDays, '2026-10-29');
    expect(body<Summary>(t, '/api/summary').currentStreak).toBe(0);
  });

  it('takes the earlier run when two runs are equally long', () => {
    const s = days(['2026-10-01', '2026-10-02', '2026-10-10', '2026-10-11'], '2026-10-27');
    expect(body<Summary>(s, '/api/summary').longestStreak).toEqual({ days: 2, from: '2026-10-01', to: '2026-10-02' });
  });

  it('stays inside the range', () => {
    const s = days(streakDays, '2026-10-27');
    const sum = body<Summary>(s, '/api/summary?from=2026-10-21&to=2026-10-26');
    expect(sum.longestStreak).toEqual({ days: 3, from: '2026-10-21', to: '2026-10-23' });
    expect(sum.currentStreak).toBe(2);
    const past = body<Summary>(s, '/api/summary?from=2026-10-01&to=2026-10-24');
    expect(past.currentStreak).toBe(0); // 2026-10-24 has no activity and is not today
    const ends = body<Summary>(s, '/api/summary?from=2026-10-01&to=2026-10-23');
    expect(ends.currentStreak).toBe(4);
  });
});

describe('D31 model filter', () => {
  it('filters prompts by their attributed model and tokens and responses exactly', () => {
    const s = rich();
    const opus = body<Summary>(s, '/api/summary?models=claude-opus-5-5');
    expect(opus).toMatchObject({ prompts: 2, responses: 2, messages: 4, sessions: 2 });
    expect(opus.tokens.total).toBe(2 * TOK);
    const sonnet = body<Summary>(s, '/api/summary?models=claude-sonnet-5-5');
    expect(sonnet).toMatchObject({ prompts: 1, responses: 3, messages: 4, sessions: 1 });
    expect(sonnet.tokens.total).toBe(4 * TOK);
    const none = body<Summary>(s, '/api/summary?models=claude-haiku-5-5');
    expect(none).toMatchObject({ prompts: 0, responses: 0, messages: 0, sessions: 0 });
    expect(none.tokens.total).toBe(0);
    expect(none.favoriteModel).toBeNull();
  });

  it('adds up: the slices of every model equal the unfiltered totals', () => {
    const s = rich();
    const all = body<Summary>(s, '/api/summary');
    const slices = ['claude-opus-5-5', 'claude-sonnet-5-5'].map((m) => body<Summary>(s, `/api/summary?models=${m}`));
    for (const k of ['prompts', 'responses', 'messages'] as const) expect(slices.reduce((a, x) => a + x[k], 0), k).toBe(all[k]);
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) expect(slices.reduce((a, x) => a + x.tokens[k], 0), k).toBe(all.tokens[k]);
    // Both models together equal the unfiltered view too.
    expect(body<Summary>(s, '/api/summary?models=claude-opus-5-5,claude-sonnet-5-5')).toMatchObject({ messages: all.messages, responses: all.responses });
  });

  it('drops a prompt that has no model yet as soon as a model filter is set', () => {
    const s = seeder(env.dir, DHAKA);
    s.prompt('A', local('2026-10-20', 9));
    s.response('A', local('2026-10-20', 9, 1));
    s.prompt('A', local('2026-10-20', 10)); // no response after it
    finish(s);
    expect(body<Summary>(s, '/api/summary').prompts).toBe(2);
    expect(body<Summary>(s, '/api/summary?models=claude-sonnet-5-5').prompts).toBe(1);
    const d = body<Daily>(s, '/api/daily?metric=messages');
    expect(d.models).toEqual(['claude-sonnet-5-5', '(unattributed)']);
    expect(d.days[0]?.byModel).toEqual({ 'claude-sonnet-5-5': 2, '(unattributed)': 1 });
  });

  it('filters the Models table, the daily series, the hours and the day strip the same way', () => {
    const s = rich();
    const m = body<Models>(s, '/api/models?models=claude-opus-5-5');
    expect(m.rows.map((r) => r.model)).toEqual(['claude-opus-5-5']);
    expect(m.rows[0]?.share).toBe(1);
    const d = body<Daily>(s, '/api/daily?models=claude-opus-5-5');
    expect(d.models).toEqual(['claude-opus-5-5']);
    expect(body<Hours>(s, '/api/hours?models=claude-opus-5-5').hours.filter((h) => h.value > 0).map((h) => h.hour)).toEqual([9, 23]);
    const day = body<DayDetail>(s, '/api/day?date=2026-10-20&models=claude-opus-5-5');
    expect(day.sessions).toHaveLength(1);
    expect(day.sessions[0]).toMatchObject({ sessionId: 'A', messages: 2, tokens: TOK });
  });

  it('filters by project and by subagent files', () => {
    const s = rich();
    expect(body<Summary>(s, '/api/summary?projects=/work/b')).toMatchObject({ sessions: 1, prompts: 1, responses: 1 });
    expect(body<Summary>(s, '/api/summary?projects=/work/a').tokens.total).toBe(5 * TOK);
    expect(body<Summary>(s, '/api/summary?projects=/work/a&includeSubagents=0').tokens.total).toBe(4 * TOK);
    expect(body<Summary>(s, '/api/summary?projects=/work/a,/work/b').tokens.total).toBe(6 * TOK);
    expect(body<Summary>(s, '/api/summary?projects=/nowhere').messages).toBe(0);
  });
});

describe('slices add up for every additive metric', () => {
  const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];
  const PROJECTS = ['/work/a', '/work/b'];

  const sumDaily = (d: Daily): number[] => d.days.map((x) => x.total);
  const sumCells = (h: Heatmap): number[] => h.cells.map((c) => c.value);
  const sumHours = (h: Hours): number[] => h.hours.map((x) => x.value);
  const plus = (lists: number[][]): number[] => (lists[0] as number[]).map((_, i) => lists.reduce((a, l) => a + (l[i] as number), 0));

  it.each([
    ['models', MODELS],
    ['projects', PROJECTS],
  ])('per %s slices equal the unfiltered numbers day by day, cell by cell and hour by hour', (param, values) => {
    const s = rich();
    for (const metric of ['messages', 'tokens']) {
      const slices = (path: string, pick: (b: never) => number[]) => plus(values.map((v) => pick(body(s, `${path}${path.includes('?') ? '&' : '?'}${param}=${v}`))));
      expect(slices(`/api/daily?metric=${metric}`, sumDaily as never), `daily ${metric}`).toEqual(sumDaily(body<Daily>(s, `/api/daily?metric=${metric}`)));
      expect(slices(`/api/heatmap?metric=${metric}`, sumCells as never), `heatmap ${metric}`).toEqual(sumCells(body<Heatmap>(s, `/api/heatmap?metric=${metric}`)));
      expect(slices(`/api/hours?metric=${metric}`, sumHours as never), `hours ${metric}`).toEqual(sumHours(body<Hours>(s, `/api/hours?metric=${metric}`)));
    }
    const all = body<Summary>(s, '/api/summary');
    const parts = values.map((v) => body<Summary>(s, `/api/summary?${param}=${v}`));
    expect(parts.reduce((a, x) => a + x.messages, 0)).toBe(all.messages);
    expect(parts.reduce((a, x) => a + x.tokens.total, 0)).toBe(all.tokens.total);
    const rows = values.map((v) => body<Models>(s, `/api/models?${param}=${v}`).rows.reduce((a, r) => a + r.responses, 0));
    expect(rows.reduce((a, n) => a + n, 0)).toBe(all.responses);
    if (param === 'projects') {
      const projects = body<Projects>(s, '/api/projects').rows;
      expect(projects.reduce((a, r) => a + r.tokens, 0)).toBe(all.tokens.total);
      expect(projects.reduce((a, r) => a + r.messages, 0)).toBe(all.messages);
    }
  });

  it('adds up the session count over projects, but not over models (a session can use several)', () => {
    const s = rich();
    const all = body<Summary>(s, '/api/summary');
    expect(PROJECTS.reduce((a, p) => a + body<Summary>(s, `/api/summary?projects=${p}`).sessions, 0)).toBe(all.sessions);
    const perModel = MODELS.map((m) => body<Summary>(s, `/api/summary?models=${m}`).sessions);
    expect(perModel.reduce((a, n) => a + n, 0)).toBeGreaterThan(all.sessions); // session A used both models
  });
});

describe('D32 favorite model ties', () => {
  function two(a: { model: string; n: number; each: number }, b: { model: string; n: number; each: number }): Summary {
    const s = seeder(env.dir, DHAKA);
    let i = 0;
    for (const x of [a, b]) for (let k = 0; k < x.n; k++) s.response('A', local('2026-10-20', 10) + i++ * MIN, { model: x.model, input: x.each, output: 0, cacheRead: 0, cacheWrite: 0 });
    finish(s);
    return body<Summary>(s, '/api/summary');
  }

  it('prefers the larger token count', () => {
    expect(two({ model: 'm-a', n: 1, each: 900 }, { model: 'm-b', n: 5, each: 150 }).favoriteModel).toEqual({ model: 'm-a', tokens: 900 });
  });

  it('breaks a token tie by the number of responses', () => {
    expect(two({ model: 'm-a', n: 1, each: 1000 }, { model: 'm-b', n: 2, each: 500 }).favoriteModel).toEqual({ model: 'm-b', tokens: 1000 });
    expect(two({ model: 'm-a', n: 4, each: 250 }, { model: 'm-b', n: 2, each: 500 }).favoriteModel).toEqual({ model: 'm-a', tokens: 1000 });
  });

  it('breaks a tie of both by name', () => {
    expect(two({ model: 'm-b', n: 2, each: 500 }, { model: 'm-a', n: 2, each: 500 }).favoriteModel?.model).toBe('m-a');
  });

  it('marks the favorite in the Models table and orders rows by tokens, responses, name', () => {
    const s = seeder(env.dir, DHAKA);
    let i = 0;
    for (const [m, n, each] of [['m-c', 1, 1000], ['m-b', 2, 500], ['m-a', 2, 500], ['m-z', 1, 1]] as const) {
      for (let k = 0; k < n; k++) s.response('A', local('2026-10-20', 10) + i++ * MIN, { model: m, input: each, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
    finish(s);
    const rows = body<Models>(s, '/api/models').rows;
    expect(rows.map((r) => r.model)).toEqual(['m-a', 'm-b', 'm-c', 'm-z']);
    expect(rows.map((r) => r.favorite)).toEqual([true, false, false, false]);
    expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1, 10);
  });
});

describe('D33 coverage', () => {
  it('flags a range that starts before the archive and not one that starts on its first day', () => {
    const s = rich();
    const before = body<Summary>(s, '/api/summary?from=2026-10-01');
    expect(before.range).toMatchObject({ from: '2026-10-01', archiveStart: '2026-10-20', coverageGap: true, days: 27 });
    expect(body<Summary>(s, '/api/summary?from=2026-10-20').range.coverageGap).toBe(false);
    expect(body<Summary>(s, '/api/summary?from=2026-10-21').range.coverageGap).toBe(false);
    // Totals of the gap days are zero but the flag says they are unknown, not zero.
    expect(before.messages).toBe(8);
  });

  it('marks heatmap cells before the archive and after today', () => {
    const s = rich();
    const m = body<Heatmap>(s, '/api/heatmap?from=2026-10-01');
    const cell = (d: string) => m.cells.find((c) => c.day === d);
    expect(cell('2026-10-19')).toMatchObject({ beforeArchive: true, partial: false, afterToday: false, value: 0 });
    expect(cell('2026-10-20')).toMatchObject({ beforeArchive: false, value: 5 });
    expect(cell('2026-10-27')).toMatchObject({ beforeArchive: false, afterToday: false });
    expect(cell('2026-10-28')).toMatchObject({ afterToday: true });
    expect(m.range.coverageGap).toBe(true);
  });

  it('reports the archive start in Filters and Health', () => {
    const s = rich();
    expect(body<Filters>(s, '/api/filters')).toMatchObject({ archiveStart: '2026-10-20', completeFrom: '2026-10-20', today: '2026-10-27', tz: DHAKA });
    expect(body<Health>(s, '/api/health').archiveStart).toBe('2026-10-20');
  });
});

describe('heatmap', () => {
  it('spans 53 weeks Monday to Sunday ending in the week of `to`', () => {
    const s = rich();
    const m = body<Heatmap>(s, '/api/heatmap');
    expect(m.gridTo).toBe('2026-11-01'); // Sunday of the week of 2026-10-27
    expect(m.gridFrom).toBe('2025-10-27'); // 53 weeks of 7 days
    expect(m.cells).toHaveLength(371);
    expect(new Date(`${m.gridFrom}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${m.gridTo}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it('grows to the whole range when the range is longer than 53 weeks', () => {
    const s = seeder(env.dir, DHAKA);
    s.response('A', local('2024-01-10', 10));
    s.response('A', local('2026-10-20', 10));
    finish(s);
    const m = body<Heatmap>(s, '/api/heatmap');
    expect(m.range.from).toBe('2024-01-10');
    expect(m.gridFrom).toBe('2024-01-08'); // the Monday of that week
    expect(m.cells[0]?.day).toBe('2024-01-08');
    expect(m.cells.length % 7).toBe(0);
    expect(m.cells.find((c) => c.day === '2024-01-10')?.value).toBe(1);
  });

  it('keeps cells before `from` for context and leaves cells after `to` empty', () => {
    const s = rich();
    const m = body<Heatmap>(s, '/api/heatmap?from=2026-10-21&to=2026-10-21');
    expect(m.cells.find((c) => c.day === '2026-10-20')?.value).toBe(5);
    expect(m.cells.find((c) => c.day === '2026-10-22')?.value).toBe(0);
    expect(m.cells.find((c) => c.day === '2026-10-21')?.value).toBe(2);
  });

  it('gives four ascending cut points from the non zero values', () => {
    const s = seeder(env.dir, DHAKA);
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    counts.forEach((n, i) => {
      for (let k = 0; k < n; k++) s.response(`s${i}`, local(addDays('2026-10-10', i), 10) + k * MIN);
    });
    finish(s);
    const m = body<Heatmap>(s, '/api/heatmap');
    expect(m.thresholds).toEqual([3, 5, 8, 10]);
    expect(m.thresholds).toHaveLength(4);
    expect([...m.thresholds].sort((a, b) => a - b)).toEqual(m.thresholds);
    const empty = body<Heatmap>(finish(seeder(env.dir, DHAKA)), '/api/heatmap');
    expect(empty.thresholds).toEqual([1, 2, 3, 4]);
    expect(empty.cells.every((c) => c.value === 0 && c.beforeArchive)).toBe(true);
  });

  it('honours the metric', () => {
    const s = rich();
    const cell = (path: string, d: string) => body<Heatmap>(s, path).cells.find((c) => c.day === d)?.value;
    expect(cell('/api/heatmap?metric=messages', '2026-10-20')).toBe(5);
    expect(cell('/api/heatmap?metric=tokens', '2026-10-20')).toBe(4 * TOK);
    expect(cell('/api/heatmap?metric=sessions', '2026-10-20')).toBe(1);
    expect(cell('/api/heatmap?metric=sessions', '2026-10-22')).toBe(1);
  });
});

describe('daily and hours', () => {
  it('lists every day of the range with zeros, series by total descending, and slices adding up', () => {
    const s = rich();
    const d = body<Daily>(s, '/api/daily?from=2026-10-19&to=2026-10-23');
    expect(d.days.map((x) => x.day)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
    expect(d.models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(d.days.map((x) => x.total)).toEqual([0, 4 * TOK, TOK, TOK, 0]);
    expect(d.days[1]?.byModel).toEqual({ 'claude-sonnet-5-5': 3 * TOK, 'claude-opus-5-5': TOK });
    for (const day of d.days) expect(Object.values(day.byModel).reduce((a, n) => a + n, 0)).toBe(day.total);
    expect(d.days[0]?.byModel).toEqual({ 'claude-sonnet-5-5': 0, 'claude-opus-5-5': 0 });
  });

  it('hides cache reads on request', () => {
    const s = rich();
    const d = body<Daily>(s, '/api/daily?hideCacheRead=1');
    expect(d.days.find((x) => x.day === '2026-10-20')?.total).toBe(4 * (TOK - 1000));
  });

  it('counts messages per model and sessions as one total per day', () => {
    const s = rich();
    const m = body<Daily>(s, '/api/daily?metric=messages');
    expect(m.days.find((x) => x.day === '2026-10-20')?.total).toBe(5);
    expect(m.days.find((x) => x.day === '2026-10-20')?.byModel).toEqual({ 'claude-sonnet-5-5': 3, 'claude-opus-5-5': 2 });
    const ss = body<Daily>(s, '/api/daily?metric=sessions');
    expect(ss.models).toEqual([]);
    expect(ss.days.map((x) => x.total).slice(-8)).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
    expect(ss.days.every((x) => Object.keys(x.byModel).length === 0)).toBe(true);
  });

  it('gives 24 hours with the right values for every metric', () => {
    const s = rich();
    const msgs = body<Hours>(s, '/api/hours').hours.filter((h) => h.value > 0);
    expect(msgs).toEqual([
      { hour: 0, value: 1 },
      { hour: 9, value: 2 },
      { hour: 14, value: 3 },
      { hour: 23, value: 2 },
    ]);
    expect(body<Hours>(s, '/api/hours?metric=tokens').hours.filter((h) => h.value > 0).map((h) => [h.hour, h.value])).toEqual([
      [0, TOK],
      [9, TOK],
      [14, 3 * TOK],
      [23, TOK],
    ]);
    expect(body<Hours>(s, '/api/hours?metric=sessions').hours.filter((h) => h.value > 0).map((h) => [h.hour, h.value])).toEqual([
      [0, 1],
      [9, 1],
      [14, 1],
      [23, 1],
    ]);
  });
});

describe('models, projects, sessions, day strip', () => {
  it('builds the Models table with shares', () => {
    const s = rich();
    const m = body<Models>(s, '/api/models');
    expect(m.rows).toEqual([
      { model: 'claude-sonnet-5-5', responses: 3, input: 40, output: 400, cacheRead: 4000, cacheWrite: 200, total: 4 * TOK, share: (4 * TOK) / (6 * TOK), favorite: true, costUsd: 0.00516, costShare: 5160000 / 10320000 },
      { model: 'claude-opus-5-5', responses: 2, input: 20, output: 200, cacheRead: 2000, cacheWrite: 100, total: 2 * TOK, share: (2 * TOK) / (6 * TOK), favorite: false, costUsd: 0.00516, costShare: 5160000 / 10320000 },
    ]);
    expect(m.background).toEqual([]);
  });

  it('builds the Projects table', () => {
    const s = rich();
    s.db.prepare("INSERT INTO project_aliases (alias_dir, target_dir, seen_at) VALUES ('-work-alias', '-work-demo', 1)").run();
    const p = body<Projects>(s, '/api/projects');
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toEqual({
      projectKey: '/work/a',
      displayName: 'a',
      projectDir: '-work-demo',
      aliases: ['-work-alias'],
      sessions: 1,
      messages: 6,
      tokens: 5 * TOK,
      lastActiveTs: local('2026-10-22', 0, 30),
      costUsd: 0.00774,
    });
    expect(p.rows[1]).toMatchObject({ projectKey: '/work/b', sessions: 1, messages: 2, tokens: TOK, lastActiveTs: local('2026-10-21', 23, 31), costUsd: 0.00258 });
    expect(body<Projects>(s, '/api/projects?from=2026-10-21&to=2026-10-21').rows.map((r) => r.projectKey)).toEqual(['/work/b']);
  });

  it('lists sessions with paging and the three sort orders', () => {
    const s = rich();
    const all = body<Sessions>(s, '/api/sessions');
    expect(all).toMatchObject({ total: 2, page: 1, pageSize: 50 });
    expect(all.rows.map((r) => r.sessionId)).toEqual(['B', 'A']); // start descending: B started 10-21, A on 10-20
    expect(body<Sessions>(s, '/api/sessions?sort=tokens').rows.map((r) => r.sessionId)).toEqual(['A', 'B']);
    expect(body<Sessions>(s, '/api/sessions?sort=active').rows.map((r) => r.sessionId)).toEqual(['A', 'B']);
    const p1 = body<Sessions>(s, '/api/sessions?pageSize=1&page=1&sort=tokens');
    const p2 = body<Sessions>(s, '/api/sessions?pageSize=1&page=2&sort=tokens');
    expect([p1.rows[0]?.sessionId, p2.rows[0]?.sessionId, p1.total, p2.total]).toEqual(['A', 'B', 2, 2]);
    expect(body<Sessions>(s, '/api/sessions?page=3&pageSize=1').rows).toEqual([]);
    const a = all.rows.find((r) => r.sessionId === 'A');
    expect(a).toMatchObject({
      projectKey: '/work/a',
      displayName: 'a',
      title: null,
      prompts: 2,
      responses: 4,
      tokens: 5 * TOK,
      activeMs: 4 * MIN,
      hasSubagents: false,
      sourceDeleted: false,
    });
    expect(a?.models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('flags sessions whose source files are all deleted, and sessions with subagent files', () => {
    const s = rich();
    s.db.prepare("INSERT INTO source_files (dev, ino, path, project_dir, session_id, agent_id, is_subagent, size, mtime_ms, status, first_seen_at) VALUES (9, 1, '/x/A.jsonl', '-work-demo', 'A', NULL, 0, 1, 1, 'deleted', 1)").run();
    s.db.prepare("INSERT INTO source_files (dev, ino, path, project_dir, session_id, agent_id, is_subagent, size, mtime_ms, status, first_seen_at) VALUES (9, 2, '/x/B.jsonl', '-work-demo', 'B', NULL, 0, 1, 1, 'deleted', 1)").run();
    s.db.prepare("INSERT INTO source_files (dev, ino, path, project_dir, session_id, agent_id, is_subagent, size, mtime_ms, status, first_seen_at) VALUES (9, 3, '/x/B2.jsonl', '-work-demo', 'B', NULL, 0, 1, 1, 'active', 1)").run();
    s.db.prepare("UPDATE sessions SET has_subagents = 1 WHERE session_id = 'A'").run();
    const rows = body<Sessions>(s, '/api/sessions').rows;
    expect(rows.find((r) => r.sessionId === 'A')).toMatchObject({ sourceDeleted: true, hasSubagents: true });
    expect(rows.find((r) => r.sessionId === 'B')?.sourceDeleted).toBe(false);
    expect(body<Health>(s, '/api/health')).toMatchObject({ files: { active: 3, deleted: 2 }, sessions: { total: 2, sourceDeleted: 1 } });
  });

  it('shows the sessions of one day as a strip, honouring the day bounds', () => {
    const s = rich();
    const d = body<DayDetail>(s, '/api/day?date=2026-10-20');
    expect(d.day).toBe('2026-10-20');
    expect(d.sessions).toEqual([
      { sessionId: 'A', projectKey: '/work/a', displayName: 'a', title: null, firstTs: local('2026-10-20', 9), lastTs: local('2026-10-20', 14, 3), messages: 5, tokens: 4 * TOK, costUsd: 0.00645 },
    ]);
    // 00:30 on 2026-10-22 belongs to that day, not to the evening before in UTC.
    expect(body<DayDetail>(s, '/api/day?date=2026-10-22').sessions.map((x) => [x.sessionId, x.messages])).toEqual([['A', 1]]);
    expect(body<DayDetail>(s, '/api/day?date=2026-10-21').sessions.map((x) => [x.sessionId, x.messages])).toEqual([['B', 2]]);
    expect(body<DayDetail>(s, '/api/day?date=2026-10-19').sessions).toEqual([]);
  });

  it('lists models and projects for the filter menus', () => {
    const s = rich();
    s.db.prepare("INSERT INTO project_aliases (alias_dir, target_dir, seen_at) VALUES ('-work-alias', '-work-demo', 1)").run();
    const f = body<Filters>(s, '/api/filters');
    expect(f.models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(f.projects.map((p) => p.projectKey)).toEqual(['/work/a', '/work/b']);
    expect(f.projects[0]?.aliases).toEqual(['-work-alias']);
  });
});

describe('background calls', () => {
  function withSnapshot(): Seeder {
    const s = rich();
    upsertCostSnapshot(
      s.db,
      {
        kind: 'cost_snapshot',
        sessionId: 'A',
        startTime: null,
        totalDuration: 5,
        totalCostUSD: null,
        modelUsage: {
          'claude-haiku-5-5': { inputTokens: 400, outputTokens: 100, thinkingTokens: 0, cacheReadInputTokens: 1000, cacheCreationInputTokens: 500, webSearchRequests: 0, costUSD: 0 },
          'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, webSearchRequests: 0, costUSD: 0 },
        },
      },
      null,
    );
    return s;
  }

  it('stays out unless asked for, then adds to the Models table and the token KPI', () => {
    const s = withSnapshot();
    expect(body<Models>(s, '/api/models').background).toEqual([]);
    expect(body<Summary>(s, '/api/summary').backgroundTokens).toBeNull();
    expect(body<Summary>(s, '/api/summary').tokens.total).toBe(6 * TOK);

    const m = body<Models>(s, '/api/models?includeBackground=1');
    expect(m.background).toEqual([{ model: 'claude-haiku-5-5', sessions: 1, input: 400, output: 100, cacheRead: 1000, cacheWrite: 500, total: 2000, costUsd: 0 }]);
    expect(m.rows.map((r) => r.model)).not.toContain('claude-haiku-5-5');
    const sum = body<Summary>(s, '/api/summary?includeBackground=1');
    expect(sum.backgroundTokens).toEqual({ input: 400, output: 100, cacheRead: 1000, cacheWrite: 500, total: 2000 });
    expect(sum.tokens).toEqual({ input: 460, output: 700, cacheRead: 7000, cacheWrite: 800, total: 6 * TOK + 2000 });
    expect(sum.favoriteModel?.model).toBe('claude-sonnet-5-5');
  });

  it('places the session on the local day of its first event and honours range and filters', () => {
    const s = withSnapshot();
    expect(body<Models>(s, '/api/models?includeBackground=1&from=2026-10-20&to=2026-10-20').background).toHaveLength(1);
    expect(body<Models>(s, '/api/models?includeBackground=1&from=2026-10-21').background).toEqual([]);
    expect(body<Models>(s, '/api/models?includeBackground=1&projects=/work/b').background).toEqual([]);
    expect(body<Models>(s, '/api/models?includeBackground=1&projects=/work/a').background).toHaveLength(1);
    expect(body<Models>(s, '/api/models?includeBackground=1&models=claude-opus-5-5').background).toEqual([]);
    expect(body<Models>(s, '/api/models?includeBackground=1&models=claude-haiku-5-5').background).toHaveLength(1);
    expect(body<Summary>(s, '/api/summary?includeBackground=1&from=2026-10-21').backgroundTokens?.total).toBe(0);
  });
});

describe('health and definitions', () => {
  it('reports sync status and degrades on a sync error', () => {
    const s = rich();
    const ok = body<Health>(s, '/api/health');
    expect(ok.status).toBe('ok');
    expect(ok.sync).toEqual({ running: false, lastPassAt: null, lastSuccessAt: null, lastError: null, watcherAlive: true });
    expect(ok.dbBytes).toBeGreaterThan(0);
    const r = handleApi({ ...s.ctx, syncStatus: () => ({ ...IDLE, lastError: 'boom' }) }, '/api/health', new URLSearchParams());
    expect((r.body as Health).status).toBe('degraded');
    expect((r.body as Health).sync.lastError).toBe('boom');
  });

  it('serves the definitions list', () => {
    const s = rich();
    expect(body<Definitions>(s, '/api/definitions').definitions).toEqual(DEFINITIONS);
  });
});
