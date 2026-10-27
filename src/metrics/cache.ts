// A small answer cache for the few queries that scan the fact tables (session statistics, distinct sessions per day or
// hour, the full table scans of the health report). It never changes an answer: an entry is the exact value the same
// computation gave earlier, and the whole cache is cleared whenever a sync pass changed what the archive holds
// (see handlePass in src/server/live.ts). A time limit bounds the damage of a change nobody announced.
//
// Values are shared between callers and must be treated as read only.

export interface QueryCache {
  get<T>(key: string, compute: () => T): T;
  clear(): void;
  size(): number;
}

export interface CacheOptions {
  ttlMs?: number; // default 60 seconds
  maxEntries?: number; // default 64
  now?: () => number;
}

export function createQueryCache(opts: CacheOptions = {}): QueryCache {
  const ttl = opts.ttlMs ?? 60_000;
  const max = opts.maxEntries ?? 64;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { at: number; value: unknown }>();
  return {
    get<T>(key: string, compute: () => T): T {
      const t = now();
      const hit = entries.get(key);
      if (hit !== undefined && t - hit.at < ttl) {
        // Most recently used last, so the oldest entry is the first key.
        entries.delete(key);
        entries.set(key, hit);
        return hit.value as T;
      }
      const value = compute();
      entries.delete(key);
      entries.set(key, { at: t, value });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
      return value;
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
