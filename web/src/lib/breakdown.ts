// Pure helpers of the usage breakdown ledger: columns, sorting, what is open, how many rows are on screen and the page of rows
// to draw. No DOM, so what ends up on screen can be unit tested.
import type { BreakdownPeriod, BreakdownRow, BreakdownTotals } from '../../../src/api/types.ts';

// ---- periods ----------------------------------------------------------------------------------------------------------------

export const PERIODS: { id: BreakdownPeriod; label: string; noun: string }[] = [
  { id: 'month', label: 'Monthly', noun: 'month' },
  { id: 'week', label: 'Weekly', noun: 'week' },
  { id: 'day', label: 'Daily', noun: 'day' },
];
export const DEFAULT_PERIOD: BreakdownPeriod = 'month';

export const isPeriod = (v: string | null): v is BreakdownPeriod => v === 'month' || v === 'week' || v === 'day';

// ---- columns ----------------------------------------------------------------------------------------------------------------

export type ColumnKey = 'responses' | 'input' | 'output' | 'cacheWrite' | 'cacheRead' | 'total' | 'cost';

export interface Column {
  key: ColumnKey;
  label: string;
}

// The numeric columns, in table order. Period and Models are always shown.
export const COLUMNS: Column[] = [
  { key: 'responses', label: 'Responses' },
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'total', label: 'Total tokens' },
  { key: 'cost', label: 'Cost' },
];

export const ALL_COLUMNS: ColumnKey[] = COLUMNS.map((c) => c.key);

export const columnValue = (t: BreakdownTotals, key: ColumnKey): number => (key === 'cost' ? t.costUsd : t[key]);

const STORE_KEY = 'ledger.breakdown.columns';

// The visible columns kept for this viewer. localStorage can be blocked or hold anything, so every access is guarded and a
// bad value means "all columns".
interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// The page's localStorage. Reading the property itself throws when storage is blocked, so callers use it inside try.
const store = (): KeyValueStore => (globalThis as { localStorage?: KeyValueStore }).localStorage as KeyValueStore;

export function savedColumns(): ColumnKey[] {
  try {
    const raw = store().getItem(STORE_KEY);
    if (raw === null) return ALL_COLUMNS;
    return readColumns(raw);
  } catch {
    return ALL_COLUMNS;
  }
}

export function readColumns(raw: string): ColumnKey[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return ALL_COLUMNS;
    const keep = ALL_COLUMNS.filter((k) => v.includes(k));
    // an empty list was chosen on purpose; a list of nothing we know is damage, which means "all"
    return keep.length === 0 && v.length > 0 ? ALL_COLUMNS : keep;
  } catch {
    return ALL_COLUMNS;
  }
}

export function saveColumns(columns: readonly ColumnKey[]): void {
  try {
    store().setItem(STORE_KEY, JSON.stringify(columns));
  } catch {
    // the choice still applies for this visit
  }
}

// ---- sorting ----------------------------------------------------------------------------------------------------------------

export type SortId = 'newest' | 'oldest' | 'cost' | 'tokens';

export const SORTS: { id: SortId; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Total tokens' },
];

export const isSort = (v: string): v is SortId => SORTS.some((s) => s.id === v);

// Stable order of rows. The API gives newest first; ties in cost or tokens fall back to newest first.
export function sortRows<T extends { key: string; totals: BreakdownTotals }>(rows: readonly T[], sort: SortId): T[] {
  const newest = (a: T, b: T): number => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
  const by: Record<SortId, (a: T, b: T) => number> = {
    newest,
    oldest: (a, b) => -newest(a, b),
    cost: (a, b) => b.totals.costUsd - a.totals.costUsd || newest(a, b),
    tokens: (a, b) => b.totals.total - a.totals.total || newest(a, b),
  };
  return [...rows].sort(by[sort]);
}

// The rows in the order the table shows them: the top level and the days inside each row are sorted the same way.
export function arrange(rows: readonly BreakdownRow[], sort: SortId): BreakdownRow[] {
  return sortRows(rows, sort).map((r) => (r.days.length === 0 ? r : { ...r, days: sortRows(r.days, sort) }));
}

// Model lines inside a row: by cost when sorting by cost, else by tokens (the order the API gives).
export function modelLines<T extends { model: string; total: number; costUsd: number }>(models: readonly T[], sort: SortId): T[] {
  if (sort !== 'cost') return [...models];
  return [...models].sort((a, b) => b.costUsd - a.costUsd || b.total - a.total || (a.model < b.model ? -1 : 1));
}

// ---- names ------------------------------------------------------------------------------------------------------------------

// "claude-sonnet-5-5" -> "sonnet-5-5". The full name stays in the tooltip and in the per model lines.
export const shortModel = (model: string): string => (model.startsWith('claude-') && model.length > 7 ? model.slice(7) : model);

// ---- what is open -----------------------------------------------------------------------------------------------------------

export interface Open {
  days: ReadonlySet<string>; // keys of the month or week rows whose days are shown
  models: ReadonlySet<string>; // ids of the rows whose per model lines are shown (see rowId)
}

// Ids differ by level, so a day inside a month and the same day in the daily view are named alike and a month never clashes.
export const rowId = (level: 'period' | 'day', key: string): string => (level === 'period' ? `p:${key}` : `d:${key}`);

// The level of the top rows of a view: in the daily view they are days.
export const topLevel = (period: BreakdownPeriod): 'period' | 'day' => (period === 'day' ? 'day' : 'period');

// Monthly and weekly open the newest row to its days; the daily view starts closed.
export function defaultOpen(rows: readonly BreakdownRow[], period: BreakdownPeriod): Open {
  const newest = rows[0];
  return { days: period !== 'day' && newest !== undefined ? new Set([newest.key]) : new Set(), models: new Set() };
}

export function expandAll(rows: readonly BreakdownRow[], period: BreakdownPeriod): Open {
  const models = new Set<string>();
  const days = new Set<string>();
  for (const r of rows) {
    models.add(rowId(topLevel(period), r.key));
    if (period !== 'day') days.add(r.key);
    for (const d of r.days) models.add(rowId('day', d.key));
  }
  return { days, models };
}

export const collapseAll = (): Open => ({ days: new Set(), models: new Set() });

export function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

// True when no row has anything to open or everything that can open is open: used to label and enable Expand all.
export function isAllOpen(rows: readonly BreakdownRow[], period: BreakdownPeriod, open: Open): boolean {
  const all = expandAll(rows, period);
  for (const k of all.days) if (!open.days.has(k)) return false;
  for (const k of all.models) if (!open.models.has(k)) return false;
  return true;
}

export const isAllClosed = (open: Open): boolean => open.days.size === 0 && open.models.size === 0;

// ---- how many rows are drawn ------------------------------------------------------------------------------------------------

// Table rows one top row brings with it, given what is open: itself, its model lines, and for a month or week its days with
// their model lines.
export function rowsOf(row: BreakdownRow, period: BreakdownPeriod, open: Open): number {
  let n = 1;
  if (open.models.has(rowId(topLevel(period), row.key))) n += row.models.length;
  if (period !== 'day' && open.days.has(row.key)) {
    for (const d of row.days) {
      n += 1;
      if (open.models.has(rowId('day', d.key))) n += d.models.length;
    }
  }
  return n;
}

export function visibleRowCount(rows: readonly BreakdownRow[], period: BreakdownPeriod, open: Open): number {
  let n = 0;
  for (const r of rows) n += rowsOf(r, period, open);
  return n;
}

// Above this many rows on screen the table draws a page at a time.
export const PAGING_THRESHOLD = 400;
export const PAGE_ROWS = 100;

// How many of the top rows to draw. Everything when the open rows are few; else whole groups until the budget of
// `pages` times PAGE_ROWS table rows is reached (a group is never cut in the middle). Always at least one group.
export function shownCount(rows: readonly BreakdownRow[], period: BreakdownPeriod, open: Open, pages: number): number {
  if (visibleRowCount(rows, period, open) <= PAGING_THRESHOLD) return rows.length;
  const budget = pages * PAGE_ROWS;
  let used = 0;
  let n = 0;
  for (const r of rows) {
    if (n > 0 && used >= budget) break;
    used += rowsOf(r, period, open);
    n += 1;
  }
  return n;
}

// ---- the request ------------------------------------------------------------------------------------------------------------

// The ledger lists transcripts only, so the background toggle of the Models table does not change it and must not refetch it.
export function ledgerSlice(slice: string): string {
  const p = new URLSearchParams(slice);
  p.delete('includeBackground');
  return p.toString();
}
