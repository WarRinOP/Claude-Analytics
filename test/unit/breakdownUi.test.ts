// Pure helpers of the usage breakdown ledger (web/src/lib/breakdown.ts) and its address parameter.
import { afterEach, describe, expect, it } from 'vitest';
import type { BreakdownPeriod, BreakdownRow, BreakdownTotals } from '../../src/api/types.ts';
import {
  ALL_COLUMNS,
  COLUMNS,
  PAGE_ROWS,
  PAGING_THRESHOLD,
  arrange,
  collapseAll,
  columnValue,
  defaultOpen,
  expandAll,
  isAllClosed,
  isAllOpen,
  ledgerSlice,
  modelLines,
  readColumns,
  rowId,
  rowsOf,
  saveColumns,
  savedColumns,
  shortModel,
  shownCount,
  sortRows,
  toggled,
  visibleRowCount,
  type Open,
} from '../../web/src/lib/breakdown.ts';
import { apiQuery, NO_FILTERS, parseSearch, resetFilters, toSearch } from '../../web/src/lib/filters.ts';

const totals = (total: number, costUsd: number): BreakdownTotals => ({ responses: 1, input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, costUsd, unpriced: 0 });

function day(key: string, total: number, cost: number, models: string[] = ['claude-sonnet-5-5']): BreakdownRow {
  return { key, label: key, from: key, to: key, partial: false, models: models.map((model) => ({ model, ...totals(total, cost) })), totals: totals(total, cost), days: [] };
}

function period(key: string, days: BreakdownRow[]): BreakdownRow {
  const total = days.reduce((a, d) => a + d.totals.total, 0);
  const cost = days.reduce((a, d) => a + d.totals.costUsd, 0);
  return { key, label: key, from: key, to: key, partial: false, models: [{ model: 'claude-sonnet-5-5', ...totals(total, cost) }], totals: totals(total, cost), days };
}

describe('sorting', () => {
  const rows = [day('2026-10-27', 50, 1), day('2026-10-26', 90, 1), day('2026-10-25', 90, 3), day('2026-10-24', 10, 2)];

  it('newest and oldest go by key', () => {
    expect(sortRows(rows, 'newest').map((r) => r.key)).toEqual(['2026-10-27', '2026-10-26', '2026-10-25', '2026-10-24']);
    expect(sortRows(rows, 'oldest').map((r) => r.key)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  });

  it('cost and total tokens go largest first, ties newest first', () => {
    expect(sortRows(rows, 'cost').map((r) => r.key)).toEqual(['2026-10-25', '2026-10-24', '2026-10-27', '2026-10-26']);
    expect(sortRows(rows, 'tokens').map((r) => r.key)).toEqual(['2026-10-26', '2026-10-25', '2026-10-27', '2026-10-24']);
  });

  it('does not change the input', () => {
    const copy = [...rows];
    sortRows(rows, 'cost');
    expect(rows).toEqual(copy);
  });

  it('the days inside a period are sorted the same way', () => {
    const m = period('2026-10', [day('2026-10-27', 50, 1), day('2026-10-26', 90, 1), day('2026-10-25', 90, 3)]);
    expect(arrange([m], 'cost')[0]?.days.map((d) => d.key)).toEqual(['2026-10-25', '2026-10-27', '2026-10-26']);
    expect(arrange([m], 'oldest')[0]?.days.map((d) => d.key)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
  });

  it('model lines follow the cost sort and otherwise keep the API order', () => {
    const lines = [
      { model: 'a', total: 100, costUsd: 1 },
      { model: 'b', total: 50, costUsd: 5 },
      { model: 'c', total: 10, costUsd: 5 },
    ];
    expect(modelLines(lines, 'newest').map((l) => l.model)).toEqual(['a', 'b', 'c']);
    expect(modelLines(lines, 'cost').map((l) => l.model)).toEqual(['b', 'c', 'a']);
  });
});

describe('names and columns', () => {
  it('shortens claude model names and leaves the rest alone', () => {
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet-5-5');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5-20251001');
    expect(shortModel('claude-')).toBe('claude-');
    expect(shortModel('gpt-x')).toBe('gpt-x');
    expect(shortModel('(unknown)')).toBe('(unknown)');
  });

  it('has the seven numeric columns in the order of the table', () => {
    expect(COLUMNS.map((c) => c.label)).toEqual(['Responses', 'Input', 'Output', 'Cache write', 'Cache read', 'Total tokens', 'Cost']);
    const t: BreakdownTotals = { responses: 1, input: 2, output: 3, cacheWrite: 4, cacheRead: 5, total: 14, costUsd: 0.5, unpriced: 0 };
    expect(ALL_COLUMNS.map((k) => columnValue(t, k))).toEqual([1, 2, 3, 4, 5, 14, 0.5]);
  });

  it('reads a saved column list, keeps the table order, and treats damage as all columns', () => {
    expect(readColumns('["cost","input"]')).toEqual(['input', 'cost']);
    expect(readColumns('[]')).toEqual([]);
    for (const bad of ['', 'not json', '{}', '"cost"', '5', 'null', '["nope","x"]']) expect(readColumns(bad), bad).toEqual(ALL_COLUMNS);
    expect(readColumns('["input","nope"]')).toEqual(['input']);
  });

  describe('storage that may be blocked', () => {
    const g = globalThis as unknown as { localStorage?: unknown };
    afterEach(() => {
      delete g.localStorage;
    });

    it('round trips through localStorage', () => {
      const store = new Map<string, string>();
      g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
      expect(savedColumns()).toEqual(ALL_COLUMNS);
      saveColumns(['responses', 'cost']);
      expect(savedColumns()).toEqual(['responses', 'cost']);
    });

    it('falls back to all columns and never throws when the storage is blocked or missing', () => {
      const boom = (): never => {
        throw new Error('blocked');
      };
      g.localStorage = { getItem: boom, setItem: boom };
      expect(savedColumns()).toEqual(ALL_COLUMNS);
      expect(() => saveColumns(['cost'])).not.toThrow();
      delete g.localStorage;
      expect(savedColumns()).toEqual(ALL_COLUMNS);
      expect(() => saveColumns(['cost'])).not.toThrow();
    });
  });
});

describe('what is open', () => {
  const m1 = period('2026-10', [day('2026-10-27', 1, 1), day('2026-10-26', 1, 1)]);
  const m0 = period('2026-09', [day('2026-09-30', 1, 1)]);
  const rows = [m1, m0];

  it('monthly and weekly open the newest row to its days, daily starts closed', () => {
    expect(defaultOpen(rows, 'month')).toEqual({ days: new Set(['2026-10']), models: new Set() });
    expect(defaultOpen(rows, 'week').days).toEqual(new Set(['2026-10']));
    expect(defaultOpen(rows.flatMap((r) => r.days), 'day')).toEqual({ days: new Set(), models: new Set() });
    expect(defaultOpen([], 'month')).toEqual({ days: new Set(), models: new Set() });
  });

  it('expand all opens every row to its days and every row to its models; collapse all closes everything', () => {
    const all = expandAll(rows, 'month');
    expect([...all.days].sort()).toEqual(['2026-09', '2026-10']);
    expect([...all.models].sort()).toEqual(['d:2026-09-30', 'd:2026-10-26', 'd:2026-10-27', 'p:2026-09', 'p:2026-10']);
    expect(isAllOpen(rows, 'month', all)).toBe(true);
    expect(isAllClosed(all)).toBe(false);
    expect(isAllOpen(rows, 'month', collapseAll())).toBe(false);
    expect(isAllClosed(collapseAll())).toBe(true);
    const daily = expandAll(m1.days, 'day');
    expect(daily.days.size).toBe(0);
    expect([...daily.models].sort()).toEqual(['d:2026-10-26', 'd:2026-10-27']);
  });

  it('is not all open while one row is still closed', () => {
    const all = expandAll(rows, 'month');
    const one: Open = { days: all.days, models: toggled(all.models, rowId('day', '2026-10-27')) };
    expect(isAllOpen(rows, 'month', one)).toBe(false);
  });

  it('toggled adds and removes without changing the set it was given', () => {
    const s = new Set(['a']);
    expect(toggled(s, 'b')).toEqual(new Set(['a', 'b']));
    expect(toggled(s, 'a')).toEqual(new Set());
    expect(s).toEqual(new Set(['a']));
  });
});

describe('rows on screen and pages', () => {
  // 150 months of 3 days, 2 models each: closed = 150 rows; every day open to its models = 150 * (1 + 3 + 6) = 1500 rows
  const rows = Array.from({ length: 150 }, (_, i) => period(`m${String(i).padStart(3, '0')}`, ['a', 'b', 'c'].map((d) => day(`${i}-${d}`, 1, 1, ['claude-a', 'claude-b']))));
  const period_: BreakdownPeriod = 'month';

  it('counts a row, its model lines, and its days with their model lines', () => {
    const first = rows[0] as BreakdownRow;
    const none = collapseAll();
    expect(rowsOf(first, period_, none)).toBe(1);
    expect(rowsOf(first, period_, { days: new Set([first.key]), models: new Set() })).toBe(1 + 3);
    expect(rowsOf(first, period_, { days: new Set([first.key]), models: new Set([rowId('period', first.key)]) })).toBe(1 + 1 + 3);
    expect(rowsOf(first, period_, expandAll([first], period_))).toBe(1 + 1 + 3 + 3 * 2);
    expect(visibleRowCount(rows, period_, none)).toBe(150);
    expect(visibleRowCount(rows, period_, expandAll(rows, period_))).toBe(150 * 11);
  });

  it('draws everything while the open rows are about 400 or fewer', () => {
    expect(visibleRowCount(rows, period_, collapseAll())).toBeLessThanOrEqual(PAGING_THRESHOLD);
    expect(shownCount(rows, period_, collapseAll(), 1)).toBe(150);
    expect(shownCount(rows.slice(0, 30), period_, expandAll(rows.slice(0, 30), period_), 1)).toBe(30); // 330 rows
  });

  it('above the threshold draws whole groups up to a budget of 100 rows per page, and never splits a group', () => {
    const open = expandAll(rows, period_); // 11 rows per group
    expect(visibleRowCount(rows, period_, open)).toBeGreaterThan(PAGING_THRESHOLD);
    // 9 groups = 99 rows, the 10th group crosses 100 and is drawn whole
    expect(shownCount(rows, period_, open, 1)).toBe(10);
    expect(shownCount(rows, period_, open, 2)).toBe(19);
    expect(shownCount(rows, period_, open, 3)).toBe(28);
    expect(shownCount(rows, period_, open, 1_000)).toBe(150);
    expect(PAGE_ROWS).toBe(100);
  });

  it('always draws at least one group, and nothing when there is nothing', () => {
    const huge = period('big', Array.from({ length: 31 }, (_, i) => day(`d${i}`, 1, 1, ['a', 'b', 'c'])));
    const open = expandAll([huge, ...rows], period_);
    expect(shownCount([huge], period_, open, 1)).toBe(1);
    expect(shownCount([], period_, collapseAll(), 1)).toBe(0);
  });

  it('a two year daily view with every row open draws a page at a time', () => {
    const days = Array.from({ length: 730 }, (_, i) => day(`2026-${i}`, 1, 1, ['claude-a', 'claude-b', 'claude-c']));
    const open = expandAll(days, 'day');
    expect(visibleRowCount(days, 'day', open)).toBe(730 * 4);
    expect(shownCount(days, 'day', open, 1)).toBe(25);
    // closed, 730 day rows are still more than 400 rows on screen: a page of 100 rows, never all of them at once
    expect(shownCount(days, 'day', collapseAll(), 1)).toBe(100);
    expect(shownCount(days.slice(0, 400), 'day', collapseAll(), 1)).toBe(400);
  });
});

describe('the request', () => {
  it('leaves out includeBackground, which the ledger does not use, and keeps the rest', () => {
    expect(ledgerSlice('from=2026-10-01&includeBackground=1&models=m1')).toBe('from=2026-10-01&models=m1');
    expect(ledgerSlice('')).toBe('');
  });
});

describe('the breakdown parameter in the address', () => {
  it('defaults to month and reads month, week and day', () => {
    expect(parseSearch('').breakdown).toBe('month');
    expect(parseSearch('?breakdown=week').breakdown).toBe('week');
    expect(parseSearch('?breakdown=day').breakdown).toBe('day');
    expect(parseSearch('?breakdown=year').breakdown).toBe('month');
    expect(parseSearch('?breakdown=').breakdown).toBe('month');
  });

  it('is written only when it is not the default, after the other view parameters, and never in the data slice', () => {
    expect(toSearch({ ...NO_FILTERS, breakdown: 'week' })).toBe('?breakdown=week');
    expect(toSearch({ ...NO_FILTERS, breakdown: 'month' })).toBe('');
    expect(toSearch({ ...NO_FILTERS, metric: 'tokens', models: ['m1'], breakdown: 'day' })).toBe('?models=m1&metric=tokens&breakdown=day');
    expect(apiQuery({ ...NO_FILTERS, breakdown: 'day', models: ['m1'] })).toBe('models=m1');
    expect(parseSearch(toSearch({ ...NO_FILTERS, breakdown: 'day' })).breakdown).toBe('day');
  });

  it('survives a filter reset like the other view parameters', () => {
    expect(resetFilters({ ...NO_FILTERS, breakdown: 'week', models: ['x'] })).toEqual({ ...NO_FILTERS, breakdown: 'week' });
  });
});
