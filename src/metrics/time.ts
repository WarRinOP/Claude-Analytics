// Time zone arithmetic with Intl only. Every stored timestamp is UTC epoch milliseconds; a local day is
// 'YYYY-MM-DD' in the configured zone. Days can be 23, 24 or 25 hours long, so day bounds are searched, never assumed.

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (f === undefined) {
    // hourCycle h23 keeps midnight as 0 (hour12: false can print 24 in some engines).
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(tz, f);
  }
  return f;
}

function partsOf(ts: number, tz: string): Parts {
  const out: Parts = { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const p of formatFor(tz).formatToParts(ts)) {
    switch (p.type) {
      case 'year':
        out.y = Number(p.value);
        break;
      case 'month':
        out.m = Number(p.value);
        break;
      case 'day':
        out.d = Number(p.value);
        break;
      case 'hour':
        out.h = Number(p.value);
        break;
      case 'minute':
        out.mi = Number(p.value);
        break;
      case 'second':
        out.s = Number(p.value);
        break;
      default:
        break;
    }
  }
  return out;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
const fmtDay = (y: number, m: number, d: number): string => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;

// Offset of the zone from UTC at `ts`, in milliseconds (positive east of Greenwich). Whole seconds.
export function offsetAt(ts: number, tz: string): number {
  const p = partsOf(ts, tz);
  const wholeSecond = ts - (((ts % 1000) + 1000) % 1000);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - wholeSecond;
}

export function localDay(ts: number, tz: string): string {
  const p = partsOf(ts, tz);
  return fmtDay(p.y, p.m, p.d);
}

// Local hour of day, 0 to 23.
export function localHour(ts: number, tz: string): number {
  return partsOf(ts, tz).h;
}

// Wall clock time 'HH:MM:SS' in the zone, for log lines.
export function formatClock(ts: number, tz: string): string {
  const p = partsOf(ts, tz);
  return `${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

// ---------------------------------------------------------------- calendar days (no zone involved)

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDay(s: string): boolean {
  const m = DAY_RE.exec(s);
  if (m === null) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 100) t.setUTCFullYear(y); // Date.UTC maps 0 to 99 onto 1900 to 1999
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// Days since 1970-01-01 of a calendar day. The caller passes a valid day.
export function dayNumber(day: string): number {
  const m = DAY_RE.exec(day);
  if (m === null) throw new Error(`not a calendar day: ${day.slice(0, 20)}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

const dayNames = new Map<number, string>();

export function dayFromNumber(n: number): string {
  let s = dayNames.get(n);
  if (s === undefined) {
    const t = new Date(n * DAY_MS);
    s = fmtDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    if (dayNames.size > 20_000) dayNames.clear();
    dayNames.set(n, s);
  }
  return s;
}

export function addDays(day: string, n: number): string {
  return dayFromNumber(dayNumber(day) + n);
}

// Calendar days from `from` to `to`, both included. Empty when from is after to.
export function daysInRange(from: string, to: string): string[] {
  const a = dayNumber(from);
  const b = dayNumber(to);
  const out: string[] = [];
  for (let n = a; n <= b; n++) out.push(dayFromNumber(n));
  return out;
}

export function dayCount(from: string, to: string): number {
  return Math.max(0, dayNumber(to) - dayNumber(from) + 1);
}

// 0 for Monday up to 6 for Sunday.
export function weekdayMonday0(day: string): number {
  // 1970-01-01 was a Thursday, which is 3 when Monday is 0.
  return (((dayNumber(day) + 3) % 7) + 7) % 7;
}

export function today(tz: string, now: number): string {
  return localDay(now, tz);
}

// ---------------------------------------------------------------- day bounds

const starts = new Map<string, number>();

// First whole second at which the local day is `day` or later.
function searchStart(day: string, tz: string, base: number): number {
  for (const reach of [30 * HOUR_MS, 60 * HOUR_MS]) {
    let lo = base - reach;
    let hi = base + reach;
    if (!(localDay(lo, tz) < day && localDay(hi, tz) >= day)) continue;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (localDay(mid, tz) >= day) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  throw new Error(`cannot find the start of ${day} in ${tz}`);
}

function dayStart(day: string, tz: string): number {
  const key = `${tz}|${day}`;
  const hit = starts.get(key);
  if (hit !== undefined) return hit;
  const base = dayNumber(day) * DAY_MS; // the wall clock midnight, read as if it were UTC
  const o1 = offsetAt(base, tz);
  let cand = base - o1;
  const o2 = offsetAt(cand, tz);
  if (o2 !== o1) cand = base - o2;
  // The quick guess is right unless midnight itself is skipped or repeated; then the search decides.
  const ok = localDay(cand, tz) >= day && localDay(cand - 1000, tz) < day;
  const found = ok ? cand : searchStart(day, tz, base);
  if (starts.size > 50_000) starts.clear();
  starts.set(key, found);
  return found;
}

// UTC [startMs, endMs) of one local day. Correct on 23 and 25 hour days. A day that does not exist in the zone at all
// (Samoa skipped 2011-12-30) gives an empty interval.
export function dayBounds(day: string, tz: string): [number, number] {
  return [dayStart(day, tz), dayStart(addDays(day, 1), tz)];
}

// UTC [startMs, endMs) covering the local days from `from` to `to`, both included.
export function rangeBounds(from: string, to: string, tz: string): [number, number] {
  return [dayStart(from, tz), dayStart(addDays(to, 1), tz)];
}

// ---------------------------------------------------------------- bulk conversion

export interface Localizer {
  day(ts: number): string;
  hour(ts: number): number;
}

const SAMPLE_STEP_MS = 6 * HOUR_MS;

// Converts many timestamps inside [minTs, maxTs] without calling Intl for each one. The zone offset is sampled
// every six hours and every change is located to the second, so the result equals localDay and localHour.
// Timestamps outside the window use the exact functions.
export function makeLocalizer(tz: string, minTs: number, maxTs: number): Localizer {
  const lo0 = Math.min(minTs, maxTs);
  const hi0 = Math.max(minTs, maxTs);
  const starts: number[] = [Number.NEGATIVE_INFINITY];
  const offsets: number[] = [offsetAt(lo0, tz)];
  let prevT = lo0;
  let cur = offsets[0] as number;
  for (let t = lo0 + SAMPLE_STEP_MS; ; t += SAMPLE_STEP_MS) {
    const at = Math.min(t, hi0);
    const o = offsetAt(at, tz);
    if (o !== cur) {
      let lo = prevT;
      let hi = at;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (offsetAt(mid, tz) === cur) lo = mid;
        else hi = mid;
      }
      starts.push(hi);
      offsets.push(o);
      cur = o;
    }
    prevT = at;
    if (at >= hi0) break;
  }

  const localMs = (ts: number): number => {
    let i = starts.length - 1;
    while (i > 0 && ts < (starts[i] as number)) i--;
    return ts + (offsets[i] as number);
  };
  return {
    day(ts) {
      if (ts < lo0 || ts > hi0) return localDay(ts, tz);
      return dayFromNumber(Math.floor(localMs(ts) / DAY_MS));
    },
    hour(ts) {
      if (ts < lo0 || ts > hi0) return localHour(ts, tz);
      const l = localMs(ts);
      return Math.floor((l - Math.floor(l / DAY_MS) * DAY_MS) / HOUR_MS);
    },
  };
}
