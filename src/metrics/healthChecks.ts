// The words of the health report, shared by the Data health panel (web/) and `cli.ts doctor`, so both say the same thing.
// Pure functions of a Health answer: no file system, no DOM, no clock except the `now` that is passed in.
import type { Health } from '../api/types.ts';

export type Verdict = 'ok' | 'note' | 'problem';

export interface Check {
  id: 'sync' | 'source' | 'errors' | 'types' | 'versions' | 'cost' | 'canary' | 'prices';
  name: string;
  verdict: Verdict;
  word: string; // the verdict in words; a shape always travels with it
  text: string; // one or two plain sentences
}

export const VERDICT_WORD: Record<Verdict, string> = { ok: 'OK', note: 'Worth a look', problem: 'Problem' };
export const OVERALL_WORD: Record<Verdict, string> = { ok: 'Healthy', note: 'Worth a look', problem: 'Needs attention' };

// Why the cost record and the transcripts differ.
export const COST_CHECK_WHY =
  'Snapshots differ because Claude Code restarts its counters when a session is resumed, some sessions keep going after their last snapshot, and some snapshots count calls that never reach a transcript. Transcripts are the record this app counts. The cost record is only a cross check and changes no number.';

export const CANARY_NAME = 'Transcripts may have moved';

// ---- small formatters (English, no locale surprises) --------------------------------------------------------------------

const grouped = new Intl.NumberFormat('en-US');
export const countText = (n: number): string => grouped.format(n);

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${countText(n)} ${n === 1 ? one : many}`;
}

export function bytesText(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function agoText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function zoned(ms: number, tz: string): Record<string, string> {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

// "27 Oct 2026 11:42:10" in the given zone.
export function stampText(ms: number, tz: string): string {
  const p = zoned(ms, tz);
  return `${p['day']} ${MONTHS[Number(p['month']) - 1] ?? ''} ${p['year']} ${p['hour']}:${p['minute']}:${p['second']}`;
}

// "11:42" in the given zone.
export function clockText(ms: number, tz: string): string {
  const p = zoned(ms, tz);
  return `${p['hour']}:${p['minute']}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-10-27" to "27 Oct 2026".
export function dayText(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1] ?? ''} ${y}`;
}

export const shortId = (id: string): string => id.slice(0, 8);

// ---- error wording ---------------------------------------------------------------------------------------------------------

// The reader stores short codes. This is what each one means in plain words.
export function errorExplanation(error: string): string {
  switch (error) {
    case 'invalid json':
      return 'The line is not valid JSON, so it was skipped.';
    case 'not an object':
      return 'The line is valid JSON but not a record, so it was skipped.';
    case 'missing uuid':
      return 'A message line has no uuid, so it was skipped.';
    case 'bad timestamp':
      return 'The line has no readable timestamp, so it was skipped.';
    case 'classifier error':
      return 'The line could not be classified, so it was skipped.';
    case 'line too large, skipped':
      return 'The line is larger than the reader accepts, so it was skipped.';
    default: {
      const m = /^cannot read file: ([A-Z0-9_]+)$/.exec(error);
      if (m !== null) return `The file could not be read (${m[1]}). The next pass tries again.`;
      return error.slice(0, 160);
    }
  }
}

// Where an error sits, in words: "line 4, byte 120", "line 4" or "whole file".
export function placeText(lineNo: number | null, byteOffset: number | null): string {
  if (lineNo === null) return 'whole file';
  return byteOffset === null ? `line ${countText(lineNo)}` : `line ${countText(lineNo)}, byte ${countText(byteOffset)}`;
}

// ---- the checks ------------------------------------------------------------------------------------------------------------

export interface CheckOptions {
  now: number;
  // true when the answer comes from the running service (so "stale" and "watching" mean something); false for `doctor`.
  live: boolean;
}

function listText(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

function syncCheck(h: Health, o: CheckOptions): Check {
  const base = { id: 'sync', name: 'Sync' } as const;
  const s = h.sync;
  if (s.lastError !== null) {
    const err = s.lastError.slice(0, 200).replace(/[.\s]+$/, '');
    const next = o.live ? ' The next attempt is within a minute.' : '';
    return { ...base, verdict: 'problem', word: VERDICT_WORD.problem, text: `Sync is failing: ${err}.${next}` };
  }
  if (h.lastPass === null) {
    return {
      ...base,
      verdict: 'note',
      word: VERDICT_WORD.note,
      text: o.live ? 'No pass has finished yet. The first one reads every transcript file.' : 'No pass has finished yet. Start the service with serve, or run ingest once.',
    };
  }
  const p = h.lastPass;
  const age = s.lastSuccessAt === null ? null : o.now - s.lastSuccessAt;
  if (o.live && age !== null && age > 180_000) {
    return { ...base, verdict: 'note', word: VERDICT_WORD.note, text: `The last successful pass was ${agoText(age)} ago. Passes are expected every minute.` };
  }
  const pass = `Last pass ${stampText(p.at, h.tz)}, ${durationText(p.durationMs)}, trigger ${p.trigger}: ${plural(p.filesChanged, 'file')} changed of ${countText(p.filesScanned)}, ${plural(p.linesRead, 'line')} read.`;
  const watching = o.live ? (s.watcherAlive ? ' Watching the transcript folder.' : ' Not watching for changes. The minute poll still runs.') : '';
  return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: pass + watching };
}

function sourceCheck(h: Health): Check {
  const base = { id: 'source', name: 'Transcript folder' } as const;
  if (h.files.active + h.files.deleted === 0) {
    return { ...base, verdict: 'note', word: VERDICT_WORD.note, text: `No transcript files are tracked yet. Claude Code writes them under ${h.sourceRoot === '' ? 'its projects folder' : h.sourceRoot}.` };
  }
  const gone =
    h.files.deleted === 0
      ? 'None were deleted at the source.'
      : `${plural(h.files.deleted, 'file')} deleted at the source. ${plural(h.sessions.sourceDeleted, 'session')} kept in the archive after that.`;
  return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: `${plural(h.files.active, 'file')} tracked. ${gone}` };
}

function errorsCheck(h: Health): Check {
  const base = { id: 'errors', name: 'Ingest errors' } as const;
  const n = h.errors.total;
  if (n === 0) return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: 'Every line and file read so far was understood.' };
  return {
    ...base,
    verdict: 'note',
    word: VERDICT_WORD.note,
    text: `${plural(n, 'problem')} reading transcripts. Each is listed with its file and position. Nothing from a skipped line is in the archive, and the text of the line is never stored.`,
  };
}

// The four counts that make up the token total. Any other usage field is optional detail.
const TOKEN_FIELDS = new Set(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']);

function typesCheck(h: Health): Check {
  const base = { id: 'types', name: 'Record types and fields' } as const;
  const parts: string[] = [];
  if (h.unknownTypes.length > 0) {
    const names = [...new Set(h.unknownTypes.map((u) => u.type))];
    parts.push(`${plural(names.length, 'record type')} this app does not know (${listText(names, 4)}). They are counted and ignored, and no number depends on them.`);
  }
  let tokenFieldMissing = false;
  if (h.missingFields.length > 0) {
    const names = [...new Set(h.missingFields.map((f) => f.field))];
    tokenFieldMissing = names.some((n) => TOKEN_FIELDS.has(n));
    parts.push(
      tokenFieldMissing
        ? `${plural(names.length, 'usage field')} missing on some lines (${listText(names, 4)}). A missing count was read as 0, which can lower the token totals.`
        : `${plural(names.length, 'optional usage field')} missing on some lines (${listText(names, 3)}), usually from older Claude Code versions. None of them is part of the token total.`,
    );
  }
  if (parts.length === 0) return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: 'Every record type and usage field was recognised.' };
  return { ...base, verdict: tokenFieldMissing ? 'note' : 'ok', word: tokenFieldMissing ? VERDICT_WORD.note : VERDICT_WORD.ok, text: parts.join(' ') };
}

function versionsCheck(h: Health): Check {
  const base = { id: 'versions', name: 'Claude Code versions' } as const;
  if (h.versions.length === 0) return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: 'No usage has been archived yet.' };
  const latest = h.versions[0] as Health['versions'][number];
  const where = h.entrypoints.length === 0 ? '' : ` Entrypoints: ${listText(h.entrypoints.map((e) => `${e.entrypoint === '' ? 'not recorded' : e.entrypoint} ${countText(e.responses)}`), 5)}.`;
  return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: `${plural(h.versions.length, 'version')} seen, the newest ${latest.version === '' ? 'not recorded' : latest.version}.${where}` };
}

function costCheck(h: Health): Check {
  const base = { id: 'cost', name: 'Cost record agreement' } as const;
  const c = h.costCheck;
  if (c.sessionsWithSnapshot === 0) return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: 'No session cost records have been archived, so there is nothing to compare.' };
  if (c.compared === 0) return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: `${plural(c.sessionsWithSnapshot, 'session')} with a cost record, none comparable with transcript totals yet.` };
  const rate = ((c.withinOnePercent / c.compared) * 100).toFixed(1);
  return {
    ...base,
    verdict: 'ok',
    word: VERDICT_WORD.ok,
    text: `${countText(c.withinOnePercent)} of ${plural(c.compared, 'session')} match Claude Code's own cost record within 1 percent (${rate} percent). Differences are expected. The worst are listed below.`,
  };
}

// The price table behind the API price equivalent. A model without a price is a note: its responses are counted but add no
// dollars, so the cost total is a floor until the table lists the model.
function pricesCheck(h: Health): Check {
  const base = { id: 'prices', name: 'API price table' } as const;
  const p = h.prices;
  const date = dayText(p.tableDate);
  const remainder =
    p.cacheWriteRemainderEvents === 0
      ? ''
      : ` ${plural(p.cacheWriteRemainderEvents, 'response')} had cache write parts that did not add up, so the remainder was priced at the 5 minute rate.`;
  if (p.unpricedModels.length === 0) {
    return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: `Every archived model has a price in the table of ${date}.${remainder}` };
  }
  const names = listText(p.unpricedModels.map((m) => `${m.model} ${plural(m.responses, 'response')}`), 3);
  return {
    ...base,
    verdict: 'note',
    word: VERDICT_WORD.note,
    text: `${plural(p.unpricedModels.length, 'model')} without a price in the table of ${date} (${names}). Their responses are counted as price unknown, never as zero dollars, so the cost total is a floor.${remainder}`,
  };
}

function canaryCheck(h: Health): Check {
  const base = { id: 'canary', name: 'Transcript location' } as const;
  const c = h.canary;
  if (c.status === 'warning') return { ...base, verdict: 'problem', word: VERDICT_WORD.problem, text: `${CANARY_NAME}. ${c.message}` };
  if (c.status === 'unknown') return { ...base, verdict: 'note', word: VERDICT_WORD.note, text: c.message };
  return { ...base, verdict: 'ok', word: VERDICT_WORD.ok, text: c.message };
}

export function healthChecks(h: Health, o: CheckOptions): Check[] {
  return [syncCheck(h, o), sourceCheck(h), errorsCheck(h), typesCheck(h), canaryCheck(h), versionsCheck(h), costCheck(h), pricesCheck(h)];
}

export interface Overall {
  verdict: Verdict;
  word: string;
}

// The headline of the report. `degraded` and a canary warning are the two things that make the doctor exit with 1.
export function overall(h: Health, checks: Check[]): Overall {
  const worst: Verdict = h.status === 'degraded' || checks.some((c) => c.verdict === 'problem') ? 'problem' : checks.some((c) => c.verdict === 'note') ? 'note' : 'ok';
  return { verdict: worst, word: OVERALL_WORD[worst] };
}

// What `doctor` returns to the shell: 1 when the status is degraded or the transcript check warns, else 0.
export const needsAttention = (h: Health): boolean => h.status === 'degraded' || h.canary.status === 'warning';
