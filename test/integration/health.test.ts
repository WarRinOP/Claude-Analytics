// GET /api/health end to end over a real ingest: an injected malformed line, an unknown record type, a deleted file, a symlink
// alias, Claude Code versions and entrypoints, and a cost snapshot each show up with the numbers the archive holds.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIngest } from '../../src/ingest/ingest.ts';
import { health, type Ctx } from '../../src/metrics/queries.ts';
import { handleApi } from '../../src/server/routes.ts';
import { openAndMigrate } from '../../src/store/migrate.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { IDLE } from '../unit/metricsHelpers.ts';
import { useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
let work: string;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-health-')));
});
afterEach(() => {
  env.restore();
  rmSync(work, { recursive: true, force: true });
});

const SID = 'aaaaaaaa-0000-0000-0000-00000000000a';
const SID2 = 'bbbbbbbb-0000-0000-0000-00000000000b';

async function archive(): Promise<{ ctx: Ctx; projects: string }> {
  const projects = join(work, 'claude', 'projects');
  put(join(projects, '-work-demo', `${SID}.jsonl`), [
    userLine(SID, 'u1', 0),
    usageLine(SID, 1, { stop: true }),
    'this is not json SECRET_TEXT',
    JSON.stringify({ type: 'future-thing', version: '9.9.9', payload: 'SECRET_TEXT' }),
    usageLine(SID, 2, { stop: true }),
  ]);
  put(join(projects, '-work-demo', `${SID2}.jsonl`), [userLine(SID2, 'u2', 100), usageLine(SID2, 3, { stop: true })]);
  symlinkSync(join(projects, '-work-demo'), join(projects, '-work-alias'));
  const { db } = openAndMigrate(join(env.dir, 'health.db'));
  await runIngest(db, { roots: [projects], full: false, trigger: 'cli', now: () => Date.parse('2026-10-27T10:00:00Z') });
  const ctx: Ctx = { db, tz: 'UTC', now: () => Date.parse('2026-10-27T10:05:00Z'), retentionDays: 30, sourceRoot: projects, sessionsDir: join(work, 'claude', 'sessions') };
  return { ctx, projects };
}

describe('/api/health over a real ingest', () => {
  it('shows the malformed line, the unknown type, the version, the entrypoint and the alias', async () => {
    const { ctx, projects } = await archive();
    const h = health(ctx, IDLE);
    expect(h.sourceRoot).toBe(projects);
    expect(h.retentionDays).toBe(30);
    expect(h.completeFrom).not.toBeNull();
    expect(h.errors.total).toBe(1);
    expect(h.recentErrors).toHaveLength(1);
    expect(h.recentErrors[0]).toMatchObject({ file: `-work-demo/${SID}.jsonl`, lineNo: 3, error: 'invalid json' });
    expect(h.recentErrors[0]?.byteOffset).toBeGreaterThan(0);
    expect(h.unknownTypes).toEqual([{ type: 'future-thing', version: '9.9.9', count: 1, lastSeenAt: expect.any(Number) }]);
    expect(h.versions).toEqual([{ version: '9.9.9', responses: 3, firstTs: expect.any(Number), lastTs: expect.any(Number) }]);
    expect(h.entrypoints).toEqual([{ entrypoint: 'cli', responses: 3 }]);
    expect(h.aliases).toEqual([{ aliasDir: '-work-alias', targetDir: join(projects, '-work-demo') }]);
    // the Projects table lists the alias under the project the link points at, though the link was written as a full path
    const rows = (handleApi({ ...ctx, syncStatus: () => IDLE }, '/api/projects', new URLSearchParams()).body as { rows: Array<{ projectDir: string; aliases: string[] }> }).rows;
    expect(rows.find((r) => r.projectDir === '-work-demo')?.aliases).toEqual(['-work-alias']);
    expect(h.lastPass).toMatchObject({ at: Date.parse('2026-10-27T10:00:00Z'), trigger: 'cli', filesScanned: 2, filesChanged: 2, errors: 1 });
    expect(h.lastPass?.linesRead).toBeGreaterThan(5);
    expect(h.canary.status).toBe('unknown'); // there is no sessions folder in this synthetic setup
    // text of the bad line and of the unknown record never reaches the answer
    expect(JSON.stringify(h)).not.toContain('SECRET_TEXT');
  });

  it('a deleted source file counts as deleted, its session stays', async () => {
    const { ctx, projects } = await archive();
    rmSync(join(projects, '-work-demo', `${SID2}.jsonl`));
    await runIngest(ctx.db, { roots: [projects], full: false, trigger: 'poll', now: () => Date.parse('2026-10-27T10:01:00Z') });
    const h = health(ctx, IDLE);
    expect(h.files).toEqual({ active: 1, deleted: 1 });
    expect(h.sessions).toEqual({ total: 2, sourceDeleted: 1 });
    expect(h.lastPass?.trigger).toBe('poll');
  });

  it('keeps at most 50 recent errors, newest first, and the total is the real count', async () => {
    const { ctx, projects } = await archive();
    const lines = Array.from({ length: 60 }, (_, i) => `broken line ${i}`);
    writeFileSync(join(projects, '-work-demo', `${SID2}.jsonl`), lines.join('\n') + '\n', { flag: 'a' });
    await runIngest(ctx.db, { roots: [projects], full: false, trigger: 'poll', now: () => Date.parse('2026-10-27T10:02:00Z') });
    const h = health(ctx, IDLE);
    expect(h.errors.total).toBe(61);
    expect(h.recentErrors).toHaveLength(50);
    expect(h.recentErrors[0]?.at).toBe(Date.parse('2026-10-27T10:02:00Z'));
  });

  it('the cost check counts sessions with a snapshot and lists the worst differences', async () => {
    const projects = join(work, 'claude', 'projects');
    const snap = (sid: string, tokens: number): string =>
      JSON.stringify({ type: 'cost-state', sessionId: sid, startTime: 1, totalCostUSD: 1, totalDuration: 10, modelUsage: { 'claude-sonnet-5-5': { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
    // SID: our total is 11 + 1005 + ... = exact match; SID2: the snapshot says 10 times more than the transcript holds
    put(join(projects, '-work-demo', `${SID}.jsonl`), [userLine(SID, 'u1', 0), usageLine(SID, 1, { stop: true, out: 0 })]);
    put(join(projects, '-work-demo', `${SID2}.jsonl`), [userLine(SID2, 'u2', 100), usageLine(SID2, 2, { stop: true, out: 0 }), snap(SID2, 100_000)]);
    const { db } = openAndMigrate(join(env.dir, 'cost.db'));
    await runIngest(db, { roots: [projects], full: false, trigger: 'cli' });
    const h = health({ db, tz: 'UTC', now: Date.now, sourceRoot: projects, sessionsDir: join(work, 'none') }, IDLE);
    expect(h.costCheck.sessionsWithSnapshot).toBe(1);
    expect(h.costCheck.compared).toBe(1);
    expect(h.costCheck.withinOnePercent).toBe(0);
    expect(h.costCheck.exceptions).toHaveLength(1);
    expect(h.costCheck.exceptions[0]?.sessionId).toBe(SID2);
    expect(h.costCheck.exceptions[0]?.theirs).toBe(100_000);
    expect(h.costCheck.exceptions[0]?.percent).toBeLessThan(-90);
  });

  it('the canary reads the sessions folder next to the source folder by default and warns on a stalled transcript', async () => {
    const { ctx, projects } = await archive();
    const sessions = join(work, 'claude', 'sessions');
    mkdirSync(sessions);
    const now = ctx.now();
    writeFileSync(join(sessions, '1.json'), JSON.stringify({ sessionId: SID, updatedAt: now - 60_000 }));
    // the transcript was written when the fixture was created: far more than 10 minutes before the pretend "now" of 2027
    const later = health({ ...ctx, now: () => Date.now() + 3_600_000, sessionsDir: undefined }, IDLE);
    expect(later.canary.status).toBe('ok'); // the registry entry is an hour old by then: nothing to compare
    writeFileSync(join(sessions, '1.json'), JSON.stringify({ sessionId: SID, updatedAt: Date.now() + 3_599_000 }));
    const stalled = health({ ...ctx, now: () => Date.now() + 3_600_000, sessionsDir: undefined }, IDLE);
    expect(stalled.canary.status).toBe('warning');
    expect(stalled.canary.message).toContain('aaaaaaaa');
    void projects;
  });
});
