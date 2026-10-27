import type { SyncStatus } from '../../src/ingest/scheduler.ts';
import type { Ctx } from '../../src/metrics/queries.ts';
import { handleApi, type ApiDeps, type ApiResult } from '../../src/server/routes.ts';
import type { Db } from '../../src/store/db.ts';
import { insertMessage, upsertSession, upsertUsage } from '../../src/store/repo.ts';
import { freshDb, message, usage } from './storeHelpers.ts';

export const MIN = 60_000;
export const HOUR = 3_600_000;

export const IDLE: SyncStatus = { running: false, lastPassAt: null, lastSuccessAt: null, lastError: null, watcherAlive: true };

export interface ResponseOpts {
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  sub?: boolean; // event read from a subagent file
  side?: boolean; // sidechain flag on a main file line
  tools?: number;
  cwd?: string;
}

// A small archive written with the repository functions, the way ingest writes it.
export interface Seeder {
  db: Db;
  ctx: Ctx;
  response(sessionId: string, ts: number, o?: ResponseOpts): string;
  prompt(sessionId: string, ts: number, o?: { kind?: 'prompt' | 'tool_result' | 'meta' | 'compact_summary'; side?: boolean; cwd?: string }): void;
  session(sessionId: string, cwd: string, ts: number): void;
  get(path: string, now?: number): ApiResult;
}

export function seeder(dir: string, tz: string, nowMs: number = Date.parse('2026-10-27T06:00:00Z')): Seeder {
  const { db, mainFile, subFile } = freshDb(dir);
  let n = 0;
  const ctx: Ctx = { db, tz, now: () => nowMs };
  const self: Seeder = {
    db,
    ctx,
    session(sessionId, cwd, ts) {
      n += 1;
      upsertSession(db, message({ sessionId, cwd, ts, uuid: `s-${n}` }), '-work-demo', ts);
    },
    response(sessionId, ts, o = {}) {
      n += 1;
      const key = `msg_${n}|req_${n}`;
      const sub = o.sub === true;
      const fact = usage({
        sessionId,
        ts,
        key,
        uuid: `u-${n}`,
        model: o.model ?? 'claude-sonnet-5-5',
        input: o.input ?? 10,
        output: o.output ?? 100,
        cacheRead: o.cacheRead ?? 1000,
        cacheWrite: o.cacheWrite ?? 50,
        isSubagentFile: sub,
        isSidechain: sub || o.side === true,
        agentId: sub ? 'a' : null,
        cwd: o.cwd ?? '/work/demo',
        toolUses: Array.from({ length: o.tools ?? 0 }, (_, i) => ({ id: `tool-${n}-${i}`, name: 'Read' })),
      });
      if (!sub) upsertSession(db, fact, '-work-demo', ts);
      upsertUsage(db, fact, sub ? subFile : mainFile);
      return key;
    },
    prompt(sessionId, ts, o = {}) {
      n += 1;
      const fact = message({ sessionId, ts, uuid: `p-${n}`, messageKind: o.kind ?? 'prompt', isSidechain: o.side === true, cwd: o.cwd ?? '/work/demo' });
      upsertSession(db, fact, '-work-demo', ts);
      insertMessage(db, fact);
    },
    get(path, now) {
      const deps: ApiDeps = { ...ctx, now: () => now ?? nowMs, syncStatus: () => IDLE };
      const [p, qs] = path.split('?');
      return handleApi(deps, p as string, new URLSearchParams(qs ?? ''));
    },
  };
  return self;
}

// Runtime shape check against a template. Strings name a type; an array holds one element template; an object must match
// exactly (no missing and no extra keys); { nullable: T } allows null; { record: T } is an object with any keys.
export type Shape = 'string' | 'int' | 'number' | 'boolean' | { nullable: Shape } | { record: Shape } | Shape[] | { [k: string]: Shape };

export function shapeErrors(value: unknown, shape: Shape, path = '$'): string[] {
  if (typeof shape === 'string') {
    if (shape === 'string') return typeof value === 'string' ? [] : [`${path} is not a string`];
    if (shape === 'boolean') return typeof value === 'boolean' ? [] : [`${path} is not a boolean`];
    if (shape === 'number') return typeof value === 'number' && Number.isFinite(value) ? [] : [`${path} is not a number`];
    return Number.isInteger(value) ? [] : [`${path} is not an integer (${String(value)})`];
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [`${path} is not an array`];
    const t = shape[0] as Shape;
    return value.flatMap((v, i) => shapeErrors(v, t, `${path}[${i}]`));
  }
  const keys = Object.keys(shape);
  if (keys.length === 1 && keys[0] === 'nullable') {
    return value === null ? [] : shapeErrors(value, (shape as { nullable: Shape }).nullable, path);
  }
  if (keys.length === 1 && keys[0] === 'record') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} is not an object`];
    return Object.entries(value).flatMap(([k, v]) => shapeErrors(v, (shape as { record: Shape }).record, `${path}.${k}`));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} is not an object`];
  const errs: string[] = [];
  const obj = value as Record<string, unknown>;
  for (const k of keys) {
    if (!(k in obj)) errs.push(`${path}.${k} is missing`);
    else errs.push(...shapeErrors(obj[k], (shape as Record<string, Shape>)[k] as Shape, `${path}.${k}`));
  }
  for (const k of Object.keys(obj)) if (!(k in shape)) errs.push(`${path}.${k} is not in the contract`);
  return errs;
}
