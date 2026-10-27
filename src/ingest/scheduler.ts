// Keeps the archive current while the process runs.
//
// Every trigger runs a full reconcile pass over all roots. The watcher and the poll only decide WHEN to run,
// never what to read. Passes never overlap: a trigger that arrives during a pass sets one flag, and exactly one
// more pass runs after it. A failing pass is reported and the next trigger tries again. Nothing here throws
// into the process.
import { watch as fsWatch } from 'node:fs';
import { runIngest, type IngestOptions, type RunSummary } from './ingest.ts';
import type { Db } from '../store/db.ts';

export type TriggerReason = 'startup' | 'watch' | 'poll' | 'cli';

export interface SyncTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface WatchHandle {
  close(): void;
}

// Starts a recursive watch on `root`. Calls onEvent for every change and onFail once if the watch breaks.
// Throws when the watch cannot be started (for example the folder does not exist yet).
export type WatchFactory = (root: string, onEvent: () => void, onFail: (err: unknown) => void) => WatchHandle;

export interface SyncOptions {
  db: Db;
  roots: string[];
  pollMs?: number; // default 60000
  debounceMs?: number; // default 1500
  watch?: boolean; // default true
  onPass?: (s: RunSummary) => void;
  onError?: (e: unknown) => void;
  // Injection for tests.
  clock?: () => number;
  timers?: SyncTimers;
  watchFactory?: WatchFactory;
  // Replaces runIngest (for example a slow or failing pass).
  ingest?: (db: Db, opts: IngestOptions) => Promise<RunSummary>;
  // Extra options for every pass (reader limits, hooks). roots, full, trigger and now are set by the scheduler.
  ingestOptions?: Pick<IngestOptions, 'read' | 'onBatchCommitted' | 'faultInTransaction'>;
}

export interface SyncStatus {
  running: boolean;
  lastPassAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  watcherAlive: boolean;
}

export interface Sync {
  start(): Promise<void>;
  stop(): Promise<void>;
  trigger(reason: TriggerReason): void;
  status(): SyncStatus;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

const realTimers: SyncTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

const realWatch: WatchFactory = (root, onEvent, onFail) => {
  const w = fsWatch(root, { recursive: true }, () => onEvent());
  w.on('error', onFail);
  w.on('close', () => onFail(new Error('watcher closed')));
  return w;
};

function describe(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const msg = typeof e?.message === 'string' ? e.message : String(err);
  return typeof e?.code === 'string' && !msg.includes(e.code) ? `${e.code}: ${msg}` : msg;
}

export function createSync(opts: SyncOptions): Sync {
  const pollMs = opts.pollMs ?? 60_000;
  const debounceMs = opts.debounceMs ?? 1500;
  const useWatcher = opts.watch ?? true;
  const clock = opts.clock ?? Date.now;
  const timers = opts.timers ?? realTimers;
  const makeWatcher = opts.watchFactory ?? realWatch;
  const ingest = opts.ingest ?? runIngest;
  const firstRoot = opts.roots[0];

  let stopped = false;
  let started = false;
  let active = false; // set and cleared synchronously, so a trigger can never fall between two passes
  let running: Promise<void> | null = null; // what stop() and start() wait for
  let pending: TriggerReason | null = null;
  let lastPassAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;

  let pollTimer: unknown = null;
  let debounceTimer: unknown = null;
  let retryTimer: unknown = null;
  let watcher: WatchHandle | null = null;
  let backoff = BACKOFF_START_MS;

  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // a broken callback must not break the loop
    }
  };

  async function onePass(reason: TriggerReason): Promise<void> {
    try {
      const summary = await ingest(opts.db, {
        ...opts.ingestOptions,
        roots: opts.roots,
        full: false,
        trigger: reason,
        now: clock,
      });
      lastPassAt = clock();
      lastSuccessAt = lastPassAt;
      lastError = null;
      try {
        opts.onPass?.(summary);
      } catch (err) {
        report(err);
      }
    } catch (err) {
      lastPassAt = clock();
      lastError = describe(err);
      report(err);
    }
  }

  function startPass(reason: TriggerReason): void {
    active = true;
    const p = (async () => {
      await Promise.resolve(); // let `running` be assigned before any caller code can look at it
      try {
        let next: TriggerReason | null = reason;
        while (next !== null && !stopped) {
          pending = null;
          await onePass(next);
          next = pending;
        }
      } finally {
        active = false;
      }
    })();
    running = p;
    void p.then(() => {
      if (running === p) running = null;
    });
  }

  function trigger(reason: TriggerReason): void {
    if (stopped) return;
    if (active) {
      pending = reason;
      return;
    }
    startPass(reason);
  }

  // The first event opens a window of debounceMs; every later event inside it joins the same pass.
  // The window is not extended, so a busy session still gets a pass every debounceMs.
  function onWatchEvent(): void {
    backoff = BACKOFF_START_MS; // the watcher works, so the next failure starts the backoff again
    openWindow();
  }

  function openWindow(): void {
    if (stopped || debounceTimer !== null) return;
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null;
      trigger('watch');
    }, debounceMs);
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer !== null) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      startWatcher(true);
    }, wait);
  }

  function startWatcher(afterFailure: boolean): void {
    if (stopped || !useWatcher || firstRoot === undefined) return;
    try {
      const handle = makeWatcher(firstRoot, onWatchEvent, (err) => {
        // Only the current watcher counts; a late event from one we already dropped is ignored.
        if (watcher !== handle) return;
        watcher = null;
        try {
          handle.close();
        } catch {
          // already closed
        }
        lastError = `watcher: ${describe(err)}`;
        report(err);
        scheduleRetry();
      });
      watcher = handle;
      // Changes may have been missed while the watcher was down.
      if (afterFailure) openWindow();
    } catch (err) {
      watcher = null;
      lastError = `watcher: ${describe(err)}`;
      report(err);
      scheduleRetry();
    }
  }

  function armPoll(): void {
    if (stopped) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      trigger('poll');
      armPoll();
    }, pollMs);
  }

  return {
    async start(): Promise<void> {
      if (started || stopped) return;
      started = true;
      trigger('startup');
      if (running !== null) await running;
      if (stopped) return;
      startWatcher(false);
      armPoll();
    },

    async stop(): Promise<void> {
      stopped = true;
      for (const t of [pollTimer, debounceTimer, retryTimer]) if (t !== null) timers.clearTimeout(t);
      pollTimer = debounceTimer = retryTimer = null;
      const w = watcher;
      watcher = null;
      try {
        w?.close();
      } catch {
        // already closed
      }
      if (running !== null) await running;
    },

    trigger,

    status(): SyncStatus {
      return { running: active, lastPassAt, lastSuccessAt, lastError, watcherAlive: watcher !== null };
    },
  };
}
