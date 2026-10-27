// The words about what the archive does and does not hold. Pure, so the sentences can be tested.
import { dayLong } from './format.ts';

export const PARTIAL_LABEL = 'Possibly incomplete';

// Said in the readout of a day or a run of days that is possibly incomplete.
export const PARTIAL_TIP = 'Possibly incomplete. Claude Code may have deleted part of this day before the archive began.';
export const PARTIAL_TIP_RUN = 'Possibly incomplete. Claude Code may have deleted part of these days before the archive began.';

export interface CoverageFacts {
  archiveStart: string;
  completeFrom: string | null;
  coverageGap: boolean; // the range reaches back before the archive start: those days are unknown
  partialGap: boolean; // the range holds days from the archive start up to the day before completeFrom
}

// A piece of the note: plain text, or a date that is set in bold.
export type NotePart = string | { date: string };

// The coverage note. Which sentences it holds depends on the range; both gaps can apply at once.
export function coverageParts(c: CoverageFacts): NotePart[] {
  if (!(c.partialGap && c.completeFrom !== null)) {
    return ['Your archive starts ', { date: dayLong(c.archiveStart) }, '. Claude Code deleted older transcripts after 30 days, so earlier usage is unknown, not zero.'];
  }
  const parts: NotePart[] = ['Days before ', { date: dayLong(c.completeFrom) }, ' only include sessions that were continued later, because Claude Code deletes transcripts after 30 days.'];
  if (c.coverageGap) parts.push(' Days before ', { date: dayLong(c.archiveStart) }, ' are unknown.');
  else parts.push(' Their values are shown, marked as possibly incomplete.');
  return parts;
}

export const coverageText = (c: CoverageFacts): string => coverageParts(c).map((p) => (typeof p === 'string' ? p : p.date)).join('');
