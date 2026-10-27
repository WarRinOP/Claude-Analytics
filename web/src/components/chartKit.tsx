// Shared pieces of the three time charts: the card frame with its table toggle, loading, empty and error states, the hatch
// pattern, a width observer and the cursor logic of the bar charts (pointer, arrow keys, Escape).
import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { ApiState } from '../lib/api.ts';
import type { Series } from '../lib/chartData.ts';

// ---- measuring -----------------------------------------------------------------------------------------------------

export function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const measure = (): void => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// ---- frame ---------------------------------------------------------------------------------------------------------

interface CardProps {
  id: string;
  title: string;
  sub: string;
  tools?: ReactNode;
  // null: there is no table view yet (nothing loaded)
  table: { shown: boolean; toggle: () => void } | null;
  children: ReactNode;
}

export function ChartCard({ id, title, sub, tools, table, children }: CardProps) {
  return (
    <section className="chart" id={id} data-chart={id} aria-labelledby={`${id}-title`}>
      <header className="chart__head">
        <div className="chart__titles">
          <h2 className="chart__title" id={`${id}-title`}>
            {title}
          </h2>
          <p className="chart__sub">{sub}</p>
        </div>
        <div className="chart__tools">
          {tools}
          {table !== null && (
            <button type="button" className="linkbtn chart__tbl" onClick={table.toggle} data-testid={`${id}-table-toggle`}>
              {table.shown ? 'Show as chart' : 'Show as table'}
            </button>
          )}
        </div>
      </header>
      {children}
    </section>
  );
}

interface BodyProps<T> {
  api: ApiState<T>;
  height: number; // the skeleton height, close to the drawn height so nothing jumps
  isEmpty: (data: T) => string | null; // a sentence when there is nothing to draw
  children: (data: T, stale: boolean) => ReactNode;
}

export function ChartBody<T>({ api, height, isEmpty, children }: BodyProps<T>) {
  if (api.data === null && api.error !== null) {
    // A rejected filter is already explained at the top of the page, so the chart stays quiet and does not repeat the alert.
    if (api.error.kind === 'rejected') return <p className="chart__quiet">This chart is not drawn because the filters cannot be used.</p>;
    return (
      <div className="chart__fail" role="alert" data-state="error">
        <p className="chart__failtitle">This chart did not load</p>
        <p className="chart__failtext">{api.error.message}</p>
        <button type="button" className="btn" onClick={api.retry}>
          Retry
        </button>
      </div>
    );
  }
  if (api.data === null) {
    return <div className="chart__skel skel" aria-hidden="true" style={{ height }} />;
  }
  const empty = isEmpty(api.data);
  if (empty !== null) {
    return (
      <div className="chart__empty" role="status" data-state="empty">
        <p className="chart__emptytitle">{empty}</p>
      </div>
    );
  }
  return (
    <div className="chart__stage" data-stale={api.stale ? 'true' : undefined} aria-busy={api.stale} style={{ minHeight: height }}>
      {api.error !== null && (
        <p className="inline-error" role="alert">
          These numbers could not be refreshed. {api.error.message}{' '}
          <button type="button" className="linkbtn" onClick={api.retry}>
            Retry
          </button>
        </p>
      )}
      {children(api.data, api.stale)}
    </div>
  );
}

// ---- hatch ---------------------------------------------------------------------------------------------------------

// One diagonal pattern from tokens, the same angle as the coverage note swatch. userSpaceOnUse keeps the lines continuous
// across neighbouring hatched cells.
export function HatchDefs({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line className="hatch__line" x1="0.5" y1="0" x2="0.5" y2="5" />
      </pattern>
    </defs>
  );
}

// The lighter marking for days that are possibly incomplete: a fine stipple of dots, so it never reads as the unknown days' full
// hatch of lines. It is drawn over a value, never instead of one. `band` is the fainter version that sits on the plain panel.
export function PartialDefs({ id, band = false }: { id: string; band?: boolean }) {
  const size = band ? 6 : 4;
  return (
    <defs>
      <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse">
        <circle className={band ? 'partial__dot partial__dot--band' : 'partial__dot'} cx={size / 2} cy={size / 2} r={0.8} />
      </pattern>
    </defs>
  );
}

// ---- legend --------------------------------------------------------------------------------------------------------

export function Legend({ series, label, partial = false }: { series: Series[]; label: string; partial?: boolean }) {
  return (
    <ul className="legend" aria-label={label}>
      {series.map((s) => (
        <li key={s.key} data-series={s.key}>
          <span className="legend__key" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
      {partial && <PartialKey />}
    </ul>
  );
}

// The legend entry for possibly incomplete days: the hatch on the ground, with the words.
export function PartialKey() {
  return (
    <li data-legend="partial">
      <span className="legend__key legend__key--partial" aria-hidden="true" />
      Possibly incomplete
    </li>
  );
}

// ---- cursor of a bar chart -----------------------------------------------------------------------------------------

export interface Cursor {
  active: number | null; // the bucket the readout is about
  viaKeys: boolean;
  announce: string; // text for the live region, set by keyboard moves only
  focusProps: {
    tabIndex: 0;
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => void;
    onFocus: (e: FocusEvent<SVGGElement>) => void;
    onBlur: () => void;
  };
  overlayProps: {
    onPointerMove: (e: PointerEvent<SVGRectElement>) => void;
    onPointerDown: (e: PointerEvent<SVGRectElement>) => void;
    onPointerLeave: () => void;
  };
}

// `count` buckets, each `step` pixels wide inside the overlay. The pointer wins while it is over the plot; the keys own the
// readout otherwise. Escape hides the readout until the next move.
export function useBandCursor(count: number, step: number, say: (index: number) => string): Cursor {
  const [pointer, setPointer] = useState<number | null>(null);
  const [key, setKey] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);
  const [announce, setAnnounce] = useState('');

  const fromEvent = useCallback(
    (e: PointerEvent<SVGRectElement>): void => {
      const box = e.currentTarget.getBoundingClientRect();
      const i = Math.floor((e.clientX - box.left) / step);
      setHidden(false);
      setPointer(Math.min(Math.max(i, 0), count - 1));
    },
    [count, step],
  );

  const move = (i: number): void => {
    const next = Math.min(Math.max(i, 0), count - 1);
    setHidden(false);
    setKey(next);
    setAnnounce(say(next));
  };

  const active = hidden || count === 0 ? null : (pointer ?? key);
  return {
    active,
    viaKeys: pointer === null && key !== null,
    announce,
    focusProps: {
      tabIndex: 0,
      onFocus: (e) => {
        if (key === null && e.currentTarget.matches(':focus-visible')) move(count - 1);
      },
      onBlur: () => {
        setKey(null);
        setHidden(false);
      },
      onKeyDown: (e) => {
        const at = key ?? count - 1;
        const jump: Record<string, number> = { ArrowLeft: at - 1, ArrowRight: at + 1, PageUp: at - 7, PageDown: at + 7, Home: 0, End: count - 1 };
        if (e.key === 'Escape') {
          setHidden(true);
          return;
        }
        const to = jump[e.key];
        if (to === undefined) return;
        e.preventDefault();
        move(to);
      },
    },
    overlayProps: {
      onPointerMove: fromEvent,
      onPointerDown: fromEvent,
      onPointerLeave: () => setPointer(null),
    },
  };
}

// The tooltip bubble of the bar charts. Left and right are decided by which half of the plot the bucket is in, so it needs
// no measuring and never covers the bar it describes.
export function Bubble({ x, side, id, children }: { x: number; side: 'left' | 'right'; id: string; children: ReactNode }) {
  return (
    <div className="ctip" role="tooltip" id={id} data-side={side} style={{ left: x }}>
      {children}
    </div>
  );
}

export function Live({ text }: { text: string }) {
  return (
    <p className="sr-only" aria-live="polite" role="status">
      {text}
    </p>
  );
}

// A table view: the accessible twin of a chart. The wrapper scrolls and can take focus, so a keyboard user can read all of it.
// `startAtEnd` opens it at the newest rows, as the heatmap grid opens at the newest weeks.
export function TableView({ label, children, startAtEnd = false }: { label: string; children: ReactNode; startAtEnd?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (startAtEnd && el !== null) el.scrollTop = el.scrollHeight;
  }, [startAtEnd]);
  return (
    <div className="tview" role="region" aria-label={label} tabIndex={0} ref={ref}>
      {children}
    </div>
  );
}
