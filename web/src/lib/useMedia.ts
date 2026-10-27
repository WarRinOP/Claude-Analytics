import { useSyncExternalStore } from 'react';

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', listener);
      return () => m.removeEventListener('change', listener);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
