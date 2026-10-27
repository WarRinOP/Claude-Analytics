// Title, range bar, model and project filters, theme toggle and sync pill. Filters scope everything below them.
import type { Filters, Summary } from '../../../src/api/types.ts';
import { dayLong, plural } from '../lib/format.ts';
import type { FilterState } from '../lib/filters.ts';
import { countActive, resetFilters } from '../lib/filters.ts';
import { useMedia } from '../lib/useMedia.ts';
import { MultiSelect } from './MultiSelect.tsx';
import { RangeBar } from './RangeBar.tsx';
import { SyncPill } from './SyncPill.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

// Five tally strokes with the fifth drawn across: the mark of a ledger kept by hand.
export function Mark() {
  return (
    <svg className="brand__mark" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none">
        <path d="M6 5.5v15M10.7 5.5v15M15.3 5.5v15M20 5.5v15" />
        <path d="M3.5 17.5 22.5 8.5" />
      </g>
    </svg>
  );
}

interface Props {
  filters: FilterState;
  options: Filters | null;
  summary: Summary | null;
  onChange: (next: FilterState) => void;
}

export function Header({ filters, options, summary, onChange }: Props) {
  const narrow = useMedia('(max-width: 700px)');
  const modelOptions = (options?.models ?? []).map((m) => ({ value: m, label: m }));
  const projectOptions = (options?.projects ?? []).map((p) => ({
    value: p.projectKey,
    label: p.displayName,
    ...(p.aliases.length > 0 ? { hint: `Also seen as ${p.aliases.join(', ')}` } : {}),
  }));
  const range = summary?.range ?? null;

  return (
    <header className="top">
      <div className="top__inner">
        <div className="top__row">
          <div className="brand">
            <Mark />
            <div>
              <h1 className="brand__title">Usage Ledger</h1>
              <p className="brand__sub">Claude Code on this Mac</p>
            </div>
          </div>
          <div className="top__right">
            {!narrow && <ThemeToggle />}
            <SyncPill />
          </div>
        </div>

        <div className="controls" role="group" aria-label="Filters">
          <RangeBar filters={filters} today={options?.today ?? null} archiveStart={options?.archiveStart ?? null} onChange={onChange} />
          <div className="controls__pair">
            <MultiSelect
              name="Model"
              plural="models"
              options={modelOptions}
              selected={filters.models}
              onChange={(models) => onChange({ ...filters, models })}
              badge={filters.includeBackground || !filters.includeSubagents}
            >
              <fieldset className="ms__extra">
                <legend>Also count</legend>
                <label className="ms__item">
                  <input type="checkbox" checked={filters.includeSubagents} onChange={(e) => onChange({ ...filters, includeSubagents: e.target.checked })} />
                  <span className="ms__text">
                    <span className="ms__label">Subagent calls</span>
                    <span className="ms__hint">Tokens and tools from subagent transcripts</span>
                  </span>
                </label>
                <label className="ms__item">
                  <input type="checkbox" checked={filters.includeBackground} onChange={(e) => onChange({ ...filters, includeBackground: e.target.checked })} />
                  <span className="ms__text">
                    <span className="ms__label">Background calls</span>
                    <span className="ms__hint">Usage seen only in session cost snapshots</span>
                  </span>
                </label>
              </fieldset>
            </MultiSelect>
            <MultiSelect name="Project" plural="projects" options={projectOptions} selected={filters.projects} onChange={(projects) => onChange({ ...filters, projects })} />
          </div>
          <p className="controls__read" data-testid="range-readout">
            {range === null ? (
              ' '
            ) : (
              <>
                <span className="num">{dayLong(range.from)}</span> to <span className="num">{dayLong(range.to)}</span>, {plural(range.days, 'day')}
              </>
            )}
          </p>
          {countActive(filters) > 0 && (
            <button type="button" className="linkbtn controls__reset" onClick={() => onChange(resetFilters(filters))}>
              Reset filters
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
