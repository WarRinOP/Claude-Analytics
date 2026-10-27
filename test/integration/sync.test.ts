import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLog, logFilePath, passLine } from '../../src/config/log.ts';
import { logsDir } from '../../src/config/paths.ts';
import { runIngest, type IngestOptions, type RunSummary } from '../../src/ingest/ingest.ts';
import { createSync, type SyncOptions, type SyncTimers, type WatchFactory } from '../../src/ingest/scheduler.ts';
import type { Db } from '../../src/store/db.ts';
import { openAndMigrate } from '../../src/store/migrate.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { dump, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
let work: string;
let dbCounter = 0;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-sync-')));
});
afterEach(() => {
  env.restore();
  rmSync(work, { recursive: true, force: true });
});

const SID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SID_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function openDb(): Db {
  dbCounter += 1;
  return openAndMigrate(join(env.dir, `sync-${dbCounter}.db`)).db;
}

const pathA = (root: string): string => join(root, '-work-demo', `${SID_A}.jsonl`);
const pathB = (root: string): string => join(root, '-work-other', `${SID_B}.jsonl`);

function stream(sid: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(usageLine(sid, n, { out: 3, ts: n * 10 }), usageLine(sid, n, { out: 40 + n, stop: true, ts: n * 10 + 1 }));
  return out;
}

function count(db: Db, sql = 'SELECT COUNT(*) AS n FROM usage_events'): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function archive(db: Db): string[] {
  return [
    dump(db, 'SELECT * FROM usage_events ORDER BY event_key'),
    dump(db, 'SELECT * FROM messages ORDER BY uuid'),
    dump(db, 'SELECT * FROM tool_calls ORDER BY tool_use_id'),
    dump(db, 'SELECT * FROM sessions ORDER BY session_id'),
  ];
}

const opts = (roots: string[], over: Partial<IngestOptions> = {}): IngestOptions => ({ roots, full: false, trigger: 'test', now: () => 1_000, ...over });

// ---------------------------------------------------------------- deletion marking

describe('deletion marking', () => {
  it('keeps the rows, flags the file as deleted and sets the detection time', async () => {
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 3));
    put(pathB(root), [userLine(SID_B, 'ub1', 1, {}, '/work/other'), ...stream(SID_B, 11, 12)]);
    const db = openDb();
    await runIngest(db, opts([root]));
    const before = archive(db);
    expect(count(db)).toBe(5);

    rmSync(pathB(root));
    const sum = await runIngest(db, opts([root], { now: () => 5_000 }));
    expect(sum.filesMarkedDeleted).toBe(1);
    expect(archive(db)).toEqual(before);
    expect(db.prepare('SELECT path, status, deleted_detected_at FROM source_files ORDER BY path').all()).toEqual([
      { path: pathA(root), status: 'active', deleted_detected_at: null },
      { path: pathB(root), status: 'deleted', deleted_detected_at: 5_000 },
    ]);
    // A later pass does not mark it again.
    expect((await runIngest(db, opts([root], { now: () => 9_000 }))).filesMarkedDeleted).toBe(0);
    expect(count(db, "SELECT deleted_detected_at AS n FROM source_files WHERE status = 'deleted'")).toBe(5_000);
  });

  it('never marks files under a root that was not scanned in this pass', async () => {
    const rootA = join(work, 'live');
    const rootB = join(work, 'snapshot');
    put(pathA(rootA), stream(SID_A, 1, 2));
    put(pathB(rootB), stream(SID_B, 11, 12));
    const db = openDb();
    await runIngest(db, opts([rootA, rootB]));
    const sum = await runIngest(db, opts([rootA]));
    expect(sum.filesMarkedDeleted).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM source_files WHERE status = 'deleted'")).toBe(0);
  });

  it('marks nothing under a root that is missing, and nothing elsewhere either', async () => {
    const rootA = join(work, 'live');
    const rootB = join(work, 'drive');
    put(pathA(rootA), stream(SID_A, 1, 2));
    put(pathB(rootB), stream(SID_B, 11, 12));
    const db = openDb();
    await runIngest(db, opts([rootA, rootB]));
    renameSync(rootB, join(work, 'drive-moved'));
    const sum = await runIngest(db, opts([rootA, rootB]));
    expect(sum.filesMarkedDeleted).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM source_files WHERE status = 'deleted'")).toBe(0);
    expect(count(db)).toBe(4);
    // The same holds when the only root is missing.
    expect((await runIngest(db, opts([rootB]))).filesMarkedDeleted).toBe(0);
  });

  it('a folder that cannot be listed does not make its files look deleted', async () => {
    if (process.getuid?.() === 0) return;
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 2));
    put(pathB(root), stream(SID_B, 11, 12));
    const db = openDb();
    await runIngest(db, opts([root]));
    const dir = join(root, '-work-other');
    chmodSync(dir, 0o000);
    try {
      const sum = await runIngest(db, opts([root]));
      expect(sum.filesMarkedDeleted).toBe(0);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('a deleted file that comes back is active again', async () => {
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 2));
    const db = openDb();
    await runIngest(db, opts([root]));
    const saved = join(work, 'saved.jsonl');
    renameSync(pathA(root), saved);
    await runIngest(db, opts([root]));
    renameSync(saved, pathA(root));
    await runIngest(db, opts([root]));
    expect(db.prepare('SELECT status, deleted_detected_at FROM source_files').all()).toEqual([{ status: 'active', deleted_detected_at: null }]);
    expect(count(db)).toBe(2);
  });
});

// ---------------------------------------------------------------- unreadable file

describe('unreadable file', () => {
  it('is one recorded error, the other files are still ingested, and a repeat adds no row', async () => {
    if (process.getuid?.() === 0) return;
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 3));
    put(pathB(root), stream(SID_B, 11, 12));
    chmodSync(pathA(root), 0o000);
    const db = openDb();
    try {
      const sum = await runIngest(db, opts([root]));
      expect(sum.errors).toBe(1);
      expect(sum.filesScanned).toBe(2);
      expect(count(db)).toBe(2);
      expect(db.prepare('SELECT line_no, byte_offset, line_length, error FROM ingest_errors').all()).toEqual([
        { line_no: null, byte_offset: null, line_length: null, error: 'cannot read file: EACCES' },
      ]);
      const second = await runIngest(db, opts([root]));
      expect(second.errors).toBe(0);
      expect(count(db, 'SELECT COUNT(*) AS n FROM ingest_errors')).toBe(1);
      // Once the file is readable again the error row goes away and its lines arrive.
      chmodSync(pathA(root), 0o644);
      await runIngest(db, opts([root]));
      expect(count(db, 'SELECT COUNT(*) AS n FROM ingest_errors')).toBe(0);
      expect(count(db)).toBe(5);
    } finally {
      chmodSync(pathA(root), 0o644);
    }
  });

  it('an unreadable file that was read before keeps its rows and gets one error row', async () => {
    if (process.getuid?.() === 0) return;
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 3));
    const db = openDb();
    await runIngest(db, opts([root]));
    appendFileSync(pathA(root), stream(SID_A, 4, 4).join('\n') + '\n');
    chmodSync(pathA(root), 0o000);
    try {
      expect((await runIngest(db, opts([root]))).errors).toBe(1);
      expect((await runIngest(db, opts([root]))).errors).toBe(0);
      expect(count(db)).toBe(3);
      expect(count(db, 'SELECT COUNT(*) AS n FROM ingest_errors')).toBe(1);
    } finally {
      chmodSync(pathA(root), 0o644);
    }
    await runIngest(db, opts([root]));
    expect(count(db)).toBe(4);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ingest_errors')).toBe(0);
  });
});

// ---------------------------------------------------------------- changed range

describe('changedRange', () => {
  it('covers the timestamps written in the pass and is null when nothing was written', async () => {
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 3));
    const db = openDb();
    const base = Date.UTC(2026, 9, 1, 10, 0, 0);
    const first = await runIngest(db, opts([root]));
    expect(first.changedRange).toEqual({ minTs: base + 10_000, maxTs: base + 30_000 });
    expect((await runIngest(db, opts([root]))).changedRange).toBeNull();
    appendFileSync(pathA(root), stream(SID_A, 5, 5).join('\n') + '\n');
    expect((await runIngest(db, opts([root]))).changedRange).toEqual({ minTs: base + 50_000, maxTs: base + 50_000 });
  });
});

// ---------------------------------------------------------------- appends during passes

describe('appends while passes run', () => {
  it('ends with the same archive as one clean ingest of the final files', async () => {
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 20));
    put(pathB(root), stream(SID_B, 101, 110));
    const db = openDb();
    let appended = 0;
    const extra = [stream(SID_A, 21, 24), stream(SID_B, 111, 113), stream(SID_A, 25, 26)];
    const o = opts([root], {
      read: { batchBytes: 1, blockBytes: 256 },
      onBatchCommitted: (info) => {
        // Append to the files in the middle of the pass: after the 3rd and the 9th batch.
        if ((info.batchNo === 3 || info.batchNo === 9) && appended < 2) {
          const target = appended === 0 ? pathA(root) : pathB(root);
          appendFileSync(target, extra[appended]!.join('\n') + '\n');
          appended += 1;
        }
      },
    });
    await runIngest(db, o);
    expect(appended).toBe(2);
    // Between passes.
    appendFileSync(pathA(root), extra[2]!.join('\n') + '\n');
    await runIngest(db, opts([root]));
    await runIngest(db, opts([root]));

    const clean = openDb();
    await runIngest(clean, opts([root]));
    const strip = (a: string[]): string[] => a.map((s) => s.replace(/"source_file_id":\d+,?/g, ''));
    expect(strip(archive(db))).toEqual(strip(archive(clean)));
    expect(count(db)).toBe(26 + 13);
  });
});

// ---------------------------------------------------------------- scheduler helpers

interface FakeTimers {
  timers: SyncTimers;
  advance(ms: number): void;
  now(): number;
}

function fakeTimers(): FakeTimers {
  let now = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn, ms) => {
        seq += 1;
        queue.set(seq, { at: now + ms, fn });
        return seq;
      },
      clearTimeout: (h) => {
        queue.delete(h as number);
      },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let id: number | null = null;
        let at = Infinity;
        for (const [k, t] of queue) {
          if (t.at <= target && t.at < at) {
            id = k;
            at = t.at;
          }
        }
        if (id === null) break;
        const t = queue.get(id)!;
        queue.delete(id);
        now = t.at;
        t.fn();
      }
      now = target;
    },
    now: () => now,
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function idle(s: { status(): { running: boolean } }): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    await tick();
    if (!s.status().running) {
      await tick();
      if (!s.status().running) return;
    }
  }
  throw new Error('sync never went idle');
}

function summary(trigger: string, runId = 1): RunSummary {
  return { runId, trigger, filesScanned: 0, filesChanged: 0, linesRead: 0, factsByKind: {}, eventsUpserted: 0, errors: 0, durationMs: 0, filesMarkedDeleted: 0, changedRange: null, sessionsReprojected: 0 };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const noWatch: Pick<SyncOptions, 'watch'> = { watch: false };

// ---------------------------------------------------------------- poll only

describe('poll without a watcher', () => {
  it('keeps the totals correct on its own', async () => {
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 3));
    const db = openDb();
    const ft = fakeTimers();
    const passes: RunSummary[] = [];
    const sync = createSync({ db, roots: [root], ...noWatch, timers: ft.timers, onPass: (s) => passes.push(s) });
    await sync.start();
    expect(count(db)).toBe(3);
    expect(sync.status().watcherAlive).toBe(false);

    appendFileSync(pathA(root), stream(SID_A, 4, 6).join('\n') + '\n');
    put(pathB(root), stream(SID_B, 11, 12));
    ft.advance(59_999);
    await idle(sync);
    expect(count(db)).toBe(3);
    ft.advance(1);
    await idle(sync);
    expect(count(db)).toBe(8);

    appendFileSync(pathA(root), stream(SID_A, 7, 7).join('\n') + '\n');
    ft.advance(60_000);
    await idle(sync);
    expect(count(db)).toBe(9);
    expect(passes.map((p) => p.trigger)).toEqual(['startup', 'poll', 'poll']);
    expect(passes[1]?.changedRange).not.toBeNull();
    expect(sync.status().lastError).toBeNull();
    await sync.stop();
    const clean = openDb();
    await runIngest(clean, opts([root]));
    expect(archive(db).map((s) => s.replace(/"source_file_id":\d+,?/g, ''))).toEqual(archive(clean).map((s) => s.replace(/"source_file_id":\d+,?/g, '')));
  });
});

// ---------------------------------------------------------------- mutex and coalescing

describe('mutex and coalescing', () => {
  it('10 triggers during a slow pass give exactly one follow up pass, and passes never overlap', async () => {
    const db = openDb();
    const g1 = gate();
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const triggers: string[] = [];
    const sync = createSync({
      db,
      roots: [work],
      ...noWatch,
      timers: fakeTimers().timers,
      ingest: async (_db, o) => {
        calls += 1;
        triggers.push(o.trigger);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (calls === 1) await g1.wait;
        else await tick();
        inFlight -= 1;
        return summary(o.trigger, calls);
      },
    });
    const started = sync.start();
    await tick();
    expect(sync.status().running).toBe(true);
    for (let i = 0; i < 10; i++) sync.trigger(i % 2 === 0 ? 'watch' : 'poll');
    expect(calls).toBe(1);
    g1.open();
    await started;
    await idle(sync);
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(triggers[0]).toBe('startup');
    // Nothing further queued.
    await tick();
    expect(calls).toBe(2);
    // A trigger while idle starts a pass at once.
    sync.trigger('watch');
    await idle(sync);
    expect(calls).toBe(3);
    await sync.stop();
  });
});

// ---------------------------------------------------------------- watcher debounce and retry

describe('watcher', () => {
  function fakeWatcher(): { factory: WatchFactory; starts: number[]; emit: () => void; fail: (e?: unknown) => void; failStarts: { value: number } } {
    let onEvent: () => void = () => undefined;
    let onFail: (e: unknown) => void = () => undefined;
    const starts: number[] = [];
    const failStarts = { value: 0 };
    return {
      starts,
      failStarts,
      emit: () => onEvent(),
      fail: (e = new Error('boom')) => onFail(e),
      factory: (_root, ev, fl) => {
        starts.push(starts.length);
        if (failStarts.value > 0) {
          failStarts.value -= 1;
          throw Object.assign(new Error('no such folder'), { code: 'ENOENT' });
        }
        onEvent = ev;
        onFail = fl;
        return { close: () => undefined };
      },
    };
  }

  it('a burst of events inside the debounce window gives one pass', async () => {
    const db = openDb();
    const ft = fakeTimers();
    const fw = fakeWatcher();
    const triggers: string[] = [];
    const sync = createSync({
      db,
      roots: [work],
      timers: ft.timers,
      watchFactory: fw.factory,
      ingest: async (_db, o) => {
        triggers.push(o.trigger);
        return summary(o.trigger);
      },
    });
    await sync.start();
    expect(sync.status().watcherAlive).toBe(true);
    for (let i = 0; i < 50; i++) {
      fw.emit();
      ft.advance(10);
    }
    ft.advance(999);
    await idle(sync);
    expect(triggers).toEqual(['startup']);
    ft.advance(1500);
    await idle(sync);
    expect(triggers).toEqual(['startup', 'watch']);
    fw.emit();
    fw.emit();
    ft.advance(1500);
    await idle(sync);
    expect(triggers).toEqual(['startup', 'watch', 'watch']);
    await sync.stop();
  });

  it('retries a failing watcher with a backoff of 1 s doubling to 60 s, and keeps polling meanwhile', async () => {
    const db = openDb();
    const ft = fakeTimers();
    const attemptAt: number[] = [];
    const triggers: string[] = [];
    const errors: unknown[] = [];
    const sync = createSync({
      db,
      roots: [join(work, 'not-yet')],
      timers: ft.timers,
      onError: (e) => errors.push(e),
      watchFactory: () => {
        attemptAt.push(ft.now());
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      ingest: async (_db, o) => {
        triggers.push(o.trigger);
        return summary(o.trigger);
      },
    });
    await sync.start();
    for (let i = 0; i < 400; i++) {
      ft.advance(1000);
      if (i % 20 === 0) await idle(sync);
    }
    await idle(sync);
    expect(attemptAt.slice(0, 8)).toEqual([0, 1000, 3000, 7000, 15000, 31000, 63000, 123000]);
    expect(sync.status().watcherAlive).toBe(false);
    expect(sync.status().lastError).toContain('watcher');
    expect(errors.length).toBeGreaterThan(5);
    expect(triggers.filter((t) => t === 'poll').length).toBeGreaterThanOrEqual(5);
    await sync.stop();
  });

  it('after the watcher breaks it is restarted and a pass catches up on missed changes', async () => {
    const db = openDb();
    const ft = fakeTimers();
    const fw = fakeWatcher();
    const triggers: string[] = [];
    const sync = createSync({
      db,
      roots: [work],
      timers: ft.timers,
      watchFactory: fw.factory,
      ingest: async (_db, o) => {
        triggers.push(o.trigger);
        return summary(o.trigger);
      },
    });
    await sync.start();
    fw.fail();
    expect(sync.status().watcherAlive).toBe(false);
    ft.advance(999);
    expect(fw.starts.length).toBe(1);
    ft.advance(1);
    expect(fw.starts.length).toBe(2);
    expect(sync.status().watcherAlive).toBe(true);
    ft.advance(1500);
    await idle(sync);
    expect(triggers).toEqual(['startup', 'watch']);
    await sync.stop();
  });

  it('a real watcher on a temp folder picks up an appended line within 5 seconds', async () => {
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 2));
    const db = openDb();
    const sync = createSync({ db, roots: [root], debounceMs: 100 });
    await sync.start();
    expect(count(db)).toBe(2);
    expect(sync.status().watcherAlive).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    appendFileSync(pathA(root), stream(SID_A, 3, 3).join('\n') + '\n');
    while (count(db) < 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
    expect(count(db)).toBe(3);
    expect(Date.now() - t0).toBeLessThan(5000);
    await sync.stop();
    expect(sync.status().watcherAlive).toBe(false);
  }, 20_000);

  it('a real watcher on a folder that does not exist yet starts once it appears', async () => {
    const root = join(work, 'projects-later');
    const db = openDb();
    const sync = createSync({ db, roots: [root], debounceMs: 100 });
    await sync.start();
    expect(sync.status().watcherAlive).toBe(false);
    put(pathA(root), stream(SID_A, 1, 2));
    const t0 = Date.now();
    while (count(db) < 2 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    expect(count(db)).toBe(2);
    expect(sync.status().watcherAlive).toBe(true);
    await sync.stop();
  }, 20_000);
});

// ---------------------------------------------------------------- failures and stop

describe('failures and stop', () => {
  it('survives a pass that throws and tries again on the next trigger', async () => {
    const db = openDb();
    const ft = fakeTimers();
    const errors: string[] = [];
    let calls = 0;
    const sync = createSync({
      db,
      roots: [work],
      ...noWatch,
      timers: ft.timers,
      onError: (e) => errors.push((e as Error).message),
      ingest: async (_db, o) => {
        calls += 1;
        if (calls <= 2) throw new Error(`pass failed ${calls}`);
        return summary(o.trigger, calls);
      },
    });
    await sync.start();
    expect(errors).toEqual(['pass failed 1']);
    expect(sync.status().lastError).toBe('pass failed 1');
    expect(sync.status().lastSuccessAt).toBeNull();
    expect(sync.status().lastPassAt).not.toBeNull();
    ft.advance(60_000);
    await idle(sync);
    expect(errors).toEqual(['pass failed 1', 'pass failed 2']);
    ft.advance(60_000);
    await idle(sync);
    expect(calls).toBe(3);
    expect(sync.status().lastError).toBeNull();
    expect(sync.status().lastSuccessAt).not.toBeNull();
    await sync.stop();
  });

  it('a throwing onPass or onError callback does not break the loop', async () => {
    const db = openDb();
    let calls = 0;
    const sync = createSync({
      db,
      roots: [work],
      ...noWatch,
      timers: fakeTimers().timers,
      onPass: () => {
        throw new Error('bad callback');
      },
      onError: () => {
        throw new Error('bad error callback');
      },
      ingest: async (_db, o) => {
        calls += 1;
        return summary(o.trigger);
      },
    });
    await sync.start();
    sync.trigger('watch');
    await idle(sync);
    expect(calls).toBe(2);
    await sync.stop();
  });

  it('a database error inside a real pass is reported, not thrown', async () => {
    const root = join(work, 'projects');
    put(pathA(root), stream(SID_A, 1, 2));
    const db = openDb();
    const errors: unknown[] = [];
    let n = 0;
    const sync = createSync({
      db,
      roots: [root],
      ...noWatch,
      timers: fakeTimers().timers,
      onError: (e) => errors.push(e),
      ingestOptions: {
        faultInTransaction: () => {
          n += 1;
          if (n === 1) throw new Error('simulated crash');
        },
      },
    });
    await sync.start();
    expect(errors.length).toBe(1);
    expect(count(db)).toBe(0);
    sync.trigger('poll');
    await idle(sync);
    expect(count(db)).toBe(2);
    expect(sync.status().lastError).toBeNull();
    await sync.stop();
  });

  it('stop waits for the running pass, and nothing runs after it', async () => {
    const db = openDb();
    const g = gate();
    let finished = false;
    let calls = 0;
    const sync = createSync({
      db,
      roots: [work],
      ...noWatch,
      timers: fakeTimers().timers,
      ingest: async (_db, o) => {
        calls += 1;
        await g.wait;
        finished = true;
        return summary(o.trigger);
      },
    });
    const started = sync.start();
    await tick();
    sync.trigger('watch');
    let stopped = false;
    const stopping = sync.stop().then(() => {
      stopped = true;
    });
    for (let i = 0; i < 20; i++) await tick();
    expect(stopped).toBe(false);
    expect(finished).toBe(false);
    g.open();
    await stopping;
    await started;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
    // The queued follow up was dropped and later triggers are ignored.
    sync.trigger('poll');
    await tick();
    expect(calls).toBe(1);
    expect(sync.status().running).toBe(false);
    await sync.stop();
  });
});

// ---------------------------------------------------------------- log

describe('log', () => {
  it('writes one line per call with mode 600 and rotates at the limit keeping 3 files', () => {
    for (let i = 0; i < 40; i++) appendLog(`pass trigger=poll run=${i} scanned=1 changed=0`, { maxBytes: 300, now: () => 1_700_000_000_000 });
    const names = readdirSync(logsDir()).sort();
    expect(names).toEqual(['ledger.log', 'ledger.log.1', 'ledger.log.2']);
    for (const n of names) {
      const st = statSync(join(logsDir(), n));
      expect(st.mode & 0o777).toBe(0o600);
      expect(st.size).toBeLessThanOrEqual(300);
    }
    expect(statSync(logsDir()).mode & 0o777).toBe(0o700);
    expect(logFilePath()).toBe(join(logsDir(), 'ledger.log'));
  });

  it('a pass line holds counts only', () => {
    const line = passLine({ ...summary('watch', 7), filesScanned: 4, filesChanged: 1, linesRead: 3, eventsUpserted: 2 });
    expect(line).toBe('pass trigger=watch run=7 scanned=4 changed=1 lines=3 events=2 deleted=0 errors=0 ms=0');
  });
});

// keep the unused import list honest
void mkdirSync;
void writeFileSync;
