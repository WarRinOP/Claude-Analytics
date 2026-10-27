// Run time settings: the time zone, the HTTP port and the app version.
import { readFileSync } from 'node:fs';

export const DEFAULT_PORT = 47821;

function checkZone(name: string): string {
  try {
    // Throws a RangeError for a name Intl does not know.
    new Intl.DateTimeFormat('en-US', { timeZone: name });
  } catch {
    throw new Error(`The time zone "${name.slice(0, 60)}" is not valid. Use a zone name such as Asia/Dhaka or America/New_York.`);
  }
  return name;
}

// LEDGER_TZ if set, else the zone of this Mac. Always validated with Intl.
export function tz(): string {
  const fromEnv = process.env['LEDGER_TZ'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return checkZone(fromEnv.trim());
  return checkZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
}

// LEDGER_PORT if set (1 to 65535), else 47821.
export function port(): number {
  const raw = process.env['LEDGER_PORT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`LEDGER_PORT must be a whole number from 1 to 65535, not "${raw.slice(0, 20)}".`);
  }
  return n;
}

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

// How long Claude Code keeps a transcript after it was last written (its cleanupPeriodDays, 30 by default). The app
// never reads Claude Code's settings, so a different value is given as LEDGER_RETENTION_DAYS (1 to 3650).
export function retentionDays(): number {
  const raw = process.env['LEDGER_RETENTION_DAYS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const t = raw.trim();
  const n = Number(t);
  if (!/^\d{1,4}$/.test(t) || n < 1 || n > MAX_RETENTION_DAYS) {
    throw new Error(`LEDGER_RETENTION_DAYS must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}, not "${raw.slice(0, 20)}".`);
  }
  return n;
}

let cachedVersion: string | null = null;

export function appVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}
