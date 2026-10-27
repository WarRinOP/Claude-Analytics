// The transcripts-may-have-moved canary against a temp sessions folder and temp transcript files.
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCanary, displayPath } from '../../src/metrics/health.ts';
import { upsertSourceFile } from '../../src/store/repo.ts';
import { freshDb, useTempDataDir, type TempEnv } from './storeHelpers.ts';
import { removeTemp } from './helpers.ts';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const MIN = 60_000;

let env: TempEnv;
let work: string;
let sessions: string;
let projects: string;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-canary-')));
  sessions = join(work, 'sessions');
  projects = join(work, 'projects');
  mkdirSync(sessions);
  mkdirSync(join(projects, '-work-demo'), { recursive: true });
});
afterEach(() => {
  env.restore();
  removeTemp(work);
});

function registry(file: string, body: Record<string, unknown>): void {
  writeFileSync(join(sessions, file), JSON.stringify(body));
}

// A transcript file last written `ageMs` before NOW, tracked in the archive under `sessionId`.
let ino = 100n;
function transcript(db: ReturnType<typeof freshDb>['db'], sessionId: string, ageMs: number, tracked = true): string {
  const path = join(projects, '-work-demo', `${sessionId}.jsonl`);
  writeFileSync(path, '{}\n');
  utimesSync(path, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
  if (tracked) {
    ino += 1n;
    upsertSourceFile(db, { dev: 9n, ino, path, projectDir: '-work-demo', sessionId, agentId: null, isSubagent: false, size: 3, mtimeMs: NOW - ageMs, now: NOW });
  }
  return path;
}

const opts = (): { sessionsDir: string; sourceRoot: string; now: number } => ({ sessionsDir: sessions, sourceRoot: projects, now: NOW });

describe('canary', () => {
  it('ok: a session updated 3 minutes ago whose transcript grew 2 minutes ago', () => {
    const { db } = freshDb(env.dir);
    registry('111.json', { sessionId: 'sess-live-1', updatedAt: NOW - 3 * MIN, cwd: '/secret/place', name: 'private name' });
    transcript(db, 'sess-live-1', 2 * MIN);
    const c = checkCanary(db, opts());
    expect(c.status).toBe('ok');
    expect(c.message).toBe('1 session was updated in the last 10 minutes and its transcript is growing.');
    expect(c.message).not.toContain('secret');
  });

  it('ok: nothing was updated in the last 10 minutes (old registry entries are ignored)', () => {
    const { db } = freshDb(env.dir);
    registry('111.json', { sessionId: 'sess-old', updatedAt: NOW - 3 * 3_600_000 });
    transcript(db, 'sess-old', 3 * 3_600_000);
    const c = checkCanary(db, opts());
    expect(c.status).toBe('ok');
    expect(c.message).toContain('nothing to compare');
  });

  it('ok: an empty sessions folder', () => {
    const { db } = freshDb(env.dir);
    expect(checkCanary(db, opts()).status).toBe('ok');
  });

  it('warning: updated 4 minutes ago, transcript last written 25 minutes ago', () => {
    const { db } = freshDb(env.dir);
    registry('222.json', { sessionId: 'abcd1234-aaaa-bbbb', updatedAt: NOW - 4 * MIN });
    transcript(db, 'abcd1234-aaaa-bbbb', 25 * MIN);
    const c = checkCanary(db, opts());
    expect(c.status).toBe('warning');
    expect(c.message).toContain('Session abcd1234 was updated in the last 10 minutes, but its transcript has not changed for 25 min.');
    expect(c.message).toContain('Claude Code may be writing transcripts somewhere else');
  });

  it('warning: says how many sessions when there are several', () => {
    const { db } = freshDb(env.dir);
    for (const [i, age] of [[1, 15], [2, 40]] as const) {
      registry(`${i}.json`, { sessionId: `sess-stuck-${i}`, updatedAt: NOW - MIN });
      transcript(db, `sess-stuck-${i}`, age * MIN);
    }
    const c = checkCanary(db, opts());
    expect(c.status).toBe('warning');
    expect(c.message).toContain('2 sessions were updated in the last 10 minutes, but their transcripts have not changed for at least 15 min.');
  });

  it('judges the file on disk, not a stale archive row: a transcript that grew since the last pass is fine', () => {
    const { db } = freshDb(env.dir);
    registry('333.json', { sessionId: 'sess-grew', updatedAt: NOW - MIN });
    const path = transcript(db, 'sess-grew', 30 * MIN);
    utimesSync(path, (NOW - MIN) / 1000, (NOW - MIN) / 1000);
    expect(checkCanary(db, opts()).status).toBe('ok');
  });

  it('finds a transcript that is not in the archive yet by its file name', () => {
    const { db } = freshDb(env.dir);
    registry('444.json', { sessionId: 'sess-new', updatedAt: NOW - MIN });
    transcript(db, 'sess-new', MIN, false);
    expect(checkCanary(db, opts()).message).toContain('growing');
  });

  it('a session with no transcript yet is not a warning (it is normal before the first message)', () => {
    const { db } = freshDb(env.dir);
    registry('555.json', { sessionId: 'sess-empty', updatedAt: NOW - MIN });
    const c = checkCanary(db, opts());
    expect(c.status).toBe('ok');
    expect(c.message).toContain('no transcript yet');
  });

  it('unknown: the folder does not exist, or is not a folder', () => {
    const { db } = freshDb(env.dir);
    const missing = checkCanary(db, { ...opts(), sessionsDir: join(work, 'nope') });
    expect(missing.status).toBe('unknown');
    expect(missing.message).toContain('does not exist');
    writeFileSync(join(work, 'afile'), 'x');
    const notDir = checkCanary(db, { ...opts(), sessionsDir: join(work, 'afile') });
    expect(notDir.status).toBe('unknown');
    expect(notDir.message).toContain('could not be read');
  });

  it('unknown: files are there but none can be read', () => {
    const { db } = freshDb(env.dir);
    writeFileSync(join(sessions, '1.json'), 'not json at all');
    writeFileSync(join(sessions, '2.json'), JSON.stringify({ sessionId: 7, updatedAt: 'later' }));
    const c = checkCanary(db, opts());
    expect(c.status).toBe('unknown');
    expect(c.message).toContain('None of the 2 files');
  });

  it('reads only .json files: a .key file next to them is never opened', () => {
    const { db } = freshDb(env.dir);
    writeFileSync(join(sessions, '10173.abc.key'), JSON.stringify({ sessionId: 'sess-key', updatedAt: NOW }));
    transcript(db, 'sess-key', 99 * MIN);
    expect(checkCanary(db, opts()).message).toContain('nothing to compare');
  });
});

describe('displayPath', () => {
  it('shows a file relative to the source folder, else the project folder and the file', () => {
    expect(displayPath('/a/projects/-work-x/s1.jsonl', '/a/projects')).toBe('-work-x/s1.jsonl');
    expect(displayPath('/a/projects/-work-x/s1/subagents/agent-1.jsonl', '/a/projects')).toBe('-work-x/s1/subagents/agent-1.jsonl');
    expect(displayPath('/elsewhere/-work-y/s2.jsonl', '/a/projects')).toBe('-work-y/s2.jsonl');
    expect(displayPath(null, '/a/projects')).toBe('(unknown file)');
  });
});
