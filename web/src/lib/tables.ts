// Pure helpers for the tables: sorting, local days, paging. No DOM, so what ends up on screen can be unit tested.
import type { Models, Projects } from '../../../src/api/types.ts';
import { clock, dayLong } from './format.ts';

export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

// A click on a column header: the same column flips its direction, a new column starts in that column's natural direction
// (text ascending, numbers descending).
export function nextSort<K extends string>(current: SortState<K>, clicked: K, natural: SortDir): SortState<K> {
  if (current.key === clicked) return { key: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key: clicked, dir: natural };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// Stable sort by one value per row. Equal values keep the order the API gave, whatever the direction.
export function sortRows<T>(rows: readonly T[], value: (row: T) => string | number, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      const c = typeof a.v === 'string' && typeof b.v === 'string' ? collator.compare(a.v, b.v) : (a.v as number) - (b.v as number);
      return c !== 0 ? sign * c : a.index - b.index;
    })
    .map((e) => e.row);
}

// ---- models ---------------------------------------------------------------------------------------------------------------

export type ModelRow = Models['rows'][number];
export type ModelKey = 'model' | 'responses' | 'input' | 'output' | 'cacheWrite' | 'cacheRead' | 'total' | 'share' | 'cost' | 'costShare';

export const MODEL_COLUMNS: { key: ModelKey; label: string; natural: SortDir; numeric: boolean }[] = [
  { key: 'model', label: 'Model', natural: 'asc', numeric: false },
  { key: 'responses', label: 'Responses', natural: 'desc', numeric: true },
  { key: 'input', label: 'Input', natural: 'desc', numeric: true },
  { key: 'output', label: 'Output', natural: 'desc', numeric: true },
  { key: 'cacheWrite', label: 'Cache write', natural: 'desc', numeric: true },
  { key: 'cacheRead', label: 'Cache read', natural: 'desc', numeric: true },
  { key: 'total', label: 'Total', natural: 'desc', numeric: true },
  { key: 'share', label: 'Share of total', natural: 'desc', numeric: true },
  { key: 'cost', label: 'Cost', natural: 'desc', numeric: true },
  { key: 'costShare', label: 'Cost share', natural: 'desc', numeric: true },
];

// A model without a price has no cost to sort by: it sorts below every priced model.
export const modelValue = (r: ModelRow, key: ModelKey): string | number => (key === 'model' ? r.model : key === 'cost' ? (r.costUsd ?? -1) : r[key]);

export interface ModelTotals {
  responses: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  cost: number; // dollars of the priced models
  unpriced: number; // models without a price
}

export function modelTotals(rows: readonly ModelRow[]): ModelTotals {
  const t: ModelTotals = { responses: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0, unpriced: 0 };
  for (const r of rows) {
    if (r.costUsd === null) t.unpriced += 1;
    else t.cost += r.costUsd;
    t.responses += r.responses;
    t.input += r.input;
    t.output += r.output;
    t.cacheWrite += r.cacheWrite;
    t.cacheRead += r.cacheRead;
    t.total += r.total;
  }
  return t;
}

// ---- projects -------------------------------------------------------------------------------------------------------------

export type ProjectRow = Projects['rows'][number];
export type ProjectKey = 'name' | 'sessions' | 'messages' | 'tokens' | 'cost' | 'last';

export const PROJECT_COLUMNS: { key: ProjectKey; label: string; natural: SortDir; numeric: boolean }[] = [
  { key: 'name', label: 'Project', natural: 'asc', numeric: false },
  { key: 'sessions', label: 'Sessions', natural: 'desc', numeric: true },
  { key: 'messages', label: 'Messages', natural: 'desc', numeric: true },
  { key: 'tokens', label: 'Tokens', natural: 'desc', numeric: true },
  { key: 'cost', label: 'Cost', natural: 'desc', numeric: true },
  { key: 'last', label: 'Last active', natural: 'desc', numeric: true },
];

export const projectValue = (r: ProjectRow, key: ProjectKey): string | number =>
  key === 'name' ? r.displayName : key === 'last' ? (r.lastActiveTs ?? 0) : key === 'cost' ? r.costUsd : r[key];

// Clicking a project row: the filter becomes that project alone; clicking the project that is already the whole filter clears it.
export function toggleProject(current: readonly string[], key: string): string[] {
  return current.length === 1 && current[0] === key ? [] : [key];
}

// ---- sessions -------------------------------------------------------------------------------------------------------------

export const PAGE_SIZE = 50;
export type SessionSort = 'start' | 'tokens' | 'active';

export const SESSION_SORTS: { key: SessionSort; label: string }[] = [
  { key: 'start', label: 'Start' },
  { key: 'active', label: 'Active time' },
  { key: 'tokens', label: 'Tokens' },
];

export const pageCount = (total: number, pageSize: number): number => Math.max(1, Math.ceil(total / pageSize));

// "Showing 51 to 100 of 163", from the page the API answered.
export function pageRange(total: number, page: number, pageSize: number): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  const from = (page - 1) * pageSize + 1;
  return { from, to: Math.min(total, page * pageSize) };
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

// The local calendar day ('YYYY-MM-DD') of an instant in the given zone.
export function localDay(ms: number, tz: string): string {
  let f = dayFormats.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    dayFormats.set(tz, f);
  }
  return f.format(new Date(ms));
}

// "27 Oct 2026 14:05" in the given zone.
export const dateTimeText = (ms: number, tz: string): string => `${dayLong(localDay(ms, tz))} ${clock(ms, tz)}`;

// A session that started on a day before `completeFrom` may be missing its first part: Claude Code could have deleted it.
export function startedBeforeComplete(firstTs: number, tz: string, completeFrom: string | null): boolean {
  return completeFrom !== null && localDay(firstTs, tz) < completeFrom;
}

// "claude-sonnet-5-5" keeps its full name; the id of a session is shortened to the first eight characters.
export const shortSession = (id: string): string => id.slice(0, 8);
