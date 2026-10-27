import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldBatch } from '../../src/ingest/dedupe.ts';
import type { Fact } from '../../src/ingest/facts.ts';
import { writeFolded } from '../../src/ingest/ingest.ts';
import { classifyFixture, fixtureNames } from './helpers.ts';
import { dump, freshDb, rng, shuffled, usage, useTempDataDir, type TempEnv } from './storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

const TABLES = [
  'usage_events',
  'tool_calls',
  'messages',
  'api_errors',
  'compactions',
  'sessions',
  'projects',
  'session_titles',
  'cost_snapshots',
  'unknown_types',
  'missing_fields',
];

function allFacts(): Fact[] {
  return fixtureNames.flatMap((n) => classifyFixture(n));
}

describe('foldBatch', () => {
  it('merges usage facts by key and sums counters by name and version', () => {
    const a = usage({ key: 'k', output: 5, rank: 5, stopReason: null, toolUses: [{ id: 't1', name: 'Read' }], missingFields: ['speed'], version: '1' });
    const b = usage({ key: 'k', output: 9, rank: 1_000_000_000_009, toolUses: [{ id: 't2', name: 'Bash' }], missingFields: ['speed'], version: '1' });
    const c = usage({ key: 'other' });
    const unknown1: Fact = { kind: 'unknown_type', type: 'future', version: '2' };
    const unknown2: Fact = { kind: 'unknown_type', type: 'future', version: '2' };
    const unknown3: Fact = { kind: 'unknown_type', type: 'future', version: null };
    const out = foldBatch([a, unknown1, b, c, unknown2, unknown3, { kind: 'ignored', reason: 'x' }, { kind: 'malformed', error: 'x' }]);
    expect(out.usage.map((u) => u.key)).toEqual(['k', 'other']);
    expect(out.usage[0]).toMatchObject({ output: 9, toolUses: [{ id: 't1' }, { id: 't2' }] });
    expect(out.unknownTypes).toEqual([
      { type: 'future', version: '2', count: 2 },
      { type: 'future', version: null, count: 1 },
    ]);
    expect(out.missingFields).toEqual([{ field: 'speed', version: '1', count: 2 }]);
  });

  it('subagent file facts give no session metadata', () => {
    expect(foldBatch([usage()], true).sessionMetas).toEqual([]);
    expect(foldBatch([usage()], false).sessionMetas).toHaveLength(1);
  });

  it('writing the folded batch gives the same database as writing every fact one by one', () => {
    const facts = allFacts().filter((f) => f.kind !== 'malformed');
    expect(facts.length).toBeGreaterThan(20);
    for (const seed of [1, 2, 3]) {
      const order = shuffled(facts, rng(seed));
      const one = freshDb(env.dir);
      for (const f of order) writeFolded(one.db, one.mainFile, '-work-demo', foldBatch([f]), 7);
      const folded = freshDb(env.dir);
      writeFolded(folded.db, folded.mainFile, '-work-demo', foldBatch(order), 7);
      for (const t of TABLES) expect(dump(folded.db, `SELECT * FROM ${t}`), `${t} seed ${seed}`).toBe(dump(one.db, `SELECT * FROM ${t}`));
      const rows = (folded.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n;
      expect(rows).toBeGreaterThan(0);
    }
  });
});
