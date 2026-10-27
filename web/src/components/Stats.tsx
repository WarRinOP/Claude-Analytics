// Secondary stats row: peak hour, peak day, favorite model, longest session, current and longest streak.
// A value the API reports as null says "Not enough data" instead of a zero.
import type { Summary } from '../../../src/api/types.ts';
import { dayLong, dayShort, duration, hourRange, plural } from '../lib/format.ts';
import { Tip } from './Tip.tsx';

const NONE = 'Not enough data';

const DEFS: { id: string; label: string }[] = [
  { id: 'peakHour', label: 'Peak hour' },
  { id: 'peakDay', label: 'Peak day' },
  { id: 'favoriteModel', label: 'Favorite model' },
  { id: 'longestSession', label: 'Longest session' },
  { id: 'currentStreak', label: 'Current streak' },
  { id: 'longestStreak', label: 'Longest streak' },
];

interface Cell {
  id: string;
  label: string;
  value: string | null;
  caption: string;
  tip?: string;
}

function cells(s: Summary): Cell[] {
  const ls = s.longestSession;
  return [
    {
      id: 'peakHour',
      label: 'Peak hour',
      value: s.peakHour === null ? null : hourRange(s.peakHour.hour),
      caption: s.peakHour === null ? '' : `${plural(s.peakHour.messages, 'message')}, local time`,
    },
    {
      id: 'peakDay',
      label: 'Peak day',
      value: s.peakDay === null ? null : dayLong(s.peakDay.day),
      caption: s.peakDay === null ? '' : plural(s.peakDay.messages, 'message'),
    },
    {
      id: 'favoriteModel',
      label: 'Favorite model',
      value: s.favoriteModel === null ? null : s.favoriteModel.model,
      caption: s.favoriteModel === null ? '' : plural(s.favoriteModel.tokens, 'token'),
    },
    {
      id: 'longestSession',
      label: 'Longest session',
      value: ls === null ? null : `${duration(ls.activeMs)} active`,
      caption: ls === null ? '' : ls.displayName,
      ...(ls === null
        ? {}
        : {
            tip: `${ls.title !== null ? `${ls.title}. ` : ''}Wall clock from first to last event: ${duration(ls.wallMs)}. Active time counts only gaps of 30 minutes or less.`,
          }),
    },
    {
      id: 'currentStreak',
      label: 'Current streak',
      value: plural(s.currentStreak, 'day'),
      caption: 'counting back from today',
    },
    {
      id: 'longestStreak',
      label: 'Longest streak',
      value: s.longestStreak === null ? null : plural(s.longestStreak.days, 'day'),
      caption: s.longestStreak === null ? '' : s.longestStreak.from === s.longestStreak.to ? dayLong(s.longestStreak.to) : `${dayShort(s.longestStreak.from)} to ${dayLong(s.longestStreak.to)}`,
    },
  ];
}

export function Stats({ data }: { data: Summary | null }) {
  const list: Cell[] | null = data === null ? null : cells(data);
  return (
    <dl className="stats" aria-label="More figures for this range">
      {(list ?? DEFS.map((d): Cell => ({ ...d, value: null, caption: '' }))).map((c) => (
        <div className="stat" key={c.id} data-stat={c.id}>
          <dt>{c.label}</dt>
          {list === null ? (
            <>
              <dd>
                <span className="skel skel--line skel--w70" aria-hidden="true" />
              </dd>
              <dd className="stat__cap">
                <span className="skel skel--line skel--w50" aria-hidden="true" />
              </dd>
            </>
          ) : (
            <>
              <dd className={c.value === null ? 'stat__none' : 'stat__val'} data-value={c.value ?? undefined}>
                {c.value === null ? (
                  NONE
                ) : c.tip !== undefined ? (
                  <Tip text={c.tip} align="end">
                    {c.value}
                  </Tip>
                ) : (
                  c.value
                )}
              </dd>
              <dd className="stat__cap">{c.value === null ? ' ' : c.caption}</dd>
            </>
          )}
        </div>
      ))}
    </dl>
  );
}

