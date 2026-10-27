// `node src/cli.ts doctor` against temp folders: the report, the exit code, and that it reads without writing.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Health } from '../../src/api/types.ts';
import { renderDoctor } from '../../src/cli/doctor.ts';
import { openAndMigrate } from '../../src/store/migrate.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SID = 'aaaaaaaa-0000-0000-0000-00000000000a';
const SID2 = 'bbbbbbbb-0000-0000-0000-00000000000b';

let env: TempEnv;
let work: string;
let config: string;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-doctor-')));
  config = join(work, 'claude');
  mkdirSync(config, { recursive: true });
});
afterEach(() => {
  env.restore();
  rmSync(work, { recursive: true, force: true });
});

function run(command: string, args: string[] = []): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ['src/cli.ts', command, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LEDGER_DATA_DIR: env.dir, CLAUDE_CONFIG_DIR: config, LEDGER_TZ: 'UTC' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function transcripts(): string {
  const projects = join(config, 'projects');
  put(join(projects, '-work-demo', `${SID}.jsonl`), [
    userLine(SID, 'u1', 0),
    usageLine(SID, 1, { stop: true }),
    'this is not json SECRET_TEXT',
    JSON.stringify({ type: 'future-thing', version: '9.9.9', payload: 'SECRET_TEXT' }),
    usageLine(SID, 2, { stop: true }),
  ]);
  put(join(projects, '-work-demo', `${SID2}.jsonl`), [userLine(SID2, 'u2', 100), usageLine(SID2, 3, { stop: true })]);
  return projects;
}

describe('doctor', () => {
  it('says plainly that there is no archive yet, and exits 1', () => {
    const r = run('doctor');
    expect(r.code).toBe(1);
    expect(r.out).toContain('There is no archive yet at');
    expect(r.out).toContain('node src/cli.ts ingest');
    expect(existsSync(join(env.dir, 'ledger.db'))).toBe(false); // doctor does not create one
  });

  it('refuses options and a bad time zone in words', () => {
    expect(run('doctor', ['--fix']).err).toContain('doctor takes no options');
    const bad = spawnSync(process.execPath, ['src/cli.ts', 'doctor'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LEDGER_DATA_DIR: env.dir, CLAUDE_CONFIG_DIR: config, LEDGER_TZ: 'Not/AZone' } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('not valid');
  });

  it('a malformed line, an unknown record type and a deleted file all show up, and nothing is written', () => {
    const projects = transcripts();
    expect(run('ingest').code).toBe(0);
    rmSync(join(projects, '-work-demo', `${SID2}.jsonl`));
    expect(run('ingest').code).toBe(0);
    const before = run('verify').out;
    const r = run('doctor');
    expect(r.code).toBe(0);
    const text = r.out;
    expect(text.split('\n').length).toBeLessThanOrEqual(60);
    expect(text).toContain('Usage Ledger doctor, version');
    // the malformed line: file relative to the source folder, line, byte offset, the reason in words
    expect(text).toContain(`-work-demo/${SID}.jsonl, line 3, byte `);
    expect(text).toContain('invalid json');
    expect(text).toContain('The line is not valid JSON, so it was skipped.');
    // the unknown record type with its version and count
    expect(text).toContain('future-thing (Claude Code 9.9.9): 1 line');
    // the deleted file
    expect(text).toContain('1 file deleted at the source');
    expect(text).toContain('Service: not running');
    expect(text).toContain(projects);
    expect(text).not.toContain('SECRET_TEXT');
    expect(text).not.toMatch(/ [-–—] |[–—]/u);
    // reading only: the archive says the same afterwards, and no lock file is left
    expect(run('verify').out).toBe(before);
    expect(existsSync(join(env.dir, 'ingest.lock'))).toBe(false);
  });

  it('exits 1 when the canary warns: a session was updated a minute ago and its transcript has been still for an hour', () => {
    const projects = transcripts();
    expect(run('ingest').code).toBe(0);
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(join(projects, '-work-demo', `${SID}.jsonl`), old, old);
    const sessions = join(config, 'sessions');
    mkdirSync(sessions);
    writeFileSync(join(sessions, '77.json'), JSON.stringify({ sessionId: SID, updatedAt: Date.now() - 60_000, cwd: '/private/place' }));
    const r = run('doctor');
    expect(r.code).toBe(1);
    expect(r.out).toContain('[problem] Transcript location: Transcripts may have moved. Session aaaaaaaa was updated in the last 10 minutes');
    expect(r.out).toContain('Status: Needs attention');
    expect(r.out).not.toContain('/private/place');
  });

  it('an empty database file counts as no archive', () => {
    writeFileSync(join(env.dir, 'ledger.db'), '');
    const r = run('doctor');
    expect(r.code).toBe(1);
    expect(r.out).toContain('There is no archive yet');
  });

  it('an archive from an older schema is named as such and left alone', () => {
    const only1 = join(work, 'only1');
    mkdirSync(only1);
    copyFileSync(join(ROOT, 'src', 'store', 'migrations', '0001_init.sql'), join(only1, '0001_init.sql'));
    const { db } = openAndMigrate(join(env.dir, 'ledger.db'), { migrationsDir: only1 });
    db.close();
    const r = run('doctor');
    expect(r.code).toBe(1);
    expect(r.out).toContain('is from an older version (missing schema 2, 3, 4)');
    expect(r.out).toContain('node src/cli.ts ingest');
  });
});

describe('renderDoctor', () => {
  const NOW = Date.parse('2026-10-27T12:00:00Z');
  const heavy: Health = {
    status: 'degraded',
    appVersion: '0.0.1',
    tz: 'UTC',
    archiveStart: '2026-09-01',
    sync: { running: false, lastPassAt: NOW, lastSuccessAt: NOW, lastError: 'the newest pass never finished', watcherAlive: false },
    files: { active: 100, deleted: 5 },
    sessions: { total: 80, sourceDeleted: 3 },
    errors: { total: 40 },
    dbBytes: 5_000_000,
    completeFrom: '2026-09-27',
    retentionDays: 30,
    sourceRoot: '/x/projects',
    lastPass: { at: NOW, durationMs: 800, trigger: 'poll', filesScanned: 100, filesChanged: 2, linesRead: 10, errors: 40 },
    recentErrors: Array.from({ length: 50 }, (_, i) => ({ file: `-work-demo/s${i}.jsonl`, lineNo: i + 1, byteOffset: i * 10, error: 'invalid json', at: NOW - i })),
    unknownTypes: Array.from({ length: 12 }, (_, i) => ({ type: `type-${i}`, version: '9.9.9', count: i + 1, lastSeenAt: NOW })),
    missingFields: Array.from({ length: 9 }, (_, i) => ({ field: `field_${i}`, version: `2.1.${i}`, count: 3 })),
    versions: Array.from({ length: 22 }, (_, i) => ({ version: `2.1.${i}`, responses: 10 + i, firstTs: NOW - 1e7, lastTs: NOW - i })),
    entrypoints: [{ entrypoint: 'cli', responses: 5 }],
    aliases: Array.from({ length: 9 }, (_, i) => ({ aliasDir: `-a${i}`, targetDir: `-t${i}` })),
    costCheck: { sessionsWithSnapshot: 20, compared: 20, withinOnePercent: 10, exceptions: Array.from({ length: 10 }, (_, i) => ({ sessionId: `sess-${i}xxxxxxxx`, ours: 100 + i, theirs: 50, percent: 100 })) },
    canary: { status: 'warning', message: 'Session abcd1234 was updated in the last 10 minutes, but its transcript has not changed for 30 min.' },
    prices: { tableDate: '2026-10-06', unpricedModels: [{ model: 'claude-future-9', responses: 4 }], cacheWriteRemainderEvents: 0 },
  };

  it('stays near 60 lines however much there is to report, and caps long lists', () => {
    const lines = renderDoctor(heavy, { now: NOW, service: null });
    expect(lines.length).toBeLessThanOrEqual(70);
    expect(lines.join('\n')).toContain('Status: Needs attention (sync reports a problem)');
    expect(lines.join('\n')).toContain('Ingest errors (newest first, 6 of 40)');
  });

  it('prints the service line for a running service', () => {
    expect(renderDoctor({ ...heavy, status: 'ok' }, { now: NOW, service: 4242 })[2]).toBe('Service: running (process 4242).');
  });
});
