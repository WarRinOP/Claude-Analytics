// File identity is (dev, ino), bigint in memory and the signed 64 bit form in the INTEGER columns.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import {
  fromStoredId,
  getSourceFile,
  listActiveSourceFiles,
  markDeleted,
  setOffset,
  toStoredId,
  upsertSourceFile,
  type SourceFileInput,
} from '../../src/store/repo.ts';
import { openAndMigrate, SOURCE_FILES_DUMP_SQL, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

let n = 0;
const freshPath = (): string => join(env.dir, `identity-${(n += 1)}.db`);

const base = { projectDir: 'p', sessionId: 's', agentId: null, isSubagent: false, size: 10, mtimeMs: 20, now: 30 } as const;
const input = (dev: bigint, ino: bigint, path = `/src/${ino}.jsonl`): SourceFileInput => ({ ...base, dev, ino, path });

// The ids a Windows volume really produces sit above 2^53 and often above 2^63.
const BIG: bigint[] = [2n ** 53n, 2n ** 53n + 1n, 2n ** 60n + 1n, 2n ** 62n + 12345n, 2n ** 63n - 1n, 2n ** 63n, 2n ** 63n + 1n, 0x0007_0000_0000_1234n << 8n, 2n ** 64n - 2n, 2n ** 64n - 1n];

function raw(db: Db, id: number): { dev: string; ino: string; devType: string; inoType: string } {
  const r = db.prepare('SELECT CAST(dev AS TEXT) AS dev, CAST(ino AS TEXT) AS ino, typeof(dev) AS dt, typeof(ino) AS it FROM source_files WHERE id = ?').get(id) as {
    dev: string;
    ino: string;
    dt: string;
    it: string;
  };
  return { dev: r.dev, ino: r.ino, devType: r.dt, inoType: r.it };
}

describe('64 bit identity round trip', () => {
  it('converts to the signed form and back without loss for every unsigned 64 bit value', () => {
    for (const x of [0n, 1n, ...BIG]) {
      const stored = toStoredId(x);
      expect(stored >= -(2n ** 63n) && stored < 2n ** 63n).toBe(true);
      expect(fromStoredId(stored.toString())).toBe(x);
    }
    expect(toStoredId(2n ** 64n - 1n)).toBe(-1n);
    expect(toStoredId(2n ** 63n)).toBe(-(2n ** 63n));
  });

  it('a value below 2^63 is stored as the very same number', () => {
    for (const x of [0n, 1n, 16777234n, 8590122345n, 2n ** 53n, 2n ** 62n + 5n, 2n ** 63n - 1n]) expect(toStoredId(x)).toBe(x);
  });

  it('stores, finds and lists an id above 2^53 and above 2^63 exactly', () => {
    const { db } = openAndMigrate(freshPath());
    for (const x of BIG) {
      const id = upsertSourceFile(db, input(x, x));
      const row = getSourceFile(db, x, x);
      expect(row?.id, String(x)).toBe(id);
      expect(row?.dev).toBe(x);
      expect(row?.ino).toBe(x);
      expect(typeof row?.ino).toBe('bigint');
      const stored = raw(db, id);
      expect(stored.ino).toBe(BigInt.asIntN(64, x).toString());
      expect([stored.devType, stored.inoType]).toEqual(['integer', 'integer']);
    }
    const listed = listActiveSourceFiles(db);
    expect(listed.map((r) => r.ino).sort()).toEqual([...BIG].sort());
    expect(listed.every((r) => r.dev === r.ino)).toBe(true);
  });

  it('two ids that differ only in the low bits of a number above 2^53 are two files', () => {
    const { db } = openAndMigrate(freshPath());
    const a = 2n ** 60n + 1n;
    const b = 2n ** 60n + 2n; // as doubles a and b are the same number
    expect(Number(a)).toBe(Number(b));
    const idA = upsertSourceFile(db, input(7n, a));
    const idB = upsertSourceFile(db, input(7n, b));
    expect(idA).not.toBe(idB);
    expect(getSourceFile(db, 7n, a)?.id).toBe(idA);
    expect(getSourceFile(db, 7n, b)?.id).toBe(idB);
    expect(getSourceFile(db, 7n, a + 2n)).toBeUndefined();
    // the same id on another device is another file
    expect(upsertSourceFile(db, input(8n, a))).not.toBe(idA);
  });

  it('upserting the same big identity again refreshes the row, offsets and deletion work by it', () => {
    const { db } = openAndMigrate(freshPath());
    const x = 2n ** 63n + 98765n;
    const id = upsertSourceFile(db, input(3n, x, '/a/one.jsonl'));
    setOffset(db, id, 10, 2, 'abc', 10, 20, 31);
    markDeleted(db, id, 40);
    expect(listActiveSourceFiles(db)).toEqual([]);
    expect(getSourceFile(db, 3n, x)).toMatchObject({ status: 'deleted', deletedDetectedAt: 40, byteOffset: 10, linesRead: 2, headHash: 'abc', path: '/a/one.jsonl' });
    expect(upsertSourceFile(db, { ...input(3n, x, '/b/two.jsonl'), size: 50, now: 70 })).toBe(id);
    expect(getSourceFile(db, 3n, x)).toMatchObject({ status: 'active', deletedDetectedAt: null, byteOffset: 10, path: '/b/two.jsonl', size: 50, firstSeenAt: 30 });
    expect(listActiveSourceFiles(db)).toEqual([{ id, dev: 3n, ino: x, path: '/b/two.jsonl' }]);
  });

  it('the full dump of a table with big ids is exact and JSON safe', () => {
    const { db } = openAndMigrate(freshPath());
    upsertSourceFile(db, input(2n ** 64n - 1n, 2n ** 63n + 3n));
    const rows = db.prepare(SOURCE_FILES_DUMP_SQL).all() as Array<{ dev: string; ino: string }>;
    expect(rows.map((r) => [r.dev, r.ino])).toEqual([[BigInt.asIntN(64, 2n ** 64n - 1n).toString(), BigInt.asIntN(64, 2n ** 63n + 3n).toString()]]);
  });
});

// What the code before 64 bit identity did: bound dev and ino as JavaScript numbers. On macOS every id fits, so a database made
// that way must be read, matched and updated by the new code without changing a stored number.
const OLD_UPSERT = `INSERT INTO source_files (dev, ino, path, project_dir, session_id, agent_id, is_subagent, size, mtime_ms, first_seen_at)
     VALUES (@dev, @ino, @path, @projectDir, @sessionId, @agentId, @isSubagent, @size, @mtimeMs, @now)
     ON CONFLICT(dev, ino) DO UPDATE SET
       path = excluded.path,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       status = 'active',
       deleted_detected_at = NULL
     RETURNING id`;

// Typical macOS values: the APFS volume number and file numbers of different sizes.
const MAC: Array<[number, number]> = [
  [16777234, 1],
  [16777234, 38402837],
  [16777234, 8590122345],
  [16777235, 12884901888],
  [1, 2 ** 53 - 1],
];

function oldPathInsert(db: Db, dev: number, ino: number, path: string): number {
  return (
    db.prepare(OLD_UPSERT).get({ dev, ino, path, projectDir: 'p', sessionId: 's', agentId: null, isSubagent: 0, size: 5, mtimeMs: 6, now: 7 }) as { id: number }
  ).id;
}

describe('a database made before 64 bit identity (macOS values)', () => {
  it('the new code stores exactly the numbers the old code stored', () => {
    const oldDb = openAndMigrate(freshPath()).db;
    const newDb = openAndMigrate(freshPath()).db;
    for (const [dev, ino] of MAC) {
      oldPathInsert(oldDb, dev, ino, `/src/${ino}.jsonl`);
      upsertSourceFile(newDb, { ...input(BigInt(dev), BigInt(ino)), size: 5, mtimeMs: 6, now: 7 });
    }
    const rawRows = (db: Db): string => JSON.stringify(db.prepare('SELECT id, dev, ino, typeof(dev) AS dt, typeof(ino) AS it FROM source_files ORDER BY id').all());
    expect(rawRows(newDb)).toBe(rawRows(oldDb));
    expect(newDb.prepare(SOURCE_FILES_DUMP_SQL).all()).toEqual(oldDb.prepare(SOURCE_FILES_DUMP_SQL).all());
  });

  it('a copy of an old database is matched by identity, updated in place and listed, with no new row', () => {
    const oldPath = freshPath();
    const old = openAndMigrate(oldPath).db;
    const ids = MAC.map(([dev, ino]) => oldPathInsert(old, dev, ino, `/src/${ino}.jsonl`));
    old.prepare('UPDATE source_files SET byte_offset = 123, lines_read = 4, head_hash = ? WHERE id = ?').run('deadbeef', ids[2] as number);
    old.close();

    const copyPath = freshPath();
    copyFileSync(oldPath, copyPath);
    const copy = openAndMigrate(copyPath).db;

    // every row is found by its identity, with the stored progress
    MAC.forEach(([dev, ino], i) => {
      const row = getSourceFile(copy, BigInt(dev), BigInt(ino));
      expect(row?.id).toBe(ids[i]);
      expect(row?.dev).toBe(BigInt(dev));
      expect(row?.ino).toBe(BigInt(ino));
    });
    expect(getSourceFile(copy, BigInt(MAC[2]?.[0] ?? 0), BigInt(MAC[2]?.[1] ?? 0))).toMatchObject({ byteOffset: 123, linesRead: 4, headHash: 'deadbeef' });
    expect(listActiveSourceFiles(copy).map((r) => [r.dev, r.ino])).toEqual(MAC.map(([dev, ino]) => [BigInt(dev), BigInt(ino)]));

    // seeing the same files again updates them in place
    const before = copy.prepare(SOURCE_FILES_DUMP_SQL).all();
    MAC.forEach(([dev, ino], i) => {
      expect(upsertSourceFile(copy, { ...input(BigInt(dev), BigInt(ino), `/src/${ino}.jsonl`), size: 5, mtimeMs: 6, now: 7 })).toBe(ids[i]);
    });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM source_files').get() as { n: number }).n).toBe(MAC.length);
    expect(copy.prepare(SOURCE_FILES_DUMP_SQL).all()).toEqual(before);
    // the stored numbers are untouched
    expect(JSON.stringify(copy.prepare('SELECT dev, ino FROM source_files ORDER BY id').all())).toBe(JSON.stringify(MAC.map(([dev, ino]) => ({ dev, ino }))));
  });
});
