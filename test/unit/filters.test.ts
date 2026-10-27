import { describe, expect, it } from 'vitest';
import { BadRequest, MAX_RANGE_DAYS, parseDayParam, parseMetric, parsePaging, parseQuery, type QueryEnv } from '../../src/metrics/filters.ts';
import { dayBounds } from '../../src/metrics/time.ts';

const env: QueryEnv = { tz: 'Asia/Dhaka', today: '2026-10-27', archiveStart: '2026-09-01' };
const p = (s: string) => new URLSearchParams(s);

describe('parseQuery', () => {
  it('defaults to archive start through today, everything included, no background', () => {
    const q = parseQuery(p(''), env);
    expect(q).toMatchObject({ from: '2026-09-01', to: '2026-10-27', models: [], projects: [], includeSubagents: true, includeBackground: false });
    expect(q.startMs).toBe(dayBounds('2026-09-01', 'Asia/Dhaka')[0]);
    expect(q.endMs).toBe(dayBounds('2026-10-27', 'Asia/Dhaka')[1]);
  });

  it('uses today for both ends when the archive is empty', () => {
    const q = parseQuery(p(''), { ...env, archiveStart: null });
    expect([q.from, q.to]).toEqual(['2026-10-27', '2026-10-27']);
  });

  it('never defaults from past to', () => {
    const q = parseQuery(p('to=2026-08-01'), env);
    expect([q.from, q.to]).toEqual(['2026-08-01', '2026-08-01']);
  });

  it('reads lists, trimming, dropping empties and repeats', () => {
    const q = parseQuery(p('models=a, b,,a&models=c&projects=/x/y'), env);
    expect(q.models).toEqual(['a', 'b', 'c']);
    expect(q.projects).toEqual(['/x/y']);
  });

  it('matches project keys exactly, keeping a trailing space in a folder name', () => {
    const q = parseQuery(p('projects=' + encodeURIComponent('/Users/x/Desktop/Client Site ') + '&models=' + encodeURIComponent(' claude-x ')), env);
    expect(q.projects).toEqual(['/Users/x/Desktop/Client Site ']);
    expect(q.models).toEqual(['claude-x']);
  });

  it('reads the flags', () => {
    const q = parseQuery(p('includeSubagents=0&includeBackground=1'), env);
    expect([q.includeSubagents, q.includeBackground]).toEqual([false, true]);
    const d = parseQuery(p('includeSubagents=1&includeBackground=0'), env);
    expect([d.includeSubagents, d.includeBackground]).toEqual([true, false]);
  });

  it.each([
    ['from=2026-02-30', /from.*valid/],
    ['to=yesterday', /to.*valid/],
    ['from=2026-10-27&to=2026-10-01', /after/],
    ['includeSubagents=yes', /includeSubagents/],
    ['includeBackground=2', /includeBackground/],
    ['from=2026-01-01&from=2026-01-02', /more than once/],
    ['from=1969-12-31', /from.*valid/],
    ['to=3000-01-01', /to.*valid/],
    ['from=9999-12-01&to=9999-12-31', /valid/],
    [`from=2000-01-01&to=${'2026-10-27'}`, /ten years/],
  ])('rejects %s', (qs, message) => {
    expect(() => parseQuery(p(qs), env)).toThrow(BadRequest);
    expect(() => parseQuery(p(qs), env)).toThrow(message);
  });

  it('rejects a list that is too long', () => {
    const many = Array.from({ length: 201 }, (_, i) => `m${i}`).join(',');
    expect(() => parseQuery(p(`models=${many}`), env)).toThrow(BadRequest);
  });

  it('accepts the longest allowed range', () => {
    expect(MAX_RANGE_DAYS).toBe(3660);
    expect(() => parseQuery(p('from=2017-01-01&to=2026-10-27'), env)).not.toThrow();
  });

  it('writes error messages without dashes', () => {
    for (const qs of ['from=zzz', 'to=zzz', 'from=2026-10-27&to=2026-10-01', 'includeSubagents=x', 'from=2000-01-01']) {
      try {
        parseQuery(p(qs), env);
      } catch (e) {
        expect((e as Error).message).not.toMatch(/[-\u2013\u2014]/);
      }
    }
  });
});

describe('other parameters', () => {
  it('parses metric, with a fallback', () => {
    expect(parseMetric(p(''), 'tokens')).toBe('tokens');
    expect(parseMetric(p('metric=sessions'), 'tokens')).toBe('sessions');
    expect(parseMetric(p('metric=cost'), 'tokens')).toBe('cost');
    expect(() => parseMetric(p('metric=price'), 'tokens')).toThrow(BadRequest);
  });

  it('requires a valid date for the day endpoint', () => {
    expect(parseDayParam(p('date=2026-10-27'))).toBe('2026-10-27');
    expect(() => parseDayParam(p(''))).toThrow(/required/);
    expect(() => parseDayParam(p('date=2026-99-01'))).toThrow(BadRequest);
  });

  it('parses paging', () => {
    expect(parsePaging(p(''))).toEqual({ page: 1, pageSize: 50, sort: 'start' });
    expect(parsePaging(p('page=3&pageSize=10&sort=active'))).toEqual({ page: 3, pageSize: 10, sort: 'active' });
    for (const bad of ['page=0', 'page=x', 'pageSize=0', 'pageSize=201', 'sort=name', 'page=-1', 'pageSize=1.5']) {
      expect(() => parsePaging(p(bad))).toThrow(BadRequest);
    }
  });
});
