// Sync status: a shape plus words, never colour alone. Four states from /api/health plus the live stream, and a fifth
// for a service that cannot be reached.
//   Synced hh:mm                       green filled circle
//   Syncing                            ring with a gap (turns while a pass runs, still under reduced motion)
//   Stale, last sync n min ago         amber triangle (older than three poll intervals)
//   n errors                           red diamond
//   Not connected                      red hollow diamond
import { useEffect, useState } from 'react';
import type { Health } from '../../../src/api/types.ts';
import { refetch, useApi } from '../lib/api.ts';
import { ago, clock } from '../lib/format.ts';
import { requestOpen } from './Disclosure.tsx';

const POLL_MS = 60_000; // the service polls every 60 seconds
const STALE_AFTER_MS = 3 * POLL_MS;

export type SyncKind = 'synced' | 'syncing' | 'stale' | 'errors' | 'offline';

export interface SyncView {
  kind: SyncKind;
  label: string;
  detail: string;
}

export function syncView(health: Health | null, unreachable: boolean, now: number): SyncView {
  if (health === null) {
    return unreachable
      ? { kind: 'offline', label: 'Not connected', detail: 'The ledger service is not answering.' }
      : { kind: 'syncing', label: 'Connecting', detail: 'Waiting for the ledger service.' };
  }
  const when = health.sync.lastSuccessAt;
  const last = when === null ? 'No successful sync yet.' : `Last successful sync at ${clock(when, health.tz)}.`;
  const n = health.errors.total;
  if (n > 0) return { kind: 'errors', label: `${n} ${n === 1 ? 'error' : 'errors'}`, detail: `${n} ingest ${n === 1 ? 'error' : 'errors'}. ${last} Opens Data health.` };
  if (health.sync.running) return { kind: 'syncing', label: 'Syncing', detail: `A pass is reading new transcript lines. ${last}` };
  if (unreachable) return { kind: 'offline', label: 'Not connected', detail: `The ledger service is not answering. ${last}` };
  if (when === null) return { kind: 'stale', label: 'Stale, no sync yet', detail: 'The first sync has not finished.' };
  const age = now - when;
  if (age > STALE_AFTER_MS) return { kind: 'stale', label: `Stale, last sync ${ago(age)} ago`, detail: `${last} Syncs are expected every minute.` };
  return { kind: 'synced', label: `Synced ${clock(when, health.tz)}`, detail: `${last} Opens Data health.` };
}

function Shape({ kind }: { kind: SyncKind }) {
  const common = { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true as const, className: 'pill__shape' };
  switch (kind) {
    case 'synced':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.5" fill="currentColor" />
        </svg>
      );
    case 'syncing':
      return (
        <svg {...common} className="pill__shape pill__shape--spin">
          <path d="M7 2.5a4.5 4.5 0 1 1-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'stale':
      return (
        <svg {...common}>
          <path d="M7 2 12.5 11.5h-11z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="1" />
        </svg>
      );
    case 'errors':
      return (
        <svg {...common}>
          <path d="M7 1.5 12.5 7 7 12.5 1.5 7z" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M7 2.2 11.8 7 7 11.8 2.2 7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      );
  }
}

export function SyncPill() {
  const health = useApi<Health>('/api/health', '');
  const [now, setNow] = useState(() => Date.now());

  // Health is polled so a running pass and a stalled service both show up; the clock ticks so "stale" appears on time.
  useEffect(() => {
    const poll = setInterval(() => refetch('/api/health'), 15_000);
    const tick = setInterval(() => setNow(Date.now()), 20_000);
    const visible = (): void => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        refetch('/api/health');
      }
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  const view = syncView(health.data, health.error !== null, now);
  return (
    <span role="status" className="pillwrap">
      <a className="pill" href="#health" data-state={view.kind} title={view.detail} onClick={() => requestOpen('health')}>
        <Shape kind={view.kind} />
        <span className="pill__text">{view.label}</span>
      </a>
    </span>
  );
}
