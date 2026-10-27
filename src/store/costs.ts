// Stored costs. usage_events.cost_nanos holds the price of each usage event in nano dollars, NULL while its
// model has no price. upsertUsage keeps it right for every event a pass writes; this module recomputes all of them when the
// price table changes (meta.price_table_version) and at the first start after the migration that added the column.
import { PRICE_TABLE_VERSION, priceEventNanos, type PricedEvent } from '../metrics/prices.ts';
import { stmt, transaction, type Db } from './db.ts';

export const META_PRICE_VERSION = 'price_table_version';

export interface CostColumns {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  speed: string | null;
  inference_geo: string | null; // usage.inference_geo of the winning line; 'us' costs 1.1 times, NULL (older rows) prices as global
}

export function pricedFromRow(r: CostColumns): PricedEvent {
  return {
    model: r.model,
    input: r.input_tokens,
    output: r.output_tokens,
    cacheRead: r.cache_read_tokens,
    cacheWrite: r.cache_write_tokens,
    cacheWrite5m: r.cache_write_5m,
    cacheWrite1h: r.cache_write_1h,
    speed: r.speed,
    geo: r.inference_geo,
  };
}

export function hasCostColumn(db: Db): boolean {
  return (db.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>).some((c) => c.name === 'cost_nanos');
}

function readVersion(db: Db): string | null {
  const r = stmt(db, 'SELECT value FROM meta WHERE key = ?').get(META_PRICE_VERSION) as { value: string } | undefined;
  return r === undefined ? null : r.value;
}

function writeVersion(db: Db): void {
  stmt(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_PRICE_VERSION, String(PRICE_TABLE_VERSION));
}

// Prices every stored usage event again from its own columns and writes the version of the table that was used.
// Returns how many rows changed. Used by ensureCosts and by tests (a full recompute is the reference for the incremental path).
export function recomputeAllCosts(db: Db): number {
  const rows = stmt(
    db,
    `SELECT event_key, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m, cache_write_1h, speed, inference_geo, cost_nanos
       FROM usage_events`,
  ).all() as unknown as Array<CostColumns & { event_key: string; cost_nanos: number | null }>;
  let changed = 0;
  transaction(db, () => {
    const set = stmt(db, 'UPDATE usage_events SET cost_nanos = ? WHERE event_key = ?');
    for (const r of rows) {
      const cost = priceEventNanos(pricedFromRow(r));
      if (cost === r.cost_nanos) continue;
      set.run(cost, r.event_key);
      changed += 1;
    }
    writeVersion(db);
  });
  return changed;
}

// Run when a database is opened. Recomputes every cost when the stored price table version is missing or differs from the
// code's, which covers the first start after the migration and every later change of the table. A no-op otherwise.
// Returns the number of rows that changed, or null when nothing needed doing.
export function ensureCosts(db: Db): number | null {
  if (!hasCostColumn(db)) return null; // a database built from an older set of migrations (tests only)
  if (readVersion(db) === String(PRICE_TABLE_VERSION)) return null;
  return recomputeAllCosts(db);
}
