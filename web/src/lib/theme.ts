// Theme choice: System (follow prefers-color-scheme), Dark or Light. Kept in localStorage; the storage can be blocked,
// so every access is guarded and the page works without it.
export type ThemeChoice = 'system' | 'dark' | 'light';

const KEY = 'ledger.theme';

export function savedTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // blocked storage: follow the system
  }
  return 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // the choice still applies for this visit
  }
}
