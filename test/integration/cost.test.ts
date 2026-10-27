// Plan section 15: stored costs, their upkeep (merge, migration, version change), the API fields and the cross check.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Daily, DayDetail, Health, Heatmap, Hours, Models, Projects, Sessions, Summary } from '../../src/api/types.ts';
import { COST_AGREE_WITHIN_USD, costAgreement } from '../../src/ingest/crosscheck.ts';
import { PRICE_TABLE_DATE, PRICE_TABLE_VERSION, priceEventNanos } from '../../src/metrics/prices.ts';
import { afterPass, ensureRollups, rebuildAll, refreshDays, resolvePromptModels, rollupMatchesFacts } from '../../src/metrics/rollups.ts';
import { dayBounds } from '../../src/metrics/time.ts';
import { META_PRICE_VERSION, ensureCosts, recomputeAllCosts } from '../../src/store/costs.ts';
import type { Db } from '../../src/store/db.ts';
import { upsertCostSnapshot, upsertUsage } from '../../src/store/repo.ts';
import { HOUR, MIN, seeder, type Seeder } from '../unit/metricsHelpers.ts';
import { dump, freshDb, openAndMigrate, openDb, rng, shuffled, usage, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

const DHAKA = 'Asia/Dhaka';
const local = (day: string, hh: number, mm = 0): number => dayBounds(day, DHAKA)[0] + hh * HOUR + mm * MIN;

const costOf = (db: Db, key: string): number | null => (db.prepare('SELECT cost_nanos AS c FROM usage_events WHERE event_key = ?').get(key) as { c: number | null }).c;
const costDump = (db: Db): string => dump(db, 'SELECT event_key, cost_nanos FROM usage_events ORDER BY event_key');

// The default test response: input 10, output 100, cache read 1000, cache write 50 (20 + 30).
const SONNET = 1_290_000; // 10*2000 + 100*10000 + 20*2500 + 30*4000 + 1000*100 (Sonnet 5.5 reads at 0.10)
const OPUS = 2_580_000; // 10*4000 + 100*20000 + 20*5000 + 30*8000 + 1000*200
const HAIKU45 = 695_000; // 10*1000 + 100*5000 + 20*1250 + 30*2000 + 1000*100

describe('stored costs follow the merge of duplicate lines', () => {
  it('prices a new event and keeps the cost of the winning line when a later duplicate wins or loses', () => {
    const { db, mainFile } = freshDb(env.dir);
    // streaming: a partial line, then the final one with more output
    upsertUsage(db, usage({ key: 'm|r', output: 5, stopReason: null, rank: 5 }), mainFile);
    expect(costOf(db, 'm|r')).toBe(10 * 2000 + 5 * 10_000 + 20 * 2500 + 30 * 4000 + 1000 * 100);
    upsertUsage(db, usage({ key: 'm|r', output: 100, rank: 1_000_000_000_100 }), mainFile);
    expect(costOf(db, 'm|r')).toBe(SONNET);
    // a lower ranked duplicate arriving late changes nothing
    upsertUsage(db, usage({ key: 'm|r', output: 7, stopReason: null, rank: 7 }), mainFile);
    expect(costOf(db, 'm|r')).toBe(SONNET);
    db.close();
  });

  it('reprices when the winning line changes the model or the speed', () => {
    const { db, mainFile } = freshDb(env.dir);
    upsertUsage(db, usage({ key: 'a|1', model: 'claude-opus-5-5', speed: 'standard', rank: 1 }), mainFile);
    expect(costOf(db, 'a|1')).toBe(OPUS);
    upsertUsage(db, usage({ key: 'a|1', model: 'claude-opus-5-5', speed: 'fast', rank: 2 }), mainFile);
    expect(costOf(db, 'a|1')).toBe(2 * OPUS);
    upsertUsage(db, usage({ key: 'a|1', model: 'claude-future-9', rank: 3 }), mainFile);
    expect(costOf(db, 'a|1')).toBeNull();
    db.close();
  });

  it('a subagent file line later seen in a main file keeps one event with one cost', () => {
    const { db, mainFile, subFile } = freshDb(env.dir);
    upsertUsage(db, usage({ key: 'x|1', isSubagentFile: true, isSidechain: true, rank: 9 }), subFile);
    upsertUsage(db, usage({ key: 'x|1', rank: 9 }), mainFile);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 1 });
    expect(costOf(db, 'x|1')).toBe(SONNET);
    db.close();
  });

  it('thinking tokens are not priced on top of output', () => {
    const { db, mainFile } = freshDb(env.dir);
    upsertUsage(db, usage({ key: 't|1', thinking: 0 }), mainFile);
    upsertUsage(db, usage({ key: 't|2', thinking: 90 }), mainFile);
    expect(costOf(db, 't|2')).toBe(costOf(db, 't|1'));
    db.close();
  });
});

describe('US only inference (geo us) is stored and priced at 1.1 times', () => {
  const geoOf = (db: Db, key: string): string | null => (db.prepare('SELECT inference_geo AS g FROM usage_events WHERE event_key = ?').get(key) as { g: string | null }).g;
  // (1,290,000 * 11 + 5) / 10 integer division
  const SONNET_US = 1_419_000;
  const OPUS_US = 2_838_000; // (2,580,000 * 11 + 5) / 10

  it('a us line is stored with its geo and costs the rounded 1.1 times', () => {
    const { db, mainFile } = freshDb(env.dir);
    upsertUsage(db, usage({ key: 'g|1', inferenceGeo: 'us' }), mainFile);
    upsertUsage(db, usage({ key: 'g|2', inferenceGeo: 'global' }), mainFile);
    upsertUsage(db, usage({ key: 'g|3', inferenceGeo: null }), mainFile);
    upsertUsage(db, usage({ key: 'g|4', inferenceGeo: 'us', model: 'claude-opus-5-5' }), mainFile);
    expect([geoOf(db, 'g|1'), geoOf(db, 'g|2'), geoOf(db, 'g|3')]).toEqual(['us', 'global', null]);
    expect(costOf(db, 'g|1')).toBe(SONNET_US);
    expect(costOf(db, 'g|2')).toBe(SONNET);
    expect(costOf(db, 'g|3')).toBe(SONNET);
    expect(costOf(db, 'g|4')).toBe(OPUS_US);
    db.close();
  });

  it('the winning line decides the geo, whichever order the lines arrive in', () => {
    const { db, mainFile } = freshDb(env.dir);
    // a streaming partial says global, the final line (higher rank) says us
    upsertUsage(db, usage({ key: 'w|1', inferenceGeo: 'global', rank: 10, stopReason: null }), mainFile);
    expect(costOf(db, 'w|1')).toBe(SONNET);
    upsertUsage(db, usage({ key: 'w|1', inferenceGeo: 'us', rank: 20 }), mainFile);
    expect(geoOf(db, 'w|1')).toBe('us');
    expect(costOf(db, 'w|1')).toBe(SONNET_US);
    // the final line first, then a lower ranked partial that says global: the winner stays
    upsertUsage(db, usage({ key: 'w|2', inferenceGeo: 'us', rank: 20 }), mainFile);
    upsertUsage(db, usage({ key: 'w|2', inferenceGeo: 'global', rank: 10, stopReason: null }), mainFile);
    expect(geoOf(db, 'w|2')).toBe('us');
    expect(costOf(db, 'w|2')).toBe(SONNET_US);
    // and the other way round: a winner that says global beats an earlier us partial
    upsertUsage(db, usage({ key: 'w|3', inferenceGeo: 'us', rank: 10, stopReason: null }), mainFile);
    upsertUsage(db, usage({ key: 'w|3', inferenceGeo: 'global', rank: 20 }), mainFile);
    expect(geoOf(db, 'w|3')).toBe('global');
    expect(costOf(db, 'w|3')).toBe(SONNET);
    db.close();
  });

  it('a row stored before migration 4 (NULL geo) prices as global, and the same line read again at equal rank fills it', () => {
    const { db, mainFile } = freshDb(env.dir);
    upsertUsage(db, usage({ key: 'o|1', inferenceGeo: null, rank: 20 }), mainFile);
    expect(costOf(db, 'o|1')).toBe(SONNET);
    upsertUsage(db, usage({ key: 'o|1', inferenceGeo: 'us', rank: 20 }), mainFile); // a full ingest reads the line again
    expect(geoOf(db, 'o|1')).toBe('us');
    expect(costOf(db, 'o|1')).toBe(SONNET_US);
    // a stored value is never replaced at equal rank, and a lower ranked line changes nothing
    upsertUsage(db, usage({ key: 'o|1', inferenceGeo: 'global', rank: 20 }), mainFile);
    upsertUsage(db, usage({ key: 'o|1', inferenceGeo: null, rank: 20 }), mainFile);
    upsertUsage(db, usage({ key: 'o|1', inferenceGeo: 'global', rank: 5 }), mainFile);
    expect(geoOf(db, 'o|1')).toBe('us');
    expect(costOf(db, 'o|1')).toBe(SONNET_US);
    db.close();
  });

  it('a recompute prices every row with its stored geo', () => {
    const { db, mainFile } = freshDb(env.dir);
    upsertUsage(db, usage({ key: 'r|1', inferenceGeo: 'us' }), mainFile);
    upsertUsage(db, usage({ key: 'r|2', inferenceGeo: 'global' }), mainFile);
    db.exec('UPDATE usage_events SET cost_nanos = NULL');
    recomputeAllCosts(db);
    expect(costOf(db, 'r|1')).toBe(SONNET_US);
    expect(costOf(db, 'r|2')).toBe(SONNET);
    db.close();
  });

  it('the bump to version 3 reprices a database that holds us rows priced as global', () => {
    expect(PRICE_TABLE_VERSION).toBeGreaterThanOrEqual(3);
    const file = join(env.dir, 'geo.db');
    const first = openAndMigrate(file);
    first.db.prepare("INSERT INTO source_files (id, dev, ino, path, project_dir, session_id, is_subagent, size, mtime_ms, first_seen_at) VALUES (1, 1, 1, '/x', 'p', 's1', 0, 1, 1, 1)").run();
    upsertUsage(first.db, usage({ key: 'v|1', inferenceGeo: 'us' }), 1);
    first.db.close();
    const raw = openDb(file);
    raw.prepare('UPDATE usage_events SET cost_nanos = ? WHERE event_key = ?').run(SONNET, 'v|1'); // as version 2 priced it
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('2', META_PRICE_VERSION);
    raw.close();
    const again = openAndMigrate(file);
    expect(costOf(again.db, 'v|1')).toBe(SONNET_US);
    again.db.close();
  });

  it('the rollup and the summary carry the 1.1 times cost', () => {
    const { db, mainFile } = freshDb(env.dir);
    upsertUsage(db, usage({ key: 'a|1', inferenceGeo: 'us', ts: local('2026-10-20', 9) }), mainFile);
    upsertUsage(db, usage({ key: 'a|2', inferenceGeo: 'global', ts: local('2026-10-20', 10) }), mainFile);
    rebuildAll(db, DHAKA);
    expect(db.prepare('SELECT SUM(cost_nanos) AS c FROM activity_rollup').get()).toEqual({ c: SONNET_US + SONNET });
    expect(rollupMatchesFacts(db)).toBe(true);
    db.close();
  });
});

describe('incremental pricing equals a full recompute (property)', () => {
  const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-future-9'];

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}: shuffled duplicates with random models, speeds and token sizes`, () => {
      const rand = rng(seed);
      const pick = <T>(l: readonly T[]): T => l[Math.floor(rand() * l.length)] as T;
      const { db, mainFile, subFile } = freshDb(env.dir);
      const lines = [];
      for (let k = 0; k < 120; k++) {
        const copies = 1 + Math.floor(rand() * 3);
        const base = {
          key: `k${k}|r`,
          sessionId: pick(['s1', 's2', 's3']),
          ts: local('2026-10-20', 8) + k * MIN,
          model: pick(MODELS),
          speed: pick(['standard', 'fast', null]),
        };
        for (let c = 0; c < copies; c++) {
          const big = rand() < 0.25;
          const cw = Math.floor(rand() * (big ? 120_000 : 2000));
          const split = rand() < 0.3 ? 0 : Math.floor(rand() * (cw + 1));
          lines.push(
            usage({
              ...base,
              isSubagentFile: rand() < 0.2,
              input: Math.floor(rand() * (big ? 90_000 : 3000)),
              output: Math.floor(rand() * 4000),
              cacheRead: Math.floor(rand() * (big ? 90_000 : 5000)),
              cacheWrite: cw,
              cacheWrite5m: split === 0 ? 0 : split,
              cacheWrite1h: split === 0 ? 0 : cw - split,
              rank: Math.floor(rand() * 1000),
            }),
          );
        }
      }
      // several passes of shuffled lines, so rows are merged more than once and in any order
      const order = shuffled(lines, rand);
      for (let i = 0; i < order.length; i += 40) {
        for (const f of order.slice(i, i + 40)) upsertUsage(db, f, f.isSubagentFile ? subFile : mainFile);
        const stored = costDump(db);
        const copy = join(env.dir, `copy-${seed}-${i}.db`);
        db.exec(`VACUUM INTO '${copy}'`);
        const c = openDb(copy);
        c.exec('UPDATE usage_events SET cost_nanos = NULL');
        recomputeAllCosts(c);
        expect(costDump(c), `seed ${seed} after ${i + 40} lines`).toBe(stored);
        c.close();
      }
      // every stored cost is exactly the price of the row's own columns
      const rows = db.prepare('SELECT * FROM usage_events').all() as unknown as Array<Record<string, number | string | null>>;
      expect(rows.length).toBeGreaterThan(50);
      for (const r of rows) {
        const expected = priceEventNanos({
          model: r['model'] as string,
          input: r['input_tokens'] as number,
          output: r['output_tokens'] as number,
          cacheRead: r['cache_read_tokens'] as number,
          cacheWrite: r['cache_write_tokens'] as number,
          cacheWrite5m: r['cache_write_5m'] as number,
          cacheWrite1h: r['cache_write_1h'] as number,
          speed: r['speed'] as string | null,
        });
        expect(r['cost_nanos'], r['event_key'] as string).toBe(expected);
      }
      expect(rows.some((r) => r['cost_nanos'] === null)).toBe(true);
      expect(rows.some((r) => r['speed'] === 'fast' && r['model'] === 'claude-opus-5-5')).toBe(true);
      db.close();
    });
  }
});

describe('migration 3 on an existing database', () => {
  function olderDir(): string {
    const dir = join(env.dir, 'only12');
    mkdirSync(dir);
    for (const f of ['0001_init.sql', '0002_rollups.sql']) copyFileSync(join(import.meta.dirname, '../../src/store/migrations', f), join(dir, f));
    return dir;
  }

  it('adds the columns, backs up first and fills every cost at the first start', () => {
    const file = join(env.dir, 'old.db');
    const { db: old } = openAndMigrate(file, { migrationsDir: olderDir() });
    expect(old.prepare('PRAGMA table_info(usage_events)').all().map((c) => (c as { name: string }).name)).not.toContain('cost_nanos');
    old.prepare("INSERT INTO source_files (id, dev, ino, path, project_dir, session_id, is_subagent, size, mtime_ms, first_seen_at) VALUES (1, 1, 1, '/x', 'p', 's1', 0, 1, 1, 1)").run();
    const ins = old.prepare(
      `INSERT INTO usage_events (event_key, session_id, is_sidechain, is_subagent_file, source_file_id, ts, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cache_write_5m, cache_write_1h, speed, rank) VALUES (?, 's1', 0, 0, 1, ?, ?, 10, 100, 1000, 50, 20, 30, ?, 1)`,
    );
    ins.run('e1', local('2026-10-20', 9), 'claude-sonnet-5-5', 'standard');
    ins.run('e2', local('2026-10-20', 10), 'claude-opus-5-5', 'standard');
    ins.run('e3', local('2026-10-20', 11), 'claude-mystery', 'standard');
    old.close();

    const { db, result } = openAndMigrate(file);
    expect(result.applied).toEqual([3, 4]);
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(costOf(db, 'e1')).toBe(SONNET);
    expect(costOf(db, 'e2')).toBe(OPUS);
    expect(costOf(db, 'e3')).toBeNull();
    expect(db.prepare('SELECT value FROM meta WHERE key = ?').get(META_PRICE_VERSION)).toEqual({ value: String(PRICE_TABLE_VERSION) });
    const rollupCols = db.prepare('PRAGMA table_info(activity_rollup)').all().map((c) => (c as { name: string }).name);
    expect(rollupCols).toEqual(expect.arrayContaining(['cost_nanos', 'unpriced']));

    // the old rollup has no cost: the facts and the rollup disagree until the start repair rebuilds it
    rebuildAll(db, DHAKA);
    expect(rollupMatchesFacts(db)).toBe(true);
    expect(db.prepare('SELECT SUM(cost_nanos) AS c, SUM(unpriced) AS u FROM activity_rollup').get()).toEqual({ c: SONNET + OPUS, u: 1 });
    db.close();
  });

  it('a rollup built before the costs were filled is rebuilt by the start repair, not trusted', () => {
    const file = join(env.dir, 'old2.db');
    const { db: old } = openAndMigrate(file, { migrationsDir: olderDir() });
    old.prepare("INSERT INTO source_files (id, dev, ino, path, project_dir, session_id, is_subagent, size, mtime_ms, first_seen_at) VALUES (1, 1, 1, '/x', 'p', 's1', 0, 1, 1, 1)").run();
    old.prepare(
      `INSERT INTO usage_events (event_key, session_id, is_sidechain, is_subagent_file, source_file_id, ts, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cache_write_5m, cache_write_1h, rank) VALUES ('e1', 's1', 0, 0, 1, ?, 'claude-sonnet-5-5', 10, 100, 1000, 50, 20, 30, 1)`,
    ).run(local('2026-10-20', 9));
    // the rollup as version 2 built it: no cost columns yet
    old.exec(
      `INSERT INTO activity_rollup (day, hour, project_key, model, is_subagent_file, prompts, responses, tool_calls, input, output, cache_read, cache_write)
       VALUES ('2026-10-20', 9, '', 'claude-sonnet-5-5', 0, 0, 1, 0, 10, 100, 1000, 50)`,
    );
    old.exec("INSERT INTO meta (key, value) VALUES ('rollup_tz', 'Asia/Dhaka')");
    old.close();
    const { db } = openAndMigrate(file);
    expect(rollupMatchesFacts(db)).toBe(false); // columns exist with 0, costs now filled
    expect(ensureRollups(db, DHAKA)).toBe(true);
    expect(rollupMatchesFacts(db)).toBe(true);
    db.close();
  });

  it('a second start does nothing', () => {
    const file = join(env.dir, 'twice.db');
    const first = openAndMigrate(file);
    expect(ensureCosts(first.db)).toBeNull();
    first.db.close();
    const second = openAndMigrate(file);
    expect(second.result.applied).toEqual([]);
    expect(readdirSync(env.dir).filter((f) => f.includes('.bak-'))).toEqual([]);
    second.db.close();
  });
});

describe('a new price table version recomputes every cost', () => {
  it('reprices all events when meta.price_table_version differs, and leaves them alone when it matches', () => {
    const file = join(env.dir, 'ver.db');
    const first = openAndMigrate(file);
    const { db } = first;
    db.prepare("INSERT INTO source_files (id, dev, ino, path, project_dir, session_id, is_subagent, size, mtime_ms, first_seen_at) VALUES (1, 1, 1, '/x', 'p', 's1', 0, 1, 1, 1)").run();
    upsertUsage(db, usage({ key: 'v|1' }), 1);
    upsertUsage(db, usage({ key: 'v|2', model: 'claude-opus-5-5' }), 1);
    expect(costOf(db, 'v|1')).toBe(SONNET);
    // make the stored costs wrong on purpose
    db.exec('UPDATE usage_events SET cost_nanos = 7');
    expect(ensureCosts(db)).toBeNull(); // version matches: trusted as they are
    expect(costOf(db, 'v|1')).toBe(7);
    db.close();

    // the code's table is newer than the one that priced these rows
    const raw = openDb(file);
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(PRICE_TABLE_VERSION - 1), META_PRICE_VERSION);
    raw.close();
    const again = openAndMigrate(file);
    expect(costOf(again.db, 'v|1')).toBe(SONNET);
    expect(costOf(again.db, 'v|2')).toBe(OPUS);
    expect(again.db.prepare('SELECT value FROM meta WHERE key = ?').get(META_PRICE_VERSION)).toEqual({ value: String(PRICE_TABLE_VERSION) });
    again.db.close();
  });

  it('the bump to version 2 moves Sonnet 5.5 events from the old $0.20 cache read to $0.10 on the next start, geo untouched', () => {
    expect(PRICE_TABLE_VERSION).toBeGreaterThanOrEqual(2);
    const file = join(env.dir, 'bump.db');
    const first = openAndMigrate(file);
    first.db.prepare("INSERT INTO source_files (id, dev, ino, path, project_dir, session_id, is_subagent, size, mtime_ms, first_seen_at) VALUES (1, 1, 1, '/x', 'p', 's1', 0, 1, 1, 1)").run();
    upsertUsage(first.db, usage({ key: 'b|1' }), 1);
    upsertUsage(first.db, usage({ key: 'b|2', model: 'claude-opus-5-5' }), 1);
    first.db.close();
    // the database as version 1 left it: Sonnet 5.5 priced with reads at 200
    const raw = openDb(file);
    raw.prepare('UPDATE usage_events SET cost_nanos = ? WHERE event_key = ?').run(SONNET + 1000 * 100, 'b|1');
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', META_PRICE_VERSION);
    raw.close();
    const again = openAndMigrate(file);
    expect(costOf(again.db, 'b|1')).toBe(SONNET);
    expect(costOf(again.db, 'b|2')).toBe(OPUS);
    expect(again.db.prepare('SELECT value FROM meta WHERE key = ?').get(META_PRICE_VERSION)).toEqual({ value: String(PRICE_TABLE_VERSION) });
    again.db.close();
  });

  it('a missing version (never priced) recomputes too', () => {
    const file = join(env.dir, 'novers.db');
    const { db } = openAndMigrate(file);
    db.prepare("INSERT INTO source_files (id, dev, ino, path, project_dir, session_id, is_subagent, size, mtime_ms, first_seen_at) VALUES (1, 1, 1, '/x', 'p', 's1', 0, 1, 1, 1)").run();
    upsertUsage(db, usage({ key: 'n|1' }), 1);
    db.exec('UPDATE usage_events SET cost_nanos = NULL');
    db.exec(`DELETE FROM meta WHERE key = '${META_PRICE_VERSION}'`);
    expect(ensureCosts(db)).toBe(1);
    expect(costOf(db, 'n|1')).toBe(SONNET);
    db.close();
  });
});

// ---------------------------------------------------------------- the API

// Two projects, five models, one subagent event:
//   2026-10-20  A (/work/a): p 09:00, R opus 09:01, R sonnet 09:02, R mystery 09:03 (no price), subagent sonnet 09:04
//   2026-10-21  B (/work/b): p 10:00, R sonnet 10:01, R haiku-4-5 10:02
function archive(): Seeder {
  const s = seeder(env.dir, DHAKA);
  s.prompt('A', local('2026-10-20', 9), { cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 1), { model: 'claude-opus-5-5', cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 2), { cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 3), { model: 'claude-mystery-1', cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 4), { sub: true });
  s.prompt('B', local('2026-10-21', 10), { cwd: '/work/b' });
  s.response('B', local('2026-10-21', 10, 1), { cwd: '/work/b' });
  s.response('B', local('2026-10-21', 10, 2), { model: 'claude-haiku-4-5', cwd: '/work/b' });
  resolvePromptModels(s.db);
  rebuildAll(s.db, DHAKA);
  return s;
}

const body = <T>(s: Seeder, path: string): T => {
  const r = s.get(path);
  if (r.status !== 200) throw new Error(`${path} gave ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
};

const TOTAL_NANOS = OPUS + SONNET + SONNET + SONNET + HAIKU45; // the mystery model adds nothing
const usd = (nanos: number): number => nanos / 1e9;

describe('rollups carry the cost', () => {
  it('rollup sums equal the fact sums, and the unpriced events are counted', () => {
    const s = archive();
    expect(s.db.prepare('SELECT SUM(cost_nanos) AS c, SUM(unpriced) AS u FROM activity_rollup').get()).toEqual({ c: TOTAL_NANOS, u: 1 });
    expect(s.db.prepare('SELECT SUM(cost_nanos) AS c, COUNT(*) - COUNT(cost_nanos) AS u FROM usage_events').get()).toEqual({ c: TOTAL_NANOS, u: 1 });
    expect(rollupMatchesFacts(s.db)).toBe(true);
  });

  it('a stale rollup with a different cost is noticed', () => {
    const s = archive();
    s.db.exec('UPDATE activity_rollup SET cost_nanos = cost_nanos + 1 WHERE rowid = (SELECT MIN(rowid) FROM activity_rollup)');
    expect(rollupMatchesFacts(s.db)).toBe(false);
  });

  it('refreshing days gives the same cost rows as a full rebuild', () => {
    const s = archive();
    const before = dump(s.db, 'SELECT * FROM activity_rollup ORDER BY day, hour, project_key, model, is_subagent_file');
    refreshDays(s.db, DHAKA, ['2026-10-20', '2026-10-21']);
    expect(dump(s.db, 'SELECT * FROM activity_rollup ORDER BY day, hour, project_key, model, is_subagent_file')).toBe(before);
    // a new response in a pass is priced and lands in its day
    s.response('B', local('2026-10-21', 11), { model: 'claude-opus-5-5', cwd: '/work/b' });
    afterPass(s.db, DHAKA, { changedRange: { minTs: local('2026-10-21', 11), maxTs: local('2026-10-21', 11) }, sessionsReprojected: 0 } as never);
    expect(s.db.prepare('SELECT SUM(cost_nanos) AS c FROM activity_rollup').get()).toEqual({ c: TOTAL_NANOS + OPUS });
  });
});

describe('summary cost', () => {
  it('is the priced total in dollars, with the table date and the unpriced responses', () => {
    const s = archive();
    const sum = body<Summary>(s, '/api/summary');
    expect(sum.cost).toEqual({ usd: usd(TOTAL_NANOS), backgroundUsd: null, unpricedResponses: 1, priceTableDate: PRICE_TABLE_DATE });
    expect(sum.cost.usd).toBe(0.007145);
  });

  it('honours the range and every filter', () => {
    const s = archive();
    expect(body<Summary>(s, '/api/summary?from=2026-10-21&to=2026-10-21').cost).toMatchObject({ usd: usd(SONNET + HAIKU45), unpricedResponses: 0 });
    expect(body<Summary>(s, '/api/summary?includeSubagents=0').cost).toMatchObject({ usd: usd(TOTAL_NANOS - SONNET), unpricedResponses: 1 });
    expect(body<Summary>(s, '/api/summary?models=claude-opus-5-5').cost).toMatchObject({ usd: usd(OPUS), unpricedResponses: 0 });
    expect(body<Summary>(s, '/api/summary?models=claude-mystery-1').cost).toMatchObject({ usd: 0, unpricedResponses: 1 });
    expect(body<Summary>(s, '/api/summary?projects=/work/b').cost).toMatchObject({ usd: usd(SONNET + HAIKU45) });
  });

  it('filters are additive: the parts add up to the whole', () => {
    const s = archive();
    const whole = body<Summary>(s, '/api/summary').cost.usd;
    const byProject = ['/work/a', '/work/b'].map((p) => body<Summary>(s, `/api/summary?projects=${encodeURIComponent(p)}`).cost.usd);
    expect(byProject.reduce((a, b) => a + b, 0)).toBeCloseTo(whole, 12);
    const byModel = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-mystery-1'].map((m) => body<Summary>(s, `/api/summary?models=${m}`).cost.usd);
    expect(byModel.reduce((a, b) => a + b, 0)).toBeCloseTo(whole, 12);
    const byDay = ['2026-10-20', '2026-10-21'].map((d) => body<Summary>(s, `/api/summary?from=${d}&to=${d}`).cost.usd);
    expect(byDay.reduce((a, b) => a + b, 0)).toBeCloseTo(whole, 12);
  });

  it('adds the background cost from the last snapshot when asked', () => {
    const s = archive();
    upsertCostSnapshot(
      s.db,
      {
        kind: 'cost_snapshot',
        sessionId: 'A',
        startTime: null,
        totalDuration: 5,
        totalCostUSD: null,
        modelUsage: {
          'claude-haiku-5-5': { inputTokens: 400, outputTokens: 100, thinkingTokens: 0, cacheReadInputTokens: 1000, cacheCreationInputTokens: 500, webSearchRequests: 0, costUSD: 0.0123 },
          'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, webSearchRequests: 0, costUSD: 99 },
        },
      },
      null,
    );
    expect(body<Summary>(s, '/api/summary').cost.backgroundUsd).toBeNull();
    const withBg = body<Summary>(s, '/api/summary?includeBackground=1').cost;
    expect(withBg.backgroundUsd).toBe(0.0123);
    expect(withBg.usd).toBeCloseTo(usd(TOTAL_NANOS) + 0.0123, 12);
    // the model that is also in the transcript is not background
    const m = body<Models>(s, '/api/models?includeBackground=1');
    expect(m.background).toEqual([expect.objectContaining({ model: 'claude-haiku-5-5', costUsd: 0.0123 })]);
    // the day and model filters apply to it like to its tokens
    expect(body<Summary>(s, '/api/summary?includeBackground=1&from=2026-10-21').cost.backgroundUsd).toBe(0);
    expect(body<Summary>(s, '/api/summary?includeBackground=1&models=claude-opus-5-5').cost.backgroundUsd).toBe(0);
  });
});

describe('models, projects, sessions and the day strip carry the cost', () => {
  it('lists cost and cost share per model, null for a model without a price', () => {
    const s = archive();
    const m = body<Models>(s, '/api/models');
    const row = (model: string) => m.rows.find((r) => r.model === model) as Models['rows'][number];
    expect(row('claude-sonnet-5-5').costUsd).toBe(usd(3 * SONNET));
    expect(row('claude-opus-5-5').costUsd).toBe(usd(OPUS));
    expect(row('claude-haiku-4-5').costUsd).toBe(usd(HAIKU45));
    expect(row('claude-mystery-1').costUsd).toBeNull();
    expect(row('claude-mystery-1').costShare).toBe(0);
    expect(row('claude-sonnet-5-5').costShare).toBeCloseTo((3 * SONNET) / TOTAL_NANOS, 12);
    expect(m.rows.reduce((a, r) => a + r.costShare, 0)).toBeCloseTo(1, 12);
    expect(m.rows.reduce((a, r) => a + (r.costUsd ?? 0), 0)).toBeCloseTo(body<Summary>(s, '/api/summary').cost.usd, 12);
  });

  it('projects add up to the total and sessions carry their own cost', () => {
    const s = archive();
    const p = body<Projects>(s, '/api/projects');
    expect(p.rows.find((r) => r.projectKey === '/work/a')?.costUsd).toBe(usd(OPUS + 2 * SONNET));
    expect(p.rows.find((r) => r.projectKey === '/work/b')?.costUsd).toBe(usd(SONNET + HAIKU45));
    expect(p.rows.reduce((a, r) => a + r.costUsd, 0)).toBeCloseTo(body<Summary>(s, '/api/summary').cost.usd, 12);
    const sess = body<Sessions>(s, '/api/sessions');
    expect(sess.rows.find((r) => r.sessionId === 'A')?.costUsd).toBe(usd(OPUS + 2 * SONNET));
    expect(sess.rows.find((r) => r.sessionId === 'B')?.costUsd).toBe(usd(SONNET + HAIKU45));
    expect(body<Sessions>(s, '/api/sessions?includeSubagents=0').rows.find((r) => r.sessionId === 'A')?.costUsd).toBe(usd(OPUS + SONNET));
    expect(body<Sessions>(s, '/api/sessions?models=claude-opus-5-5').rows.map((r) => [r.sessionId, r.costUsd])).toEqual([['A', usd(OPUS)]]);
  });

  it('puts the cost of each session in the day strip', () => {
    const s = archive();
    const d = body<DayDetail>(s, '/api/day?date=2026-10-20');
    expect(d.sessions.map((x) => [x.sessionId, x.costUsd])).toEqual([['A', usd(OPUS + 2 * SONNET)]]);
    expect(body<DayDetail>(s, '/api/day?date=2026-10-21').sessions[0]?.costUsd).toBe(usd(SONNET + HAIKU45));
    expect(body<DayDetail>(s, '/api/day?date=2026-10-20&models=claude-sonnet-5-5').sessions[0]?.costUsd).toBe(usd(2 * SONNET));
  });
});

describe('the cost metric of the time charts', () => {
  it('the daily chart is stacked by model and adds up to the summary', () => {
    const s = archive();
    const d = body<Daily>(s, '/api/daily?metric=cost');
    expect(d.metric).toBe('cost');
    expect(d.models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5']); // by total descending, the unpriced model has no dollars
    const day = (x: string) => d.days.find((r) => r.day === x) as Daily['days'][number];
    expect(day('2026-10-20').byModel).toEqual({ 'claude-sonnet-5-5': usd(2 * SONNET), 'claude-opus-5-5': usd(OPUS), 'claude-haiku-4-5': 0 });
    expect(day('2026-10-20').total).toBe(usd(OPUS + 2 * SONNET));
    expect(day('2026-10-21').byModel['claude-haiku-4-5']).toBe(usd(HAIKU45));
    expect(d.days.reduce((a, r) => a + r.total, 0)).toBeCloseTo(body<Summary>(s, '/api/summary').cost.usd, 12);
    for (const r of d.days) expect(Object.values(r.byModel).reduce((a, b) => a + b, 0)).toBeCloseTo(r.total, 12);
    // the cache read switch belongs to tokens only
    expect(body<Daily>(s, '/api/daily?metric=cost&hideCacheRead=1').days).toEqual(d.days);
  });

  it('the hour chart and the heatmap show the same dollars', () => {
    const s = archive();
    const h = body<Hours>(s, '/api/hours?metric=cost');
    expect(h.hours).toHaveLength(24);
    expect(h.hours[9]?.value).toBe(usd(OPUS + 2 * SONNET));
    expect(h.hours[10]?.value).toBe(usd(SONNET + HAIKU45));
    expect(h.hours.reduce((a, x) => a + x.value, 0)).toBeCloseTo(body<Summary>(s, '/api/summary').cost.usd, 12);
    const hm = body<Heatmap>(s, '/api/heatmap?metric=cost');
    expect(hm.metric).toBe('cost');
    const cell = (day: string) => hm.cells.find((c) => c.day === day)?.value;
    expect(cell('2026-10-20')).toBe(usd(OPUS + 2 * SONNET));
    expect(cell('2026-10-21')).toBe(usd(SONNET + HAIKU45));
    expect(cell('2026-10-19')).toBe(0);
    expect(hm.thresholds).toHaveLength(4);
    expect(hm.thresholds[3]).toBe(usd(OPUS + 2 * SONNET));
  });

  it('filters apply to the cost charts like to the other metrics', () => {
    const s = archive();
    expect(body<Daily>(s, '/api/daily?metric=cost&projects=/work/b').days.reduce((a, r) => a + r.total, 0)).toBeCloseTo(usd(SONNET + HAIKU45), 12);
    expect(body<Hours>(s, '/api/hours?metric=cost&includeSubagents=0').hours[9]?.value).toBe(usd(OPUS + SONNET));
    expect(body<Heatmap>(s, '/api/heatmap?metric=cost&models=claude-opus-5-5').cells.find((c) => c.day === '2026-10-20')?.value).toBe(usd(OPUS));
  });

  it('an empty archive gives zeros', () => {
    const s = seeder(env.dir, DHAKA);
    rebuildAll(s.db, DHAKA);
    expect(body<Summary>(s, '/api/summary').cost).toEqual({ usd: 0, backgroundUsd: null, unpricedResponses: 0, priceTableDate: PRICE_TABLE_DATE });
    expect(body<Hours>(s, '/api/hours?metric=cost').hours.every((x) => x.value === 0)).toBe(true);
  });
});

describe('health prices', () => {
  it('names the unpriced models with their counts and counts the cache write remainders', () => {
    const s = archive();
    const { db, mainFile } = { db: s.db, mainFile: 1 };
    upsertUsage(db, usage({ key: 'rem|1', cacheWrite: 300, cacheWrite5m: 100, cacheWrite1h: 100, sessionId: 'A', ts: local('2026-10-20', 12) }), mainFile);
    const h = body<Health>(s, '/api/health');
    expect(h.prices).toEqual({ tableDate: PRICE_TABLE_DATE, unpricedModels: [{ model: 'claude-mystery-1', responses: 1 }], cacheWriteRemainderEvents: 1 });
  });

  it('says nothing is unpriced on an archive of listed models', () => {
    const s = seeder(env.dir, DHAKA);
    s.response('A', local('2026-10-20', 9), { cwd: '/work/a' });
    expect(body<Health>(s, '/api/health').prices).toEqual({ tableDate: PRICE_TABLE_DATE, unpricedModels: [], cacheWriteRemainderEvents: 0 });
  });
});

describe('cost agreement with the cost-state snapshots', () => {
  const snap = (db: Db, sessionId: string, modelUsage: Record<string, { i: number; o: number; cr: number; cw: number; cost: number }>): void =>
    upsertCostSnapshot(
      db,
      {
        kind: 'cost_snapshot',
        sessionId,
        startTime: null,
        totalDuration: 5,
        totalCostUSD: null,
        modelUsage: Object.fromEntries(
          Object.entries(modelUsage).map(([m, u]) => [
            m,
            { inputTokens: u.i, outputTokens: u.o, thinkingTokens: 0, cacheReadInputTokens: u.cr, cacheCreationInputTokens: u.cw, webSearchRequests: 0, costUSD: u.cost },
          ]),
        ),
      },
      null,
    );

  it('compares sessions whose tokens equal the snapshot exactly and lists the worst differences', () => {
    const s = seeder(env.dir, DHAKA);
    // two sonnet responses (one in a subagent file) and one opus response in S1; the snapshot matches to the token
    s.response('S1', local('2026-10-20', 9), { model: 'claude-sonnet-5-5' });
    s.response('S1', local('2026-10-20', 9, 1), { model: 'claude-sonnet-5-5', sub: true });
    s.response('S1', local('2026-10-20', 9, 2), { model: 'claude-opus-5-5' });
    snap(s.db, 'S1', {
      'claude-sonnet-5-5': { i: 20, o: 200, cr: 2000, cw: 100, cost: usd(2 * SONNET) },
      'claude-opus-5-5': { i: 10, o: 100, cr: 1000, cw: 50, cost: usd(OPUS) + 0.05 }, // 5 cents too high
      'claude-haiku-5-5': { i: 5, o: 5, cr: 5, cw: 5, cost: 0.001 }, // background: ignored
    });
    // S2: tokens do not match, so it is not compared however far apart the dollars are
    s.response('S2', local('2026-10-20', 10), { model: 'claude-sonnet-5-5' });
    snap(s.db, 'S2', { 'claude-sonnet-5-5': { i: 11, o: 100, cr: 1000, cw: 50, cost: 5 } });
    // S3: matches exactly, one model, agrees
    s.response('S3', local('2026-10-20', 11), { model: 'claude-sonnet-5-5' });
    snap(s.db, 'S3', { 'claude-sonnet-5-5': { i: 10, o: 100, cr: 1000, cw: 50, cost: usd(SONNET) + 0.004 } });
    // S4: a model without a price is never compared
    s.response('S4', local('2026-10-20', 12), { model: 'claude-mystery-1' });
    snap(s.db, 'S4', { 'claude-mystery-1': { i: 10, o: 100, cr: 1000, cw: 50, cost: 1 } });

    const c = costAgreement(s.db);
    expect(c.snapshots).toBe(4);
    expect(c.sessions).toBe(2);
    expect(c.pairs).toBe(3);
    expect(c.within).toBe(2);
    expect(c.explained).toBe(0);
    expect(c.other).toBe(1);
    expect(c.worst.map((w) => [w.sessionId, w.model])).toEqual([['S1', 'claude-opus-5-5']]);
    expect(c.worst[0]?.diff).toBeCloseTo(-0.05, 9);
    expect(COST_AGREE_WITHIN_USD).toBe(0.01);
  });

  it('names a difference of exactly cache reads times $0.10 for Sonnet 5.5 as the corrected rate, and nothing else', () => {
    const s = seeder(env.dir, DHAKA);
    const cr = 2_000_000; // 2M cache read tokens: the old rate adds $0.20
    const priced = (cacheRead: number): number => 10 * 2000 + 100 * 10_000 + 20 * 2500 + 30 * 4000 + cacheRead * 100;
    // E1: Claude Code priced reads at $0.20 (older version): explained
    s.response('E1', local('2026-10-20', 9), { model: 'claude-sonnet-5-5', cacheRead: cr });
    snap(s.db, 'E1', { 'claude-sonnet-5-5': { i: 10, o: 100, cr, cw: 50, cost: usd(priced(cr)) + cr * 0.0000001 } });
    // E2: off by that amount plus 3 cents: not explained
    s.response('E2', local('2026-10-20', 10), { model: 'claude-sonnet-5-5', cacheRead: cr });
    snap(s.db, 'E2', { 'claude-sonnet-5-5': { i: 10, o: 100, cr, cw: 50, cost: usd(priced(cr)) + cr * 0.0000001 + 0.03 } });
    // E3: the same gap on Opus 5.5, whose rate was not corrected: not explained
    s.response('E3', local('2026-10-20', 11), { model: 'claude-opus-5-5', cacheRead: cr });
    snap(s.db, 'E3', { 'claude-opus-5-5': { i: 10, o: 100, cr, cw: 50, cost: usd(10 * 4000 + 100 * 20_000 + 20 * 5000 + 30 * 8000 + cr * 200) + cr * 0.0000001 } });
    // E4: Sonnet 5.5 with the new rate on both sides: within
    s.response('E4', local('2026-10-20', 12), { model: 'claude-sonnet-5-5', cacheRead: cr });
    snap(s.db, 'E4', { 'claude-sonnet-5-5': { i: 10, o: 100, cr, cw: 50, cost: usd(priced(cr)) } });
    const c = costAgreement(s.db);
    expect(c.pairs).toBe(4);
    expect(c.within).toBe(1);
    expect(c.explained).toBe(1);
    expect(c.other).toBe(2);
    expect(c.within + c.explained + c.other).toBe(c.pairs);
    expect(c.worst.map((w) => w.sessionId).sort()).toEqual(['E2', 'E3']);
  });

  it('is empty on an archive with no snapshot', () => {
    const s = archive();
    expect(costAgreement(s.db)).toEqual({ snapshots: 0, sessions: 0, pairs: 0, within: 0, explained: 0, other: 0, worst: [] });
  });
});
