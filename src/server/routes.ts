// The JSON API: path to query function. Parsing errors become HTTP 400, unknown paths 404, anything unexpected 500
// with a plain sentence (details go to the log, never to the client).
import type { ApiError } from '../api/types.ts';
import { appendLog } from '../config/log.ts';
import type { SyncStatus } from '../ingest/scheduler.ts';
import { breakdown, breakdownCsv, breakdownFileName, parsePeriod } from '../metrics/breakdown.ts';
import { BadRequest, parseDayParam, parseMetric, parsePaging, parseQuery, flagParam, type Query } from '../metrics/filters.ts';
import * as queries from '../metrics/queries.ts';
import type { Ctx } from '../metrics/queries.ts';

export interface ApiDeps extends Ctx {
  syncStatus: () => SyncStatus;
}

export interface ApiResult {
  status: number;
  body: unknown;
  // A download instead of JSON (the breakdown CSV): the server sends `text` with this type and an attachment file name.
  file?: { type: string; filename: string; text: string };
}

const fail = (status: number, error: string): ApiResult => ({ status, body: { error } satisfies ApiError });

function query(deps: ApiDeps, p: URLSearchParams): Query {
  return parseQuery(p, { tz: deps.tz, today: queries.todayOfCtx(deps), archiveStart: queries.archiveStart(deps) });
}

export const API_PATHS = [
  '/api/summary',
  '/api/heatmap',
  '/api/day',
  '/api/daily',
  '/api/hours',
  '/api/models',
  '/api/breakdown',
  '/api/breakdown.csv',
  '/api/projects',
  '/api/sessions',
  '/api/filters',
  '/api/health',
  '/api/definitions',
] as const;

function answer(deps: ApiDeps, path: string, p: URLSearchParams): unknown {
  switch (path) {
    case '/api/summary':
      return queries.summary(deps, query(deps, p));
    case '/api/heatmap':
      return queries.heatmap(deps, query(deps, p), parseMetric(p, 'messages'));
    case '/api/day': {
      const date = parseDayParam(p);
      return queries.dayDetail(deps, query(deps, p), date);
    }
    case '/api/daily':
      return queries.daily(deps, query(deps, p), parseMetric(p, 'tokens'), flagParam(p, 'hideCacheRead', false));
    case '/api/hours':
      return queries.hours(deps, query(deps, p), parseMetric(p, 'messages'));
    case '/api/models':
      return queries.models(deps, query(deps, p));
    case '/api/breakdown':
      return breakdown(deps, query(deps, p), parsePeriod(p));
    case '/api/projects':
      return queries.projects(deps, query(deps, p));
    case '/api/sessions':
      return queries.sessions(deps, query(deps, p), parsePaging(p));
    case '/api/filters':
      return queries.filters(deps);
    case '/api/health':
      return queries.health(deps, deps.syncStatus());
    case '/api/definitions':
      return queries.definitions();
    default:
      return undefined;
  }
}

export function handleApi(deps: ApiDeps, path: string, params: URLSearchParams): ApiResult {
  if (!(API_PATHS as readonly string[]).includes(path)) return fail(404, 'There is no such API path.');
  try {
    if (path === '/api/breakdown.csv') {
      const b = breakdown(deps, query(deps, params), parsePeriod(params));
      return { status: 200, body: null, file: { type: 'text/csv; charset=utf-8', filename: breakdownFileName(b), text: breakdownCsv(b) } };
    }
    const body = answer(deps, path, params);
    return { status: 200, body };
  } catch (err) {
    if (err instanceof BadRequest) return fail(400, err.message);
    try {
      appendLog(`api error path=${path} ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`);
    } catch {
      // logging must not hide the answer
    }
    return fail(500, 'Something went wrong while answering this request.');
  }
}
