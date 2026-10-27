// Filters as a view of the address bar. Writing a filter pushes a history entry, so Back returns to the previous view.
import { useCallback, useSyncExternalStore } from 'react';
import { parseSearch, toSearch, type FilterState } from './filters.ts';

const EVENT = 'ledger:url';

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(EVENT, listener);
  };
}

const snapshot = (): string => window.location.search;

export function useFilters(): [FilterState, (next: FilterState, mode?: 'push' | 'replace') => void] {
  const search = useSyncExternalStore(subscribe, snapshot, () => '');
  const set = useCallback((next: FilterState, mode: 'push' | 'replace' = 'push') => {
    const url = `${window.location.pathname}${toSearch(next)}${window.location.hash}`;
    if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    if (mode === 'replace') window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [parseSearch(search), set];
}
