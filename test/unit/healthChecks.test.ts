// The shared wording of the health report (src/metrics/healthChecks.ts) and the pure table helpers of the dashboard.
import { describe, expect, it } from 'vitest';
import type { Health } from '../../src/api/types.ts';
import {
  COST_CHECK_WHY,
  bytesText,
  clockText,
  dayText,
  durationText,
  errorExplanation,
  healthChecks,
  needsAttention,
  overall,
  placeText,
  stampText,
} from '../../src/metrics/healthChecks.ts';
import { withCode } from '../../web/src/lib/definitions.ts';
import { MODEL_COLUMNS, PAGE_SIZE, localDay, modelTotals, modelValue, nextSort, pageCount, pageRange, projectValue, sortRows, startedBeforeComplete, toggleProject, type ModelRow } from '../../web/src/lib/tables.ts';

const NOW = Date.parse('2026-10-27T12:00:00Z');

function health(over: Partial<Health> = {}): Health {
  return {
    status: 'ok',
    appVersion: '0.0.1',
    tz: 'UTC',
    archiveStart: '2026-09-01',
    sync: { running: false, lastPassAt: NOW - 60_000, lastSuccessAt: NOW - 60_000, lastError: null, watcherAlive: true },
    files: { active: 10, deleted: 0 },
    sessions: { total: 10, sourceDeleted: 0 },
    errors: { total: 0 },
    dbBytes: 1_500_000,
    completeFrom: '2026-09-27',
    retentionDays: 30,
    sourceRoot: '/x/projects',
    lastPass: { at: NOW - 60_000, durationMs: 420, trigger: 'poll', filesScanned: 10, filesChanged: 1, linesRead: 12, errors: 0 },
    recentErrors: [],
    unknownTypes: [],
    missingFields: [],
    versions: [{ version: '2.1.310', responses: 5, firstTs: NOW - 9e6, lastTs: NOW - 1e6 }],
    entrypoints: [{ entrypoint: 'cli', responses: 5 }],
    aliases: [],
    costCheck: { sessionsWithSnapshot: 4, compared: 4, withinOnePercent: 3, exceptions: [] },
    canary: { status: 'ok', message: 'No Claude Code session was updated in the last 10 minutes, so there is nothing to compare with the transcripts.' },
    prices: { tableDate: '2026-10-06', unpricedModels: [], cacheWriteRemainderEvents: 0 },
    ...over,
  };
}

const live = { now: NOW, live: true };
const verdictOf = (h: Health, id: string): string | undefined => healthChecks(h, live).find((c) => c.id === id)?.verdict;

describe('health checks', () => {
  it('a plain healthy answer has no check that needs a look', () => {
    const h = health();
    const checks = healthChecks(h, live);
    expect(checks.map((c) => c.verdict)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(overall(h, checks)).toEqual({ verdict: 'ok', word: 'Healthy' });
    expect(needsAttention(h)).toBe(false);
  });

  it('a failing sync is a problem and degrades the status', () => {
    const h = health({ status: 'degraded', sync: { running: false, lastPassAt: NOW, lastSuccessAt: null, lastError: 'ENOSPC: disk full.', watcherAlive: true } });
    const c = healthChecks(h, live)[0];
    expect(c?.verdict).toBe('problem');
    expect(c?.text).toContain('Sync is failing: ENOSPC: disk full.');
    expect(c?.text).not.toContain('..');
    expect(overall(h, healthChecks(h, live)).word).toBe('Needs attention');
    expect(needsAttention(h)).toBe(true);
  });

  it('a pass older than three minutes is stale for the service, not for the doctor', () => {
    const old = { running: false, lastPassAt: NOW - 600_000, lastSuccessAt: NOW - 600_000, lastError: null, watcherAlive: true };
    const h = health({ sync: old });
    expect(verdictOf(h, 'sync')).toBe('note');
    expect(healthChecks(h, { now: NOW, live: false })[0]?.verdict).toBe('ok');
  });

  it('ingest errors are a note with the count in the sentence', () => {
    const h = health({ errors: { total: 3 } });
    expect(verdictOf(h, 'errors')).toBe('note');
    expect(healthChecks(h, live).find((c) => c.id === 'errors')?.text).toContain('3 problems');
  });

  it('unknown record types are information; a missing token count is a note; optional fields are not', () => {
    const unknown = health({ unknownTypes: [{ type: 'tools-used', version: '2.1.280', count: 3, lastSeenAt: NOW }] });
    expect(verdictOf(unknown, 'types')).toBe('ok');
    expect(healthChecks(unknown, live).find((c) => c.id === 'types')?.text).toContain('tools-used');
    const optional = health({ missingFields: [{ field: 'server_tool_use.web_search_requests', version: '2.1.280', count: 9 }] });
    expect(verdictOf(optional, 'types')).toBe('ok');
    const token = health({ missingFields: [{ field: 'output_tokens', version: '2.1.280', count: 9 }] });
    expect(verdictOf(token, 'types')).toBe('note');
  });

  it('the canary: warning is a problem and the sentence is passed on, unknown is a note', () => {
    const warn = health({ canary: { status: 'warning', message: 'Session abcd1234 was updated in the last 10 minutes, but its transcript has not changed for 14 min.' } });
    const c = healthChecks(warn, live).find((x) => x.id === 'canary');
    expect(c?.verdict).toBe('problem');
    expect(c?.text).toMatch(/^Transcripts may have moved\. Session abcd1234/);
    expect(needsAttention(warn)).toBe(true);
    const unknown = health({ canary: { status: 'unknown', message: 'The folder could not be read.' } });
    expect(verdictOf(unknown, 'canary')).toBe('note');
    expect(needsAttention(unknown)).toBe(false);
  });

  it('the cost record check never alarms and says how many sessions agree', () => {
    const h = health({ costCheck: { sessionsWithSnapshot: 107, compared: 107, withinOnePercent: 90, exceptions: [] } });
    const c = healthChecks(h, live).find((x) => x.id === 'cost');
    expect(c?.verdict).toBe('ok');
    expect(c?.text).toContain('90 of 107 sessions');
    expect(c?.text).toContain('84.1 percent');
    expect(COST_CHECK_WHY).toContain('restarts its counters');
  });

  it('the price check is ok when every model has a price and a note when one has none, never alarming', () => {
    const ok = healthChecks(health(), live).find((x) => x.id === 'prices');
    expect(ok?.verdict).toBe('ok');
    expect(ok?.text).toContain('table of 6 Oct 2026');
    const none = health({ prices: { tableDate: '2026-10-06', unpricedModels: [{ model: 'claude-future-9', responses: 12 }], cacheWriteRemainderEvents: 2 } });
    const c = healthChecks(none, live).find((x) => x.id === 'prices');
    expect(c?.verdict).toBe('note');
    expect(c?.text).toContain('claude-future-9 12 responses');
    expect(c?.text).toContain('never as zero dollars');
    expect(c?.text).toContain('2 responses had cache write parts that did not add up');
    expect(needsAttention(none)).toBe(false);
  });

  it('no sentence the report writes uses a dash as punctuation or an emoji', () => {
    const many = health({
      status: 'degraded',
      sync: { running: true, lastPassAt: NOW, lastSuccessAt: null, lastError: 'boom', watcherAlive: false },
      files: { active: 3, deleted: 2 },
      sessions: { total: 5, sourceDeleted: 1 },
      errors: { total: 2 },
      unknownTypes: [{ type: 'future-thing', version: '9.9.9', count: 1, lastSeenAt: NOW }],
      missingFields: [{ field: 'input_tokens', version: '', count: 1 }],
      canary: { status: 'warning', message: 'x' },
    });
    const texts = [...healthChecks(many, live), ...healthChecks(health(), { now: NOW, live: false })].flatMap((c) => [c.name, c.word, c.text]);
    texts.push(COST_CHECK_WHY, ...['invalid json', 'not an object', 'missing uuid', 'bad timestamp', 'classifier error', 'line too large, skipped', 'cannot read file: EACCES'].map(errorExplanation));
    for (const t of texts) {
      expect(t, t).not.toMatch(/ [-–—] |[–—]/u);
      expect(t, t).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });
});

describe('words and formats', () => {
  it('explains every error code the reader stores', () => {
    expect(errorExplanation('invalid json')).toBe('The line is not valid JSON, so it was skipped.');
    expect(errorExplanation('cannot read file: EACCES')).toBe('The file could not be read (EACCES). The next pass tries again.');
    expect(errorExplanation('something new')).toBe('something new');
  });

  it('places an error in a file', () => {
    expect(placeText(4, 120)).toBe('line 4, byte 120');
    expect(placeText(4, null)).toBe('line 4');
    expect(placeText(null, null)).toBe('whole file');
  });

  it('formats sizes, durations, days and times', () => {
    expect(bytesText(512)).toBe('512 bytes');
    expect(bytesText(1_572_864)).toBe('1.5 MB');
    expect(durationText(420)).toBe('420 ms');
    expect(durationText(4_400)).toBe('4.4 s');
    expect(durationText(150_000)).toBe('3 min');
    expect(dayText('2026-09-05')).toBe('5 Sep 2026');
    expect(stampText(Date.parse('2026-09-05T08:07:06Z'), 'UTC')).toBe('05 Sep 2026 08:07:06');
    expect(clockText(Date.parse('2026-09-05T08:07:06Z'), 'Asia/Dhaka')).toBe('14:07');
  });
});

describe('table helpers', () => {
  const rows = [
    { name: 'b', n: 5 },
    { name: 'a', n: 5 },
    { name: 'c', n: 9 },
  ];

  it('sorts stably in both directions, equal values keep the API order', () => {
    expect(sortRows(rows, (r) => r.n, 'desc').map((r) => r.name)).toEqual(['c', 'b', 'a']);
    expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.name)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, (r) => r.name, 'asc').map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('a header click flips the same column and starts a new one in its natural direction', () => {
    expect(nextSort({ key: 'total', dir: 'desc' }, 'total', 'desc')).toEqual({ key: 'total', dir: 'asc' });
    expect(nextSort({ key: 'total', dir: 'desc' }, 'model', 'asc')).toEqual({ key: 'model', dir: 'asc' });
  });

  it('a project row click sets the filter to that project, and a second click clears it', () => {
    expect(toggleProject([], '/w/a')).toEqual(['/w/a']);
    expect(toggleProject(['/w/b', '/w/a'], '/w/a')).toEqual(['/w/a']);
    expect(toggleProject(['/w/a'], '/w/a')).toEqual([]);
  });

  it('pages of 50', () => {
    expect(PAGE_SIZE).toBe(50);
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(163, 50)).toBe(4);
    expect(pageRange(163, 4, 50)).toEqual({ from: 151, to: 163 });
    expect(pageRange(0, 1, 50)).toEqual({ from: 0, to: 0 });
  });

  it('a session started before the complete from day is marked, by the local day of its start', () => {
    const ts = Date.parse('2026-09-26T23:30:00Z');
    expect(localDay(ts, 'UTC')).toBe('2026-09-26');
    expect(localDay(ts, 'Asia/Dhaka')).toBe('2026-09-27');
    expect(startedBeforeComplete(ts, 'UTC', '2026-09-27')).toBe(true);
    expect(startedBeforeComplete(ts, 'Asia/Dhaka', '2026-09-27')).toBe(false);
    expect(startedBeforeComplete(ts, 'UTC', null)).toBe(false);
  });

  it('definition wording keeps every word and turns backtick marks into code', () => {
    expect(withCode('a `user` record on the `main` thread.')).toEqual(['a ', { code: 'user' }, ' record on the ', { code: 'main' }, ' thread.']);
    expect(withCode('plain')).toEqual(['plain']);
  });
});

describe('cost columns of the tables', () => {
  const row = (model: string, costUsd: number | null, costShare: number): ModelRow => ({ model, responses: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4, share: 0.5, favorite: false, costUsd, costShare });

  it('a model without a price sorts below every priced model, in either direction it stays apart from a cost of zero', () => {
    const rows = [row('a', 0.5, 0.5), row('none', null, 0), row('zero', 0, 0), row('b', 2, 0.5)];
    expect(sortRows(rows, (r) => modelValue(r, 'cost'), 'desc').map((r) => r.model)).toEqual(['b', 'a', 'zero', 'none']);
    expect(sortRows(rows, (r) => modelValue(r, 'costShare'), 'desc').map((r) => r.model)).toEqual(['a', 'b', 'none', 'zero']);
    expect(MODEL_COLUMNS.map((c) => c.key).slice(-2)).toEqual(['cost', 'costShare']);
  });

  it('the total row adds the priced models and counts the unpriced ones', () => {
    const t = modelTotals([row('a', 0.5, 0.2), row('none', null, 0), row('b', 1.25, 0.8)]);
    expect(t.cost).toBe(1.75);
    expect(t.unpriced).toBe(1);
    expect(t.total).toBe(12);
  });

  it('projects sort by cost', () => {
    expect(projectValue({ projectKey: 'k', displayName: 'n', projectDir: '', aliases: [], sessions: 1, messages: 1, tokens: 1, lastActiveTs: null, costUsd: 3.5 }, 'cost')).toBe(3.5);
  });
});
