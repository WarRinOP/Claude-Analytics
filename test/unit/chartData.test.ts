// Pure helpers of the time charts (web/src/lib/chartData.ts and the metric parameters of web/src/lib/filters.ts).
import { describe, expect, it } from 'vitest';
import type { Daily, Heatmap } from '../../src/api/types.ts';
import { bucketDays, bucketSize, buildGrid, FLAG_GAP, heatLevel, metricNoun, moveIndex, OTHER, placeFlags, seriesOf, stepRanges, tallyGroups, valueText, valueWithNoun } from '../../web/src/lib/chartData.ts';
import { coverageText } from '../../web/src/lib/coverage.ts';
import { apiQuery, chartQuery, NO_FILTERS, parseSearch, resetFilters, toSearch } from '../../web/src/lib/filters.ts';
import { addDays, usd, usdAxis, usdCompact, usdExact, usdScale, weekdayIndex } from '../../web/src/lib/format.ts';

// Four Monday first weeks ending the week of 2026-10-27 (a Tuesday). The archive starts on Wed 2026-10-07.
function grid(archiveStart: string, from = '2026-10-05', to = '2026-11-01', today = '2026-10-27', completeFrom: string = archiveStart): Heatmap {
  const cells: Heatmap['cells'] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    cells.push({ day: d, value: d >= archiveStart && d <= today ? 1 : 0, beforeArchive: d < archiveStart, partial: d >= archiveStart && d < completeFrom, afterToday: d > today });
  }
  return {
    range: { from: '2026-10-07', to: today, days: 21, tz: 'UTC', archiveStart, coverageGap: false, completeFrom, partialGap: completeFrom > archiveStart },
    metric: 'messages',
    gridFrom: from,
    gridTo: to,
    cells,
    thresholds: [1, 2, 3, 4],
  };
}

describe('heatLevel', () => {
  it('maps zero to step 0 and the thresholds to inclusive upper bounds', () => {
    const t = [3, 7, 20, 90];
    expect([0, 1, 3, 4, 7, 8, 20, 21, 90].map((v) => heatLevel(v, t))).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
  it('keeps working when quantiles repeat', () => {
    expect([1, 2].map((v) => heatLevel(v, [1, 1, 1, 2]))).toEqual([1, 4]);
  });
});

describe('stepRanges', () => {
  it('lists the values each step stands for', () => {
    expect(stepRanges([3, 7, 20, 90])).toEqual([
      { level: 0, from: 0, to: 0 },
      { level: 1, from: 1, to: 3 },
      { level: 2, from: 4, to: 7 },
      { level: 3, from: 8, to: 20 },
      { level: 4, from: 21, to: 90 },
    ]);
  });
  it('leaves out steps that repeat the cut before them', () => {
    expect(stepRanges([5, 5, 5, 5]).map((s) => s.level)).toEqual([0, 1]);
  });
  it('dollars are continuous: each step runs from the bound before it', () => {
    expect(stepRanges([0.01, 0.5, 2.5, 90.25], true)).toEqual([
      { level: 0, from: 0, to: 0 },
      { level: 1, from: 0, to: 0.01 },
      { level: 2, from: 0.01, to: 0.5 },
      { level: 3, from: 0.5, to: 2.5 },
      { level: 4, from: 2.5, to: 90.25 },
    ]);
    expect(stepRanges([0.2, 0.2, 0.2, 0.2], true).map((s) => s.level)).toEqual([0, 1]);
  });
});

describe('dollars', () => {
  it('writes cents, says under one cent, and keeps the exact value for tooltips and names', () => {
    expect(usd(2606.82420494)).toBe('$2,606.82');
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.01)).toBe('$0.01');
    expect(usd(0.0099)).toBe('<$0.01');
    expect(usd(0.000001)).toBe('<$0.01');
    expect(usdExact(0.004123)).toBe('$0.004123');
    expect(usdExact(2606.82420494)).toBe('$2,606.824205');
    expect(usdCompact(2606.82)).toBe('$2.61K');
  });
  it('axis ticks and scale bounds stay short and distinct', () => {
    expect([0, 5, 0.5, 0.25, 1.5, 1200, 0.001, 0.0005].map(usdAxis)).toEqual(['$0', '$5', '$0.50', '$0.25', '$1.50', '$1.2K', '$0.001', '$0.0005']);
    expect(usdScale(0.034)).toBe('$0.03');
    expect(usdScale(0.0041)).toBe('$0.0041');
    expect(usdScale(12.3456)).toBe('$12.35');
  });
  it('a metric value is text with its unit: dollars carry no noun', () => {
    expect(valueText('cost', 0.5)).toBe('$0.50');
    expect(valueText('tokens', 1160)).toBe('1,160');
    expect(valueWithNoun('cost', 12.5)).toBe('$12.50');
    expect(valueWithNoun('tokens', 1)).toBe('1 token');
    expect(valueWithNoun('messages', 6)).toBe('6 messages');
    expect(metricNoun('cost', 3)).toBe('');
  });
});

describe('buildGrid', () => {
  const g = buildGrid(grid('2026-10-07'));
  it('places a Monday first week in each column and the weekday in the row', () => {
    expect(g.cols).toBe(4);
    expect(g.cells).toHaveLength(28);
    for (const c of g.cells) {
      expect(c.row).toBe(weekdayIndex(c.day));
      expect(c.col).toBe(Math.floor(c.index / 7));
    }
    expect(g.cells[0]?.row).toBe(0);
  });
  it('marks days before the archive and in the future, and keeps real zeros apart from both', () => {
    expect(g.cells.filter((c) => c.state === 'before')).toHaveLength(2);
    expect(g.cells.filter((c) => c.state === 'future').map((c) => c.day)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(g.cells.find((c) => c.day === '2026-10-07')?.state).toBe('value');
    expect(g.lastIndex).toBe(g.cells.findIndex((c) => c.day === '2026-10-27'));
  });
  it('puts the horizon on the archive start day, in its weekday row', () => {
    expect(g.horizon).toEqual({ col: 0, row: 2, day: '2026-10-07' });
  });
  it('has no horizon when the archive starts before the grid or at its first day', () => {
    expect(buildGrid(grid('2026-10-05')).horizon).toBeNull();
    expect(buildGrid(grid('2026-01-01')).horizon).toBeNull();
  });
  it('reports a grid that is all before the archive', () => {
    const none = buildGrid(grid('2027-01-01'));
    expect(none.allBefore).toBe(true);
    expect(none.horizon).toBeNull();
    expect(g.allBefore).toBe(false);
  });
  it('names a month above the week that holds its first day, never a future month, and the year on January', () => {
    const wide = buildGrid(grid('2025-01-01', '2025-12-29', '2026-11-01', '2026-10-27'));
    const names = wide.months.map((m) => m.text);
    expect(names).toContain('Jan 2026');
    expect(names).toContain('Oct');
    expect(names).not.toContain('Nov');
    expect(wide.months.every((m, i, all) => i === 0 || m.col > (all[i - 1]?.col ?? -1))).toBe(true);
  });
});

describe('moveIndex', () => {
  it('moves by day with up and down and by week with left and right, and stops at the ends', () => {
    expect(moveIndex('ArrowDown', 10, 30)).toBe(11);
    expect(moveIndex('ArrowUp', 10, 30)).toBe(9);
    expect(moveIndex('ArrowRight', 10, 30)).toBe(17);
    expect(moveIndex('ArrowLeft', 10, 30)).toBe(3);
    expect(moveIndex('ArrowLeft', 3, 30)).toBe(3);
    expect(moveIndex('ArrowRight', 28, 30)).toBe(28);
    expect(moveIndex('ArrowDown', 30, 30)).toBe(30);
    expect(moveIndex('ArrowUp', 0, 30)).toBe(0);
  });
  it('jumps to the first and last readable day with Home and End', () => {
    expect(moveIndex('Home', 12, 30)).toBe(0);
    expect(moveIndex('End', 12, 30)).toBe(30);
  });
});

describe('tallyGroups', () => {
  it('groups sessions in fives, the remainder last', () => {
    expect(tallyGroups(0)).toEqual([]);
    expect(tallyGroups(1)).toEqual([1]);
    expect(tallyGroups(5)).toEqual([5]);
    expect(tallyGroups(7)).toEqual([5, 2]);
    expect(tallyGroups(12)).toEqual([5, 5, 2]);
  });
});

describe('model series', () => {
  const all = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
  it('gives a model the slot of its place in the all time list, whatever the view holds', () => {
    const wide = seriesOf(['m3', 'm1', 'm2'], all);
    const narrow = seriesOf(['m3'], all);
    expect(wide.find((s) => s.key === 'm3')?.color).toBe('var(--series-3)');
    expect(narrow[0]?.color).toBe('var(--series-3)');
  });
  it('folds everything past six slots, and unattributed prompts, into one grey series', () => {
    const s = seriesOf(['m1', 'm7', 'm8', '(unattributed)'], all);
    expect(s.map((x) => x.key)).toEqual(['m1', OTHER]);
    expect(s[1]?.members).toEqual(['m7', 'm8', '(unattributed)']);
    expect(s[1]?.color).toBe('var(--series-other)');
  });
  it('keeps the name when exactly one model is left over', () => {
    const s = seriesOf(['m1', 'm7'], all);
    expect(s[1]?.key).toBe('m7');
    expect(s[1]?.color).toBe('var(--series-other)');
  });
});

describe('daily buckets', () => {
  const daily: Daily = {
    range: { from: '2026-10-01', to: '2026-10-07', days: 7, tz: 'UTC', archiveStart: '2026-10-03', coverageGap: true, completeFrom: '2026-10-05', partialGap: true },
    metric: 'tokens',
    models: ['a', 'b'],
    days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, total: (i + 1) * 3, byModel: { a: (i + 1) * 2, b: i + 1 }, partial: i + 1 >= 3 && i + 1 < 5 })),
  };
  it('is one bucket per day while the days fit, with the days before the archive flagged', () => {
    const b = bucketDays(daily, 1, '2026-10-03', true);
    expect(b).toHaveLength(7);
    expect(b.map((x) => x.before)).toEqual([true, true, false, false, false, false, false]);
    expect(b[3]?.byModel).toEqual({ a: 8, b: 4 });
  });
  it('adds runs of days up without losing a token', () => {
    const b = bucketDays(daily, 3, '2026-10-03', true);
    expect(b.map((x) => [x.from, x.to, x.days])).toEqual([
      ['2026-10-01', '2026-10-03', 3],
      ['2026-10-04', '2026-10-06', 3],
      ['2026-10-07', '2026-10-07', 1],
    ]);
    expect(b.reduce((n, x) => n + x.total, 0)).toBe(daily.days.reduce((n, d) => n + d.total, 0));
    expect(b[0]?.before).toBe(false); // it holds an archived day
  });
  it('flags a bucket as possibly incomplete when any day in it is', () => {
    expect(bucketDays(daily, 1, '2026-10-03', true).map((x) => x.partial)).toEqual([false, false, true, true, false, false, false]);
    // 3 and 4 Oct are partial: the runs 1 to 3 and 4 to 6 both hold one
    expect(bucketDays(daily, 3, '2026-10-03', true).map((x) => x.partial)).toEqual([true, true, false]);
  });
  it('sizes buckets so each bar is at least 3 px', () => {
    expect(bucketSize(50, 1100)).toBe(1);
    expect(bucketSize(1000, 600)).toBe(5);
  });
});

describe('view parameters in the address', () => {
  it('reads metric and hideCacheRead, falling back to the defaults', () => {
    expect(parseSearch('?metric=tokens&hideCacheRead=1')).toMatchObject({ metric: 'tokens', hideCacheRead: true });
    expect(parseSearch('?metric=bogus')).toMatchObject({ metric: 'messages', hideCacheRead: false });
  });
  it('writes only what differs from the defaults, and never lets the view into the API query', () => {
    const f = { ...NO_FILTERS, metric: 'sessions' as const, hideCacheRead: true, models: ['m1'] };
    expect(toSearch(f)).toBe('?models=m1&metric=sessions&hideCacheRead=1');
    expect(apiQuery(f)).toBe('models=m1');
    expect(toSearch(NO_FILTERS)).toBe('');
  });
  it('keeps the view when the filters are reset', () => {
    expect(resetFilters({ ...NO_FILTERS, metric: 'tokens', models: ['x'], hideCacheRead: true })).toEqual({ ...NO_FILTERS, metric: 'tokens', hideCacheRead: true });
  });
  it('builds chart queries in one fixed order, so equal requests share a cache entry', () => {
    expect(chartQuery('models=m1', { metric: 'tokens', hideCacheRead: '1' })).toBe('models=m1&hideCacheRead=1&metric=tokens');
    expect(chartQuery('', { metric: 'hours' })).toBe('metric=hours');
  });
});

describe('possibly incomplete days in the grid', () => {
  it('keeps the value and the step of a partial day and flags only real days', () => {
    // archive from Wed 7 Oct, complete from Mon 19 Oct: 7 to 18 Oct are partial
    const g = buildGrid(grid('2026-10-07', '2026-10-05', '2026-11-01', '2026-10-27', '2026-10-19'));
    const at = (d: string) => g.cells.find((c) => c.day === d);
    expect(at('2026-10-06')).toMatchObject({ state: 'before', partial: false });
    expect(at('2026-10-07')).toMatchObject({ state: 'value', partial: true, value: 1, level: 1 });
    expect(at('2026-10-18')).toMatchObject({ state: 'value', partial: true });
    expect(at('2026-10-19')).toMatchObject({ state: 'value', partial: false });
    expect(at('2026-10-28')).toMatchObject({ state: 'future', partial: false });
    expect(g.anyPartial).toBe(true);
    expect(g.horizon).toMatchObject({ day: '2026-10-07' });
    expect(g.complete).toMatchObject({ day: '2026-10-19', col: 2, row: 0 });
  });
  it('has no complete horizon when nothing is partial', () => {
    const g = buildGrid(grid('2026-10-07'));
    expect(g.anyPartial).toBe(false);
    expect(g.complete).toBeNull();
    expect(g.cells.some((c) => c.partial)).toBe(false);
  });
  it('has no complete horizon when the partial days run to the end of the real days', () => {
    const g = buildGrid(grid('2026-10-07', '2026-10-05', '2026-11-01', '2026-10-27', '2026-12-01'));
    expect(g.anyPartial).toBe(true);
    expect(g.complete).toBeNull();
  });
});

describe('placeFlags', () => {
  const box = (f: { x: number; w: number }, anchor: 'start' | 'end') => (anchor === 'start' ? [f.x + 6, f.x + 6 + f.w] : [f.x - 6 - f.w, f.x - 6]);
  const apart = (a: number[], b: number[]) => (a[0] as number) >= (b[1] as number) + FLAG_GAP || (b[0] as number) >= (a[1] as number) + FLAG_GAP;

  it('puts a lone flag on the right of its line when it fits, on the left when it does not', () => {
    expect(placeFlags([{ id: 'a', x: 100, w: 150 }], 0, 600)).toEqual([{ id: 'a', anchor: 'start', row: 0 }]);
    expect(placeFlags([{ id: 'a', x: 500, w: 150 }], 0, 600)).toEqual([{ id: 'a', anchor: 'end', row: 0 }]);
  });
  it('keeps two flags on one row when they have room', () => {
    const out = placeFlags([{ id: 'a', x: 20, w: 150 }, { id: 'b', x: 400, w: 150 }], 0, 800);
    expect(out.map((o) => o.row)).toEqual([0, 0]);
  });
  it('never lets two flags on one row overlap, whatever the geometry', () => {
    let rowsSeen = 0;
    for (const width of [320, 390, 560, 800, 1300]) {
      for (let xa = 10; xa < width; xa += 23) {
        for (let gap = 8; gap < 400; gap += 17) {
          const flags = [{ id: 'a', x: xa, w: 170 }, { id: 'b', x: xa + gap, w: 172 }];
          if (xa + gap > width) continue;
          const out = placeFlags(flags, 0, width);
          rowsSeen = Math.max(rowsSeen, ...out.map((o) => o.row + 1));
          const [pa, pb] = out as [(typeof out)[number], (typeof out)[number]];
          if (pa.row === pb.row) {
            const ba = box(flags[0] as { x: number; w: number }, pa.anchor);
            const bb = box(flags[1] as { x: number; w: number }, pb.anchor);
            expect(apart(ba, bb), `width ${width} a ${xa} gap ${gap}`).toBe(true);
          }
        }
      }
    }
    expect(rowsSeen).toBe(2);
  });
  it('uses a second row for the staircase seen near the right edge of a phone', () => {
    // lines 60 px apart, both near the right edge of an 824 px grid
    const out = placeFlags([{ id: 'archive', x: 700, w: 170 }, { id: 'complete', x: 760, w: 172 }], 0, 824);
    expect(new Set(out.map((o) => o.row)).size).toBe(2);
    expect(out.every((o) => o.anchor === 'end')).toBe(true);
  });
  it('keeps every flag inside the edges when that is possible', () => {
    const out = placeFlags([{ id: 'a', x: 30, w: 170 }, { id: 'b', x: 90, w: 172 }], 0, 800);
    for (const [i, o] of out.entries()) {
      const f = i === 0 ? { x: 30, w: 170 } : { x: 90, w: 172 };
      const b = box(f, o.anchor);
      expect(b[0]).toBeGreaterThanOrEqual(0);
      expect(b[1]).toBeLessThanOrEqual(800);
    }
  });
});

describe('the coverage note sentences', () => {
  const base = { archiveStart: '2026-09-01', completeFrom: '2026-09-27' };
  it('says the archive start when only earlier days are unknown', () => {
    expect(coverageText({ ...base, completeFrom: '2026-09-01', coverageGap: true, partialGap: false })).toBe(
      'Your archive starts 1 Sep 2026. Claude Code deleted older transcripts after 30 days, so earlier usage is unknown, not zero.',
    );
  });
  it('says which days only hold continued sessions when the range reaches into the partial days', () => {
    expect(coverageText({ ...base, coverageGap: false, partialGap: true })).toBe(
      'Days before 27 Sep 2026 only include sessions that were continued later, because Claude Code deletes transcripts after 30 days. Their values are shown, marked as possibly incomplete.',
    );
  });
  it('says both when both gaps are in the range', () => {
    expect(coverageText({ ...base, coverageGap: true, partialGap: true })).toBe(
      'Days before 27 Sep 2026 only include sessions that were continued later, because Claude Code deletes transcripts after 30 days. Days before 1 Sep 2026 are unknown.',
    );
  });
  it('writes no dashes', () => {
    for (const c of [{ coverageGap: true, partialGap: false }, { coverageGap: false, partialGap: true }, { coverageGap: true, partialGap: true }]) {
      expect(coverageText({ ...base, ...c })).not.toMatch(/[-\u2013\u2014]/);
    }
  });
});
