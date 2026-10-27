// The Windows defect, reproduced on any system: NTFS file ids are 64 bit and usually above 2^53, so discovery used to refuse every
// file. Here discovery is wrapped so that every file reports ids above 2^63 (derived from the real ones, stable between passes),
// and a whole ingest history runs over them: first pass, unchanged pass, append, delete, come back.
import { appendFileSync, mkdtempSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runIngest, type IngestOptions } from '../../src/ingest/ingest.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { openAndMigrate, SOURCE_FILES_DUMP_SQL, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';
import { removeTemp } from '../unit/helpers.ts';

vi.mock('../../src/ingest/discover.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ingest/discover.ts')>();
  return {
    ...actual,
    discover: (root: string) => {
      const d = actual.discover(root);
      return { ...d, files: d.files.map((f) => ({ ...f, dev: f.dev + (1n << 62n), ino: (1n << 63n) + (f.ino << 1n) + 0x1234_5678_9abc_def1n })) };
    },
  };
});

let env: TempEnv;
let work: string;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-bigid-')));
});
afterEach(() => {
  env.restore();
  removeTemp(work);
});

const SID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SID_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const opts = (root: string, over: Partial<IngestOptions> = {}): IngestOptions => ({ roots: [root], full: false, trigger: 'test', now: () => 1_000, ...over });
const count = (db: ReturnType<typeof openAndMigrate>['db'], sql: string): number => (db.prepare(sql).get() as { n: number }).n;

describe('ingest over file ids above 2^63', () => {
  it('reads, recognises an unchanged file, appends, marks a deleted file and restores it', async () => {
    const root = join(work, 'projects');
    const a = join(root, '-work-demo', `${SID_A}.jsonl`);
    const b = join(root, '-work-demo', `${SID_B}.jsonl`);
    const sub = join(root, '-work-demo', SID_A, 'subagents', 'agent-x1.jsonl');
    put(a, [userLine(SID_A, 'u1', 0), usageLine(SID_A, 1, { out: 5, stop: true, ts: 10 }), usageLine(SID_A, 2, { out: 6, stop: true, ts: 20 })]);
    put(b, [userLine(SID_B, 'ub1', 1), usageLine(SID_B, 3, { out: 7, stop: true, ts: 30 })]);
    put(sub, [usageLine(SID_A, 100, { out: 8, stop: true, subagent: true, ts: 40 })]);
    const { db } = openAndMigrate(join(env.dir, 'big.db'));

    // first pass: nothing is refused, everything is read
    const first = await runIngest(db, opts(root));
    expect(first).toMatchObject({ filesScanned: 3, filesChanged: 3, errors: 0 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM usage_events')).toBe(4);
    expect(count(db, "SELECT COUNT(*) AS n FROM source_files WHERE status = 'active'")).toBe(3);
    // the stored form is the signed one: an id above 2^63 is negative in the column, and reads back exactly
    const stored = db.prepare('SELECT CAST(ino AS TEXT) AS ino FROM source_files').all() as Array<{ ino: string }>;
    expect(stored.every((r) => BigInt(r.ino) < 0n)).toBe(true);

    // second pass: the known rows are found by their big identity, so nothing is read again
    const second = await runIngest(db, opts(root));
    expect(second).toMatchObject({ filesScanned: 3, filesChanged: 0, eventsUpserted: 0, filesMarkedDeleted: 0 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM source_files')).toBe(3);

    // an append is read from the stored offset
    appendFileSync(a, usageLine(SID_A, 4, { out: 9, stop: true, ts: 50 }) + '\n');
    const third = await runIngest(db, opts(root));
    expect(third).toMatchObject({ filesChanged: 1, eventsUpserted: 1 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM usage_events')).toBe(5);

    // a file that goes away is flagged deleted, its rows stay; the same file coming back is active again
    const away = join(work, 'away.jsonl');
    renameSync(b, away);
    const fourth = await runIngest(db, opts(root));
    expect(fourth.filesMarkedDeleted).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM source_files WHERE status = 'deleted'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM usage_events')).toBe(5);
    renameSync(away, b);
    const fifth = await runIngest(db, opts(root));
    expect(fifth).toMatchObject({ filesChanged: 0, filesMarkedDeleted: 0 });
    expect(count(db, "SELECT COUNT(*) AS n FROM source_files WHERE status = 'deleted'")).toBe(0);

    // a full pass over the same ids reads everything once more and ends with the same archive
    const before = db.prepare(SOURCE_FILES_DUMP_SQL).all().map((r) => [r['dev'], r['ino'], r['path']]);
    await runIngest(db, opts(root, { full: true }));
    expect(count(db, 'SELECT COUNT(*) AS n FROM usage_events')).toBe(5);
    expect(db.prepare(SOURCE_FILES_DUMP_SQL).all().map((r) => [r['dev'], r['ino'], r['path']])).toEqual(before);
  });

  it('a second root with the same files (same ids) is read once', async () => {
    const root = join(work, 'projects');
    put(join(root, '-work-demo', `${SID_A}.jsonl`), [usageLine(SID_A, 1, { out: 5, stop: true, ts: 10 })]);
    const { db } = openAndMigrate(join(env.dir, 'big2.db'));
    const r = await runIngest(db, { ...opts(root), roots: [root, root] });
    expect(r.filesScanned).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM source_files')).toBe(1);
  });
});
