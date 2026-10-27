// What `serve` does after every sync pass: bring the rollups up to date and tell open dashboards which days changed.
import type { RunSummary } from '../ingest/ingest.ts';
import { afterPass, type ChangedDays } from '../metrics/rollups.ts';
import type { Db } from '../store/db.ts';
import type { SseHub } from './sse.ts';

// True when a pass changed what the archive holds or what it knows about its files.
export function passChangedSomething(s: RunSummary): boolean {
  return s.filesChanged > 0 || s.filesMarkedDeleted > 0;
}

// Runs afterPass and broadcasts a `synced` event, but only for a pass that changed something.
// Returns the changed days, or null when nothing was done.
export function handlePass(db: Db, tz: string, hub: SseHub, s: RunSummary, now: () => number = Date.now): ChangedDays | null {
  if (!passChangedSomething(s)) return null;
  const days = afterPass(db, tz, s);
  hub.broadcast({ at: now(), changedFrom: days.changedFrom, changedTo: days.changedTo });
  return days;
}
