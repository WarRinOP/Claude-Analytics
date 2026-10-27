// The view's filters live in the URL query so a view can be bookmarked:
//   ?from&to&models&projects&includeSubagents&includeBackground
// Nothing in the query means "All time, every model and project, subagents in, background out".
// Three more parameters belong to the view, not to the data slice: `metric` (what the time charts count), `hideCacheRead`
// (the daily chart) and `breakdown` (month, week or day in the usage breakdown ledger). They are in the address but never in
// `apiQuery`, so changing them does not refetch the numbers above.
import type { ActivityMetric, BreakdownPeriod } from '../../../src/api/types.ts';
import { DEFAULT_PERIOD, isPeriod } from './breakdown.ts';
import { addDays, isDay } from './format.ts';

export const METRICS: { id: ActivityMetric; label: string }[] = [
  { id: 'messages', label: 'Messages' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'cost', label: 'Cost' },
];
export const DEFAULT_METRIC: ActivityMetric = 'messages';

export const isMetric = (v: string | null): v is ActivityMetric => v === 'messages' || v === 'tokens' || v === 'sessions' || v === 'cost';

export interface FilterState {
  from: string | null;
  to: string | null;
  models: string[];
  projects: string[];
  includeSubagents: boolean;
  includeBackground: boolean;
  metric: ActivityMetric;
  hideCacheRead: boolean;
  breakdown: BreakdownPeriod;
}

export const NO_FILTERS: FilterState = {
  from: null,
  to: null,
  models: [],
  projects: [],
  includeSubagents: true,
  includeBackground: false,
  metric: DEFAULT_METRIC,
  hideCacheRead: false,
  breakdown: DEFAULT_PERIOD,
};

// "Reset filters" clears the data slice and keeps how the charts are being read.
export const resetFilters = (f: FilterState): FilterState => ({ ...NO_FILTERS, metric: f.metric, hideCacheRead: f.hideCacheRead, breakdown: f.breakdown });

export type Preset = 'all' | '7d' | '30d' | '90d' | 'custom';

export const PRESETS: { id: Exclude<Preset, 'custom'>; label: string; days: number | null }[] = [
  { id: 'all', label: 'All', days: null },
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
];

const list = (v: string | null): string[] => (v === null || v === '' ? [] : v.split(',').filter((s) => s !== ''));

export function parseSearch(search: string): FilterState {
  const p = new URLSearchParams(search);
  const from = p.get('from');
  const to = p.get('to');
  return {
    from: isDay(from) ? from : null,
    to: isDay(to) ? to : null,
    models: list(p.get('models')),
    projects: list(p.get('projects')),
    includeSubagents: p.get('includeSubagents') !== '0',
    includeBackground: p.get('includeBackground') === '1',
    metric: isMetric(p.get('metric')) ? (p.get('metric') as ActivityMetric) : DEFAULT_METRIC,
    hideCacheRead: p.get('hideCacheRead') === '1',
    breakdown: isPeriod(p.get('breakdown')) ? (p.get('breakdown') as BreakdownPeriod) : DEFAULT_PERIOD,
  };
}

// Only values that differ from the defaults are written, so the plain address stays clean.
function params(f: FilterState, withView: boolean): URLSearchParams {
  const p = new URLSearchParams();
  if (f.from !== null) p.set('from', f.from);
  if (f.to !== null) p.set('to', f.to);
  if (f.models.length > 0) p.set('models', f.models.join(','));
  if (f.projects.length > 0) p.set('projects', f.projects.join(','));
  if (!f.includeSubagents) p.set('includeSubagents', '0');
  if (f.includeBackground) p.set('includeBackground', '1');
  if (withView) {
    if (f.metric !== DEFAULT_METRIC) p.set('metric', f.metric);
    if (f.hideCacheRead) p.set('hideCacheRead', '1');
    if (f.breakdown !== DEFAULT_PERIOD) p.set('breakdown', f.breakdown);
  }
  return p;
}

// The data slice as API parameters. One string per slice: it is also the cache key.
export function apiQuery(f: FilterState): string {
  return params(f, false).toString();
}

// The slice plus parameters of one chart endpoint, in a fixed order so equal requests share one cache entry.
export function chartQuery(slice: string, extra: Record<string, string>): string {
  const p = new URLSearchParams(slice);
  for (const k of Object.keys(extra).sort()) p.set(k, extra[k] as string);
  return p.toString();
}

export function toSearch(f: FilterState): string {
  const q = params(f, true).toString();
  return q === '' ? '' : `?${q}`;
}

// Preset to a concrete range, counted back from `today` (inclusive, local zone from /api/filters).
export function presetRange(preset: Exclude<Preset, 'custom'>, today: string): { from: string | null; to: string | null } {
  const days = PRESETS.find((p) => p.id === preset)?.days ?? null;
  if (days === null) return { from: null, to: null };
  return { from: addDays(today, -(days - 1)), to: today };
}

export function detectPreset(f: FilterState, today: string | null): Preset {
  if (f.from === null && f.to === null) return 'all';
  if (today === null || f.to !== today || f.from === null) return 'custom';
  for (const p of PRESETS) {
    if (p.days !== null && f.from === addDays(today, -(p.days - 1))) return p.id;
  }
  return 'custom';
}

export function countActive(f: FilterState): number {
  return (f.from !== null || f.to !== null ? 1 : 0) + (f.models.length > 0 ? 1 : 0) + (f.projects.length > 0 ? 1 : 0) + (f.includeSubagents ? 0 : 1) + (f.includeBackground ? 1 : 0);
}
