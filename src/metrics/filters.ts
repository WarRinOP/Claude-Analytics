// Query parameter parsing and validation for the data endpoints (contract in src/api/types.ts).
// Anything invalid raises BadRequest, which the router turns into HTTP 400 with an ApiError.
import type { ActivityMetric } from '../api/types.ts';
import { dayCount, isValidDay, rangeBounds } from './time.ts';

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

// The longest range one request may ask for, so a typo cannot ask for a million days.
export const MAX_RANGE_DAYS = 3660;
// Dates outside these years are refused, so no later calculation meets a year it cannot write.
const FIRST_DAY = '1970-01-01';
const LAST_DAY = '2999-12-31';
const MAX_LIST = 200;
const MAX_NAME = 300;

export interface Query {
  from: string;
  to: string;
  startMs: number; // UTC start of the first local day
  endMs: number; // UTC end (exclusive) of the last local day
  models: string[]; // empty means all
  projects: string[]; // empty means all
  includeSubagents: boolean;
  includeBackground: boolean;
}

export interface QueryEnv {
  tz: string;
  today: string;
  archiveStart: string | null;
}

function single(p: URLSearchParams, name: string): string | null {
  const all = p.getAll(name);
  if (all.length === 0) return null;
  if (all.length > 1) throw new BadRequest(`The parameter ${name} was given more than once.`);
  return all[0] as string;
}

function dateParam(p: URLSearchParams, name: string): string | null {
  const v = single(p, name);
  if (v === null || v === '') return null;
  if (!isValidDay(v) || v < FIRST_DAY || v > LAST_DAY) throw new BadRequest(`The value of ${name} is not a valid local date.`);
  return v;
}

// Model names are trimmed. Project keys are folder paths and are matched exactly (a folder name can end in a space).
function listParam(p: URLSearchParams, name: string, exact = false): string[] {
  const out: string[] = [];
  for (const raw of p.getAll(name)) {
    for (const part of raw.split(',')) {
      const v = exact ? part : part.trim();
      if (v.trim() === '') continue;
      if (v.length > MAX_NAME) throw new BadRequest(`A value in ${name} is too long.`);
      if (!out.includes(v)) out.push(v);
    }
  }
  if (out.length > MAX_LIST) throw new BadRequest(`The parameter ${name} lists too many values.`);
  return out;
}

export function flagParam(p: URLSearchParams, name: string, fallback: boolean): boolean {
  const v = single(p, name);
  if (v === null || v === '') return fallback;
  if (v === '1') return true;
  if (v === '0') return false;
  throw new BadRequest(`The parameter ${name} must be 1 or 0.`);
}

export function parseQuery(p: URLSearchParams, env: QueryEnv): Query {
  const toGiven = dateParam(p, 'to');
  const fromGiven = dateParam(p, 'from');
  const to = toGiven ?? env.today;
  let from = fromGiven;
  if (from === null) {
    // Default start is the first archived day, but never after the end of the range.
    from = env.archiveStart !== null && env.archiveStart < to ? env.archiveStart : to;
  }
  if (from > to) throw new BadRequest('The from date is after the to date.');
  if (dayCount(from, to) > MAX_RANGE_DAYS) throw new BadRequest('The range is longer than ten years.');
  const [startMs, endMs] = rangeBounds(from, to, env.tz);
  return {
    from,
    to,
    startMs,
    endMs,
    models: listParam(p, 'models'),
    projects: listParam(p, 'projects', true),
    includeSubagents: flagParam(p, 'includeSubagents', true),
    includeBackground: flagParam(p, 'includeBackground', false),
  };
}

const METRICS: ActivityMetric[] = ['messages', 'tokens', 'sessions', 'cost'];

export function parseMetric(p: URLSearchParams, fallback: ActivityMetric): ActivityMetric {
  const v = single(p, 'metric');
  if (v === null || v === '') return fallback;
  if ((METRICS as string[]).includes(v)) return v as ActivityMetric;
  throw new BadRequest('The parameter metric must be messages, tokens, sessions or cost.');
}

export function parseDayParam(p: URLSearchParams): string {
  const v = dateParam(p, 'date');
  if (v === null) throw new BadRequest('The parameter date is required.');
  return v;
}

export type SessionSort = 'start' | 'tokens' | 'active';

export interface Paging {
  page: number;
  pageSize: number;
  sort: SessionSort;
}

function intParam(p: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const v = single(p, name);
  if (v === null || v === '') return fallback;
  if (!/^\d{1,9}$/.test(v)) throw new BadRequest(`The parameter ${name} must be a whole number.`);
  const n = Number(v);
  if (n < min || n > max) throw new BadRequest(`The parameter ${name} must be from ${min} to ${max}.`);
  return n;
}

export function parsePaging(p: URLSearchParams): Paging {
  const sortRaw = single(p, 'sort');
  const sort = sortRaw === null || sortRaw === '' ? 'start' : sortRaw;
  if (sort !== 'start' && sort !== 'tokens' && sort !== 'active') {
    throw new BadRequest('The parameter sort must be start, tokens or active.');
  }
  return { page: intParam(p, 'page', 1, 1, 1_000_000), pageSize: intParam(p, 'pageSize', 50, 1, 200), sort };
}
