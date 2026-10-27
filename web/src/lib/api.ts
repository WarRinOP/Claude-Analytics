// Data layer: one fetch per panel per filter key, cached; the `synced` Server Sent Event refetches what is on screen.
//
// A panel asks for (path, query). Panels that ask for the same key share one request and one cached answer. When a key
// changes the panel keeps drawing the previous answer (marked stale) until the new one arrives, so nothing jumps.
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ApiError, SyncedEvent } from '../../../src/api/types.ts';

export type FailureKind = 'unreachable' | 'rejected' | 'server';

export interface Failure {
  kind: FailureKind;
  status: number | null;
  message: string; // a plain sentence
}

interface Entry {
  data: unknown;
  error: Failure | null;
  fetching: boolean; // a request is in flight
  at: number; // when data last arrived
}

const entries = new Map<string, Entry>();
const watchers = new Map<string, number>(); // how many mounted panels read each key
const listeners = new Set<() => void>();
const EMPTY: Entry = { data: null, error: null, fetching: false, at: 0 };

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function urlFor(key: string): string {
  return key;
}

export const keyOf = (path: string, query: string): string => (query === '' ? path : `${path}?${query}`);

async function load(key: string): Promise<void> {
  const prev = entries.get(key) ?? EMPTY;
  entries.set(key, { ...prev, fetching: true });
  emit();
  let next: Entry;
  try {
    const res = await fetch(urlFor(key), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (res.ok) {
      next = { data: (await res.json()) as unknown, error: null, fetching: false, at: Date.now() };
    } else {
      let message = 'The ledger service refused this request.';
      try {
        const body = (await res.json()) as Partial<ApiError>;
        if (typeof body.error === 'string') message = body.error;
      } catch {
        // keep the generic sentence
      }
      const kind: FailureKind = res.status >= 500 ? 'server' : 'rejected';
      next = { ...prev, error: { kind, status: res.status, message }, fetching: false };
    }
  } catch {
    next = {
      ...prev,
      error: { kind: 'unreachable', status: null, message: 'The ledger service is not answering, so these numbers cannot be shown.' },
      fetching: false,
    };
  }
  entries.set(key, next);
  emit();
}

export function refetch(key: string): void {
  void load(key);
}

let invalidateTimer: ReturnType<typeof setTimeout> | null = null;

// A pass finished: everything on screen is refetched (keeping its old answer visible meanwhile), everything else is dropped.
export function invalidateAll(): void {
  if (invalidateTimer !== null) return;
  invalidateTimer = setTimeout(() => {
    invalidateTimer = null;
    for (const key of [...entries.keys()]) {
      if ((watchers.get(key) ?? 0) > 0) void load(key);
      else entries.delete(key);
    }
  }, 60);
}

export interface ApiState<T> {
  data: T | null; // the newest answer for this key, or the previous key's answer while the new one loads
  stale: boolean; // data belongs to an earlier key, or a refetch is running
  loading: boolean; // nothing to draw yet
  error: Failure | null;
  retry: () => void;
}

// Asks for one panel's data. `enabled` false waits (no request).
export function useApi<T>(path: string, query: string, enabled = true): ApiState<T> {
  const key = keyOf(path, query);
  const entry = useSyncExternalStore(
    subscribe,
    () => entries.get(key) ?? EMPTY,
    () => EMPTY,
  );
  const lastGood = useRef<{ key: string; data: T } | null>(null);
  if (entry.data !== null) lastGood.current = { key, data: entry.data as T };

  useEffect(() => {
    if (!enabled) return undefined;
    watchers.set(key, (watchers.get(key) ?? 0) + 1);
    const known = entries.get(key);
    if (known === undefined || (known.data === null && !known.fetching)) void load(key);
    return () => {
      const n = (watchers.get(key) ?? 1) - 1;
      if (n <= 0) watchers.delete(key);
      else watchers.set(key, n);
    };
  }, [key, enabled]);

  const retry = useCallback(() => refetch(key), [key]);
  const own = entry.data !== null;
  const shown = own ? (entry.data as T) : (lastGood.current?.data ?? null);
  return {
    data: shown,
    stale: shown !== null && (!own || entry.fetching),
    loading: shown === null && entry.error === null,
    error: entry.error,
    retry,
  };
}

// ---- Server Sent Events -------------------------------------------------------------------------------------------

export function useLiveEvents(onSynced?: (e: SyncedEvent) => void): void {
  const cb = useRef(onSynced);
  cb.current = onSynced;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    const es = new EventSource('/api/events');
    let broken = false;
    const synced = (ev: MessageEvent<string>): void => {
      try {
        cb.current?.(JSON.parse(ev.data) as SyncedEvent);
      } catch {
        // an unreadable event still means "something changed"
      }
      invalidateAll();
    };
    es.addEventListener('synced', synced as EventListener);
    es.onerror = () => {
      broken = true;
    };
    es.onopen = () => {
      // The stream came back after a break: events may have been missed, so refetch.
      if (broken) {
        broken = false;
        invalidateAll();
      }
    };
    return () => es.close();
  }, []);
}
