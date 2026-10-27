// Panel states other than "has data": empty, error and the dismissible coverage note.
import { useState } from 'react';
import type { Failure } from '../lib/api.ts';
import { coverageParts, type CoverageFacts } from '../lib/coverage.ts';

export function EmptyState({ onShowAll, canWiden }: { onShowAll: () => void; canWiden: boolean }) {
  return (
    <div className="state" role="status" data-state="empty">
      <h3 className="state__title">No Claude Code activity in this range</h3>
      <p className="state__text">Nothing was sent or answered on these days with these filters.</p>
      {canWiden && (
        <button type="button" className="btn" onClick={onShowAll}>
          Show all time, every model and project
        </button>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry, onReset }: { error: Failure; onRetry: () => void; onReset: () => void }) {
  return (
    <div className="state state--error" role="alert" data-state="error">
      <h3 className="state__title">{error.kind === 'rejected' ? 'These filters cannot be used' : 'The numbers did not load'}</h3>
      <p className="state__text">{error.message}</p>
      {error.kind === 'rejected' ? (
        <button type="button" className="btn" onClick={onReset}>
          Reset the filters
        </button>
      ) : (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

const DISMISS_KEY = 'ledger.coverageNote.dismissed';

function dismissedBefore(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

// Shown when the range starts before the archive does, or reaches days that are possibly incomplete. Dismissed for the rest of
// the browser session. The words say which of the two applies.
export function CoverageNote(c: CoverageFacts & { ghost?: boolean }) {
  const [gone, setGone] = useState(dismissedBefore);
  if (gone) return null;
  const partial = c.partialGap && c.completeFrom !== null;
  const ghost = c.ghost === true;
  return (
    <aside
      className={ghost ? 'note note--ghost' : 'note'}
      aria-label={ghost ? undefined : 'Coverage'}
      aria-hidden={ghost ? true : undefined}
      data-note={ghost ? 'ghost' : 'coverage'}
      data-unknown={c.coverageGap ? 'true' : undefined}
      data-partial={partial ? 'true' : undefined}
    >
      <span className="note__marks" aria-hidden="true">
        {c.coverageGap && <span className="note__hatch" />}
        {partial && <span className="note__hatch note__hatch--partial" />}
      </span>
      <p className="note__text">
        {coverageParts(c).map((p, i) => (typeof p === 'string' ? p : <strong key={i}>{p.date}</strong>))}
      </p>
      <button
        type="button"
        className="note__close"
        aria-label="Dismiss the coverage note"
        tabIndex={ghost ? -1 : undefined}
        onClick={() => {
          setGone(true);
          try {
            window.sessionStorage.setItem(DISMISS_KEY, '1');
          } catch {
            // storage blocked: dismissed for this page view only
          }
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </aside>
  );
}

// Until the first answer says whether a note is needed, an invisible note of the longest wording holds its place, so the
// figures below do not jump when the note arrives. (Most archives have days that are possibly incomplete.)
export function CoverageGhost() {
  return <CoverageNote ghost archiveStart="2026-09-28" completeFrom="2026-09-28" coverageGap partialGap />;
}
