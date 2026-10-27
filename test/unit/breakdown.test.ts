// Plan section 16: the calendar of the breakdown ledger. Pure functions on local day strings, so they hold in every zone;
// the zones and daylight saving changes are exercised end to end in test/integration/breakdown.test.ts.
import { describe, expect, it } from 'vitest';
import { clippedSpan, parsePeriod, periodKey, periodLabel, periodSpan, spanIsPartial } from '../../src/metrics/breakdown.ts';
import { BadRequest } from '../../src/metrics/filters.ts';
import { weekdayMonday0 } from '../../src/metrics/time.ts';

describe('period keys', () => {
  it('a month is YYYY-MM', () => {
    expect(periodKey('month', '2026-10-27')).toBe('2026-10');
    expect(periodKey('month', '2026-10-01')).toBe('2026-10');
    expect(periodKey('month', '2026-10-31')).toBe('2026-10');
    expect(periodKey('month', '2026-11-01')).toBe('2026-11');
  });

  it('a week is named by its Monday, and Sunday belongs to the week that ends on it', () => {
    expect(weekdayMonday0('2026-10-26')).toBe(0); // the calendar of this build: 26 Oct 2026 is a Monday
    expect(periodKey('week', '2026-10-26')).toBe('2026-10-26');
    expect(periodKey('week', '2026-10-27')).toBe('2026-10-26');
    expect(periodKey('week', '2026-11-01')).toBe('2026-10-26'); // Sunday
    expect(periodKey('week', '2026-11-02')).toBe('2026-11-02'); // next Monday
  });

  it('weeks cross month and year ends and leap days', () => {
    expect(periodKey('week', '2027-01-01')).toBe('2026-12-28');
    expect(periodKey('week', '2026-12-31')).toBe('2026-12-28');
    expect(periodKey('week', '2028-02-29')).toBe('2028-02-28');
    expect(periodKey('week', '2028-03-01')).toBe('2028-02-28');
  });

  it('a day is itself', () => {
    expect(periodKey('day', '2026-10-27')).toBe('2026-10-27');
  });
});

describe('period spans', () => {
  it('a month runs from the 1st to its last day, leap years included', () => {
    expect(periodSpan('month', '2026-10')).toEqual(['2026-10-01', '2026-10-31']);
    expect(periodSpan('month', '2026-02')).toEqual(['2026-02-01', '2026-02-28']);
    expect(periodSpan('month', '2028-02')).toEqual(['2028-02-01', '2028-02-29']);
    expect(periodSpan('month', '2026-12')).toEqual(['2026-12-01', '2026-12-31']);
    expect(periodSpan('month', '2026-04')).toEqual(['2026-04-01', '2026-04-30']);
  });

  it('a week runs Monday to Sunday and a day is one day', () => {
    expect(periodSpan('week', '2026-10-26')).toEqual(['2026-10-26', '2026-11-01']);
    expect(periodSpan('week', '2026-12-28')).toEqual(['2026-12-28', '2027-01-03']);
    expect(periodSpan('day', '2026-10-27')).toEqual(['2026-10-27', '2026-10-27']);
  });
});

describe('labels', () => {
  it('writes October 2026, Week of 26 Oct 2026 and Tue 27 Oct 2026', () => {
    expect(periodLabel('month', '2026-10')).toBe('October 2026');
    expect(periodLabel('week', '2026-10-26')).toBe('Week of 26 Oct 2026');
    expect(periodLabel('day', '2026-10-27')).toBe('Tue 27 Oct 2026');
  });

  it('does not pad the day of the month, and names every month and weekday', () => {
    expect(periodLabel('day', '2026-10-05')).toBe('Mon 5 Oct 2026');
    expect(periodLabel('week', '2026-03-02')).toBe('Week of 2 Mar 2026');
    expect(periodLabel('month', '2026-01')).toBe('January 2026');
    expect(periodLabel('month', '2026-12')).toBe('December 2026');
    const names = Array.from({ length: 7 }, (_, i) => periodLabel('day', `2026-10-${String(26 + i).padStart(2, '0')}`).slice(0, 3));
    expect(names.slice(0, 6)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(periodLabel('day', '2026-11-01')).toBe('Sun 1 Nov 2026');
  });

  it('uses no dash as punctuation', () => {
    for (const l of [periodLabel('month', '2026-10'), periodLabel('week', '2026-10-26'), periodLabel('day', '2026-10-27')]) expect(l).not.toMatch(/[-–—]/);
  });
});

describe('clipping to the range', () => {
  it('the first and last period of a range are cut to it', () => {
    expect(clippedSpan('month', '2026-09', '2026-09-10', '2026-10-05')).toEqual(['2026-09-10', '2026-09-30']);
    expect(clippedSpan('month', '2026-10', '2026-09-10', '2026-10-05')).toEqual(['2026-10-01', '2026-10-05']);
    expect(clippedSpan('week', '2026-10-05', '2026-10-07', '2026-10-27')).toEqual(['2026-10-07', '2026-10-11']);
    expect(clippedSpan('week', '2026-10-26', '2026-10-07', '2026-10-27')).toEqual(['2026-10-26', '2026-10-27']);
  });

  it('a period inside the range keeps its whole span, and a range inside one period is the range', () => {
    expect(clippedSpan('month', '2026-09', '2026-08-01', '2026-10-31')).toEqual(['2026-09-01', '2026-09-30']);
    expect(clippedSpan('month', '2026-10', '2026-10-12', '2026-10-14')).toEqual(['2026-10-12', '2026-10-14']);
    expect(clippedSpan('day', '2026-10-12', '2026-10-01', '2026-10-31')).toEqual(['2026-10-12', '2026-10-12']);
  });
});

describe('possibly incomplete spans', () => {
  // archive start 2026-09-01, complete from 2026-09-27: 1 to 26 Sep are possibly incomplete
  const hit = (a: string, b: string): boolean => spanIsPartial(a, b, '2026-09-01', '2026-09-27');
  it('a span that touches the window is partial, one outside it is not', () => {
    expect(hit('2026-09-01', '2026-09-30')).toBe(true);
    expect(hit('2026-09-26', '2026-09-26')).toBe(true);
    expect(hit('2026-09-27', '2026-09-27')).toBe(false);
    expect(hit('2026-10-01', '2026-10-31')).toBe(false);
    expect(hit('2026-09-21', '2026-09-27')).toBe(true);
    expect(hit('2026-08-01', '2026-08-31')).toBe(false); // before the archive: unknown, not incomplete
  });

  it('nothing is partial without an archive, or when the archive is complete from its first day', () => {
    expect(spanIsPartial('2026-09-01', '2026-09-30', null, null)).toBe(false);
    expect(spanIsPartial('2026-09-01', '2026-09-30', '2026-09-01', '2026-09-01')).toBe(false);
  });
});

describe('the period parameter', () => {
  const p = (q: string): URLSearchParams => new URLSearchParams(q);
  it('defaults to month and accepts month, week and day', () => {
    expect(parsePeriod(p(''))).toBe('month');
    expect(parsePeriod(p('period='))).toBe('month');
    for (const v of ['month', 'week', 'day'] as const) expect(parsePeriod(p(`period=${v}`))).toBe(v);
  });

  it('refuses anything else, and a repeated parameter', () => {
    for (const bad of ['period=year', 'period=Month', 'period=weeks', 'period=month&period=week']) {
      expect(() => parsePeriod(p(bad)), bad).toThrow(BadRequest);
    }
  });
});
