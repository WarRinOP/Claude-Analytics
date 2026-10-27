// Pure helpers for the time charts: heatmap grid geometry, colour steps, model colours, bucketing and tally groups.
// Nothing here touches the DOM, so the numbers that end up on screen can be unit tested.
import type { ActivityMetric, Daily, Heatmap } from '../../../src/api/types.ts';
import { dayOfMonth, full, monthShort, usd, weekdayIndex, yearOf } from './format.ts';

// ---- heatmap -------------------------------------------------------------------------------------------------------

export type Level = 0 | 1 | 2 | 3 | 4;

// Thresholds are the inclusive upper bounds of steps 1 to 4 (plan: quantiles of the non zero days, the last one the maximum).
export function heatLevel(value: number, thresholds: number[]): Level {
  if (value <= 0) return 0;
  const [a = 1, b = 2, c = 3] = thresholds;
  if (value <= a) return 1;
  if (value <= b) return 2;
  if (value <= c) return 3;
  return 4;
}

export type CellState = 'value' | 'before' | 'future';

export interface GridCell {
  day: string;
  value: number;
  col: number; // week, 0 is the first Monday of the grid
  row: number; // 0 Monday to 6 Sunday
  index: number; // position in the day list
  level: Level;
  state: CellState;
  partial: boolean; // a real day (state 'value') that is possibly incomplete: its value stays, with a lighter marking
}

export interface MonthLabel {
  col: number;
  text: string;
}

export interface Horizon {
  col: number; // column of the first archived day
  row: number; // its weekday row; 0 means the line is a plain vertical
  day: string;
}

export interface Grid {
  cells: GridCell[];
  cols: number;
  months: MonthLabel[];
  horizon: Horizon | null;
  complete: Horizon | null; // where the possibly incomplete days end: the first day after the last one of them
  anyPartial: boolean;
  lastIndex: number; // last cell that is not in the future (the keyboard stops here); -1 when there is none
  allEmpty: boolean; // no archived day in the grid has any activity
  allBefore: boolean; // every day of the grid is before the archive (or there is no archive yet)
}

export function buildGrid(h: Heatmap): Grid {
  const cells: GridCell[] = h.cells.map((c, index) => ({
    day: c.day,
    value: c.value,
    col: Math.floor(index / 7),
    row: weekdayIndex(c.day),
    index,
    level: heatLevel(c.value, h.thresholds),
    state: c.afterToday ? 'future' : c.beforeArchive ? 'before' : 'value',
    partial: c.partial && !c.beforeArchive && !c.afterToday,
  }));
  const cols = Math.ceil(cells.length / 7);
  const firstReal = cells.findIndex((c) => c.state === 'value');
  const first = cells[firstReal];
  const horizon: Horizon | null = first !== undefined && firstReal > 0 ? { col: first.col, row: first.row, day: first.day } : null;
  let lastIndex = -1;
  let lastPartial = -1;
  cells.forEach((c, i) => {
    if (c.state !== 'future') lastIndex = i;
    if (c.partial) lastPartial = i;
  });
  const after = lastPartial >= 0 ? cells[lastPartial + 1] : undefined;
  const complete: Horizon | null = after !== undefined && after.state === 'value' ? { col: after.col, row: after.row, day: after.day } : null;
  return {
    cells,
    cols,
    months: monthLabels(cells, cols),
    horizon,
    complete,
    anyPartial: lastPartial >= 0,
    lastIndex,
    allEmpty: cells.every((c) => c.value === 0),
    allBefore: cells.every((c) => c.state === 'before' || c.state === 'future'),
  };
}

// A month is named above the week that holds its first day. The first column is named too when its month then runs for
// at least three weeks, so a grid that starts mid month still says where it is. January carries its year.
function monthLabels(cells: GridCell[], cols: number): MonthLabel[] {
  const out: MonthLabel[] = [];
  for (let col = 0; col < cols; col++) {
    const week = cells.slice(col * 7, col * 7 + 7);
    const firstOfMonth = week.find((c) => dayOfMonth(c.day) === 1 && c.state !== 'future');
    if (firstOfMonth !== undefined) out.push({ col, text: monthText(firstOfMonth.day) });
  }
  const head = cells[0];
  const next = out[0];
  if (head !== undefined && (next === undefined || next.col >= 3) && dayOfMonth(head.day) !== 1) {
    out.unshift({ col: 0, text: monthText(head.day) });
  }
  return out;
}

const monthText = (day: string): string => (monthShort(day) === 'Jan' ? `Jan ${yearOf(day)}` : monthShort(day));

// Where the keyboard goes from `index`. Arrow keys move by day (up and down) and by week (left and right), Home and End jump
// to the first and last day that can be read. Returns the same index when the move would leave the grid.
export function moveIndex(key: string, index: number, last: number): number {
  const clamp = (n: number): number => Math.min(Math.max(n, 0), last);
  switch (key) {
    case 'ArrowUp':
      return clamp(index - 1);
    case 'ArrowDown':
      return clamp(index + 1);
    case 'ArrowLeft':
      return index - 7 >= 0 ? index - 7 : index;
    case 'ArrowRight':
      return index + 7 <= last ? index + 7 : index;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return index;
  }
}

// Tally marks: one stroke per session, every fifth one crosses the four before it.
export function tallyGroups(n: number): number[] {
  const groups: number[] = [];
  for (let left = n; left > 0; left -= 5) groups.push(Math.min(5, left));
  return groups;
}

// The scale legend: the range of values each step stands for. A step whose upper bound repeats the one before is never
// drawn by the heatmap, so it is left out. Counts are whole numbers, so a step runs from one past the bound before it; dollars
// are continuous, so a step is "up to" its bound or runs from the bound before it (the upper bound belongs to the step).
export function stepRanges(thresholds: number[], continuous = false): { level: Level; from: number; to: number }[] {
  const out: { level: Level; from: number; to: number }[] = [{ level: 0, from: 0, to: 0 }];
  let from = continuous ? 0 : 1;
  [0, 1, 2, 3].forEach((i) => {
    const to = thresholds[i] ?? from;
    if (continuous ? to > from : to >= from) {
      out.push({ level: (i + 1) as Level, from, to });
      from = continuous ? to : to + 1;
    }
  });
  return out;
}

// ---- model colours -------------------------------------------------------------------------------------------------

export const MAX_SERIES = 6;
export const OTHER = 'Other models';
export const UNATTRIBUTED = '(unattributed)';

// Colour follows the model, never its rank in the current view: a model's slot is its place in the all time list from
// /api/filters (most tokens first), so a filter or a range change never repaints the survivors. Past six slots a model is
// folded into one grey "Other models" series.
export function modelSlot(model: string, all: string[]): number | null {
  if (model === UNATTRIBUTED) return null;
  const i = all.indexOf(model);
  return i >= 0 && i < MAX_SERIES ? i : null;
}

export const slotColor = (slot: number | null): string => (slot === null ? 'var(--series-other)' : `var(--series-${slot + 1})`);

export interface Series {
  key: string; // model name, or OTHER
  label: string;
  members: string[]; // the models behind it
  slot: number | null;
  color: string;
}

// Series in stack order (bottom first): the API order for the models with a slot, then everything else folded into one.
export function seriesOf(models: string[], all: string[]): Series[] {
  const named: Series[] = [];
  const rest: string[] = [];
  for (const m of models) {
    const slot = modelSlot(m, all);
    if (slot === null) rest.push(m);
    else named.push({ key: m, label: m, members: [m], slot, color: slotColor(slot) });
  }
  if (rest.length > 0) {
    const onlyOne = rest.length === 1 ? rest[0] : undefined;
    named.push({ key: onlyOne ?? OTHER, label: onlyOne ?? OTHER, members: rest, slot: null, color: slotColor(null) });
  }
  return named;
}

// ---- daily buckets -------------------------------------------------------------------------------------------------

export interface Bucket {
  from: string;
  to: string;
  total: number;
  byModel: Record<string, number>;
  days: number;
  before: boolean; // every day in it lies before the archive (drawn hatched, not as zero)
  partial: boolean; // at least one day in it is possibly incomplete (the values stay, with a lighter marking)
}

// One bucket per day while the days fit the plot; past that, runs of days are added up so each bar stays readable.
export function bucketDays(daily: Daily, size: number, archiveStart: string | null, gap: boolean): Bucket[] {
  const out: Bucket[] = [];
  for (let i = 0; i < daily.days.length; i += size) {
    const run = daily.days.slice(i, i + size);
    const byModel: Record<string, number> = {};
    let total = 0;
    for (const d of run) {
      total += d.total;
      for (const [m, v] of Object.entries(d.byModel)) byModel[m] = (byModel[m] ?? 0) + v;
    }
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) continue;
    out.push({
      from: first.day,
      to: last.day,
      total,
      byModel,
      days: run.length,
      before: gap && archiveStart !== null && last.day < archiveStart,
      partial: run.some((d) => d.partial),
    });
  }
  return out;
}

export function bucketSize(days: number, plotWidth: number): number {
  const fit = Math.max(1, Math.floor(plotWidth / 3));
  return Math.max(1, Math.ceil(days / fit));
}

// The unit that follows a value of the metric: nothing for dollars, whose sign says it.
export const metricNoun = (m: ActivityMetric, n: number): string => (m === 'cost' ? '' : m === 'tokens' ? (n === 1 ? 'token' : 'tokens') : m === 'sessions' ? (n === 1 ? 'session' : 'sessions') : n === 1 ? 'message' : 'messages');

// A value of the metric as text: "$12.34" for the API price equivalent, "1,160" for counts.
export const valueText = (m: ActivityMetric, n: number): string => (m === 'cost' ? usd(n) : full(n));

// The value with its unit, as a screen reader and a tooltip say it: "$12.34", "1,160 tokens".
export const valueWithNoun = (m: ActivityMetric, n: number): string => (m === 'cost' ? usd(n) : `${full(n)} ${metricNoun(m, n)}`);

// ---- flags on the horizons -----------------------------------------------------------------------------------------

export interface FlagIn {
  id: string;
  x: number; // where the hairline is
  w: number; // the width of the label
}

export interface FlagOut {
  id: string;
  anchor: 'start' | 'end'; // start: the label runs to the right of its line, end: to the left
  row: number; // 0 is next to the plot, 1 is one row further out
}

export const FLAG_GAP = 12;

interface Box {
  l: number;
  r: number;
}

const boxOf = (f: FlagIn, anchor: 'start' | 'end'): Box => (anchor === 'start' ? { l: f.x + 6, r: f.x + 6 + f.w } : { l: f.x - 6 - f.w, r: f.x - 6 });
const overlaps = (a: Box, b: Box): boolean => a.l < b.r + FLAG_GAP && b.l < a.r + FLAG_GAP;

// Decides, for up to a few labels on hairlines, which side of its line each label runs to and on which row it sits, so that
// no two labels overlap and (when it can be avoided) no line runs through another label. A row further out has its line
// pass through the rows in front of it. Rows cost space, so fewer rows are better, then fewer labels on the left of a line.
// `min` and `max` are the edges the labels must stay inside. Pure, so the geometry can be tested.
export function placeFlags(flags: FlagIn[], min: number, max: number): FlagOut[] {
  const n = flags.length;
  const options: Array<{ anchor: 'start' | 'end'; row: number }> = [];
  for (const anchor of ['start', 'end'] as const) for (let row = 0; row < Math.max(1, n); row++) options.push({ anchor, row });
  let best: FlagOut[] = flags.map((f) => ({ id: f.id, anchor: 'start', row: 0 }));
  let bestCost = Number.POSITIVE_INFINITY;
  const pick = new Array<number>(n).fill(0);
  const walk = (i: number): void => {
    if (i === n) {
      const placed = flags.map((f, k) => ({ f, ...(options[pick[k] as number] as { anchor: 'start' | 'end'; row: number }) }));
      let cost = 0;
      for (const p of placed) {
        const b = boxOf(p.f, p.anchor);
        if (b.l < min) cost += 10_000 + (min - b.l);
        if (b.r > max) cost += 10_000 + (b.r - max);
        if (p.anchor === 'end') cost += 1;
        cost += p.row * 10;
      }
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          const pa = placed[a] as (typeof placed)[number];
          const pb = placed[b] as (typeof placed)[number];
          if (pa.row === pb.row && overlaps(boxOf(pa.f, pa.anchor), boxOf(pb.f, pb.anchor))) cost += 1_000_000;
        }
        // the line of a label passes through every row in front of its own
        for (let b = 0; b < n; b++) {
          const pa = placed[a] as (typeof placed)[number];
          const pb = placed[b] as (typeof placed)[number];
          if (a !== b && pb.row < pa.row) {
            const box = boxOf(pb.f, pb.anchor);
            if (pa.f.x > box.l - 3 && pa.f.x < box.r + 3) cost += 500;
          }
        }
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = placed.map((p) => ({ id: p.f.id, anchor: p.anchor, row: p.row }));
      }
      return;
    }
    for (let k = 0; k < options.length; k++) {
      pick[i] = k;
      walk(i + 1);
    }
  };
  walk(0);
  return best;
}
