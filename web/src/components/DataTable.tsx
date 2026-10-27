// Pieces the three data tables share: the scrolling frame, sortable column headers, the model swatch.
import type { ReactNode } from 'react';
import type { SortDir } from '../lib/tables.ts';

// The table scrolls inside this frame, never the page. The frame can take focus so a keyboard user can scroll it.
export function TableScroll({ label, children, tall = false, className = '' }: { label: string; children: ReactNode; tall?: boolean; className?: string }) {
  return (
    <div className={`${tall ? 'tscroll tscroll--tall' : 'tscroll'} ${className}`.trim()} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

// Two small carets drawn as paths: the active one is solid, the other is faint, so the direction is a shape and not a colour.
export function SortGlyph({ dir }: { dir: SortDir | null }) {
  return (
    <svg className="th__glyph" width="9" height="13" viewBox="0 0 9 13" aria-hidden="true" focusable="false" data-dir={dir ?? 'none'}>
      <path className={dir === 'asc' ? 'th__caret th__caret--on' : 'th__caret'} d="M4.5 1.5 8 5.5H1z" />
      <path className={dir === 'desc' ? 'th__caret th__caret--on' : 'th__caret'} d="M4.5 11.5 1 7.5h7z" />
    </svg>
  );
}

interface SortThProps {
  label: string;
  sorted: SortDir | null; // the direction when this column is the sorted one, else null
  numeric?: boolean;
  onSort: () => void;
  hint?: string; // read after the label by assistive technology
}

export function SortTh({ label, sorted, numeric = false, onSort, hint }: SortThProps) {
  return (
    <th scope="col" className={numeric ? 'th th--num' : 'th'} aria-sort={sorted === null ? 'none' : sorted === 'asc' ? 'ascending' : 'descending'}>
      <button type="button" className="th__btn" onClick={onSort} title={hint} aria-label={`Sort by ${label.toLowerCase()}`}>
        <span>{label}</span>
        <SortGlyph dir={sorted} />
      </button>
    </th>
  );
}

// A plain header for a column that cannot be sorted.
export function PlainTh({ label, numeric = false }: { label: string; numeric?: boolean }) {
  return (
    <th scope="col" className={numeric ? 'th th--num th--plain' : 'th th--plain'}>
      <span>{label}</span>
    </th>
  );
}

// A small square in the colour of the model. Decorative: the name is always written beside it.
export function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} aria-hidden="true" />;
}
