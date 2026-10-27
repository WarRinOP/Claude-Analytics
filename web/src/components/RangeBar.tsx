// Range presets (All, 7d, 30d, 90d, Custom). Presets become concrete from/to dates counted back from `today` of the archive's
// time zone, so a bookmarked view always says exactly which days it covers. Custom shows two date inputs, inclusive.
import { useEffect, useState } from 'react';
import { isDay } from '../lib/format.ts';
import { detectPreset, PRESETS, presetRange, type FilterState, type Preset } from '../lib/filters.ts';

interface Props {
  filters: FilterState;
  today: string | null;
  archiveStart: string | null;
  onChange: (next: FilterState) => void;
}

function CustomDates({ filters, today, archiveStart, onChange }: Props) {
  const appliedFrom = filters.from ?? archiveStart ?? today ?? '';
  const appliedTo = filters.to ?? today ?? '';
  const [from, setFrom] = useState(appliedFrom);
  const [to, setTo] = useState(appliedTo);

  // The address changed (Back, a preset): the inputs follow it.
  useEffect(() => {
    setFrom(appliedFrom);
    setTo(appliedTo);
  }, [appliedFrom, appliedTo]);

  const backwards = isDay(from) && isDay(to) && from > to;

  const edit = (nextFrom: string, nextTo: string): void => {
    setFrom(nextFrom);
    setTo(nextTo);
    // Only a complete, ordered pair of days is applied; anything else waits for the next edit.
    if (isDay(nextFrom) && isDay(nextTo) && nextFrom <= nextTo) onChange({ ...filters, from: nextFrom, to: nextTo });
  };

  return (
    <div className="dates" role="group" aria-label="Custom range, both days included">
      <label className="field">
        <span className="field__label">From</span>
        <input type="date" value={from} max={to !== '' ? to : (today ?? undefined)} onChange={(e) => edit(e.target.value, to)} />
      </label>
      <label className="field">
        <span className="field__label">To</span>
        <input type="date" value={to} min={from !== '' ? from : undefined} max={today ?? undefined} onChange={(e) => edit(from, e.target.value)} />
      </label>
      {backwards && (
        <p className="dates__warn" role="alert">
          The start day is after the end day, so the range is not applied.
        </p>
      )}
    </div>
  );
}

export function RangeBar(props: Props) {
  const { filters, today, archiveStart, onChange } = props;
  const preset = detectPreset(filters, today);
  const [customOpen, setCustomOpen] = useState(false);
  const isCustom = preset === 'custom' || customOpen;

  const pick = (id: Exclude<Preset, 'custom'>): void => {
    if (today === null) return;
    setCustomOpen(false);
    onChange({ ...filters, ...presetRange(id, today) });
  };

  const openCustom = (): void => {
    if (today === null) return;
    setCustomOpen(true);
    if (preset !== 'custom' && today !== null) {
      // Start from what is on screen so nothing jumps: the whole archive for All, else the preset's own days.
      onChange({ ...filters, from: filters.from ?? archiveStart ?? today, to: filters.to ?? today });
    }
  };

  return (
    <div className="range">
      <div className="seg" role="group" aria-label="Date range">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="seg__btn" aria-pressed={!isCustom && preset === p.id} onClick={() => pick(p.id)}>
            {p.label}
          </button>
        ))}
        <button type="button" className="seg__btn" aria-pressed={isCustom} onClick={openCustom}>
          Custom
        </button>
      </div>
      {isCustom && <CustomDates filters={filters} today={today} archiveStart={archiveStart} onChange={onChange} />}
    </div>
  );
}
