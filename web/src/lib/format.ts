// Number, date and duration formatting. Pure functions, no locale surprises: always English, always the zone the server reports.

const grouped = new Intl.NumberFormat('en-US');
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

// 8718733449 -> "8,718,733,449"
export function full(n: number): string {
  return grouped.format(n);
}

// 8718733449 -> "8.72B". Used only where the full number does not fit.
export function compact(n: number): string {
  return compactFmt.format(n);
}

const WORD_UNITS = ['Thousand', 'Million', 'Billion', 'Trillion'] as const;

// 8668208738 -> "8.67 Billion". Exactly two decimals, a capitalised unit word, one space. Null under 1,000 (the full figure is short).
// Written with whole numbers (BigInt) so the rounding boundary is exact: a value that rounds to 1,000.00 of a unit is written in the
// next unit (999995000 -> "1.00 Billion", 999994999 -> "999.99 Million"). Trillion is the last unit; beyond it the digits are grouped
// (1234000000000000 -> "1,234.00 Trillion").
export function tokenWords(n: number): string | null {
  if (!Number.isFinite(n) || n < 1000) return null;
  const whole = BigInt(Math.round(n));
  for (let i = 0; i < WORD_UNITS.length; i++) {
    const unit = 1000n ** BigInt(i + 1);
    const hundredths = (whole * 100n + unit / 2n) / unit; // half up
    const last = i === WORD_UNITS.length - 1;
    if (hundredths >= 100_000n && !last) continue; // would read 1,000.00 of this unit: use the next one
    const intPart = hundredths / 100n;
    const frac = String(hundredths % 100n).padStart(2, '0');
    return `${grouped.format(intPart)}.${frac} ${WORD_UNITS[i]}`;
  }
  return null;
}

const axisFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

// ---- dollars (the API price equivalent) -------------------------------------------------------------------------------

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdCompactFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const usdExactFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });

// 2606.8242 -> "$2,606.82". A value under one cent says so instead of rounding to nothing: 0.004 -> "<$0.01". Zero is "$0.00".
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return usdFmt.format(n);
}

// "$2.61K", used only where the full figure does not fit.
export function usdCompact(n: number): string {
  return n > 0 && n < 0.01 ? '<$0.01' : usdCompactFmt.format(n);
}

// The exact value, up to six decimals: 0.004123 -> "$0.004123", 2606.8242 -> "$2,606.8242". Tooltips and accessible names.
export function usdExact(n: number): string {
  return usdExactFmt.format(n);
}

// A bound on the heatmap's colour scale: cents from a cent up, the exact amount below it (a quiet day can cost a fraction of a cent).
export function usdScale(n: number): string {
  return n > 0 && n < 0.01 ? usdExactFmt.format(Number(n.toPrecision(2))) : usdFmt.format(n);
}

// Axis ticks in dollars: "$0", "$5", "$0.50", "$1.2K".
export function usdAxis(n: number): string {
  if (Math.abs(n) >= 1000) return `$${axisFmt.format(n)}`;
  if (Number.isInteger(n)) return `$${n}`;
  const t = Number(n.toFixed(4));
  const dec = String(t).split('.')[1]?.length ?? 0;
  return `$${t.toFixed(Math.max(2, dec))}`;
}

// Axis ticks: plain below 1,000, then 1K, 2.5M, 1.2B.
export function axisNum(n: number): string {
  return Math.abs(n) < 1000 ? String(n) : axisFmt.format(n);
}

// Share of a whole as text. Tiny shares say so instead of rounding to zero.
export function percent(share: number): string {
  const p = share * 100;
  if (p === 0) return '0%';
  if (p < 0.05) return '<0.1%';
  return `${p.toFixed(1)}%`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${full(n)} ${n === 1 ? one : many}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y as number, m as number, d as number];
}

// "2026-10-16" -> "16 Oct 2026"
export function dayLong(day: string): string {
  const [y, m, d] = parts(day);
  return `${d} ${MONTHS[m - 1] ?? ''} ${y}`;
}

// "2026-10-16" -> "16 Oct"
export function dayShort(day: string): string {
  const [, m, d] = parts(day);
  return `${d} ${MONTHS[m - 1] ?? ''}`;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// 0 for Monday to 6 for Sunday.
export function weekdayIndex(day: string): number {
  const [y, m, d] = parts(day);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// "2026-10-27" -> "Tue 27 Oct 2026"
export function dayWithWeekday(day: string): string {
  return `${WEEKDAYS[weekdayIndex(day)] ?? ''} ${dayLong(day)}`;
}

export function monthShort(day: string): string {
  return MONTHS[parts(day)[1] - 1] ?? '';
}

export function dayOfMonth(day: string): number {
  return parts(day)[2];
}

export function yearOf(day: string): number {
  return parts(day)[0];
}

export function isDay(value: string | null | undefined): value is string {
  if (value === null || value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = parts(value);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Calendar arithmetic on local dates, independent of the browser's own zone.
export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

// 23 -> "23:00 to 00:00"
export function hourRange(hour: number): string {
  const pad = (h: number): string => String(h).padStart(2, '0');
  return `${pad(hour)}:00 to ${pad((hour + 1) % 24)}:00`;
}

// Milliseconds as "6 h 25 m", "2 d 5 h" or "under 1 m".
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under 1 m';
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} m`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

// "16:11" in the given zone.
export function clock(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  }
}

// "4 min", "3 h", "2 d"
export function ago(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}
