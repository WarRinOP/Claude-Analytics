// The activity heatmap and the retention horizon. 53 Monday first weeks of days, one sequential ramp from the ground to the
// accent, days before the archive drawn hatched (unknown, never zero) above a hairline that steps along the archive's first
// day. Days after that but before the archive was complete keep their value and colour step and carry a fine stipple of dots
// ("possibly incomplete"), up to a second, dashed hairline. Every cell is reachable by keyboard through one roving tab stop;
// hover or focus opens the day, with its sessions as tally marks. A table view lists every day and value.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { ActivityMetric, DayDetail, Heatmap as HeatmapData } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import { buildGrid, metricNoun, moveIndex, placeFlags, stepRanges, valueText, valueWithNoun, type Grid, type GridCell, type Horizon } from '../lib/chartData.ts';
import { PARTIAL_LABEL, PARTIAL_TIP } from '../lib/coverage.ts';
import { chartQuery } from '../lib/filters.ts';
import { axisNum, clock, dayLong, dayWithWeekday, plural, usd, usdExact, usdScale } from '../lib/format.ts';
import { ChartBody, ChartCard, HatchDefs, PartialDefs, TableView, useWidth } from './chartKit.tsx';
import { Tally } from './Tally.tsx';

const GAP = 3;
const LEFT = 32;
const TOP = 22;
const BOTTOM = 36;
const FLAG_ROW = 16; // one more row of flag labels under the grid
const FLAG_CHAR = 6.9; // estimated width of one character of a flag label
const MIN_PITCH = 15;
const MAX_PITCH = 24;
const TIP_W = 272;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HATCH = 'ledger-hatch-heat';
const PARTIAL = 'ledger-partial-heat';
export const HEATMAP_HEIGHT = 233;

export const METRIC_NAME: Record<ActivityMetric, string> = { messages: 'Messages', tokens: 'Tokens', sessions: 'Sessions', cost: 'Cost' };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const cellName = (c: GridCell, metric: ActivityMetric): string =>
  c.state === 'before'
    ? `${dayWithWeekday(c.day)}, before the archive, not recorded`
    : `${dayWithWeekday(c.day)}, ${valueWithNoun(metric, c.value)}${c.partial ? `, ${PARTIAL_LABEL.toLowerCase()}` : ''}`;

// What one colour step of the scale stands for. Dollars are continuous: the first step is "up to" its bound and each next step
// runs from the bound before it. Counts are whole numbers.
function rangeText(metric: ActivityMetric, level: number, from: number, to: number): string {
  if (metric === 'cost') return level === 1 ? `Up to ${usdScale(to)}` : `${usdScale(from)} to ${usdScale(to)}`;
  const f = (n: number): string => (metric === 'tokens' ? axisNum(n) : valueText(metric, n));
  return from === to ? f(from) : `${f(from)} to ${f(to)}`;
}

// ---- the day readout -----------------------------------------------------------------------------------------------

interface TipProps {
  id: string;
  cell: GridCell;
  metric: ActivityMetric;
  query: string;
  tz: string;
  style: { left: number; top: number };
  above: boolean | null; // null: placed beside the cell, true or false: above or below it
  refCb: (el: HTMLDivElement | null) => void;
}

function DayTip({ id, cell, metric, query, tz, style, above, refCb }: TipProps) {
  const wanted = cell.state === 'value' && cell.value > 0 ? cell.day : null;
  const day = useDebounced(wanted, 110);
  const detail = useApi<DayDetail>('/api/day', chartQuery(query, { date: day ?? '' }), day !== null);
  const sessions = detail.data !== null && detail.data.day === cell.day ? detail.data.sessions : null;
  const shown = sessions?.slice(0, 5) ?? [];

  return (
    <div className="ctip ctip--day" role="tooltip" id={id} ref={refCb} style={style} data-above={above === true ? 'true' : undefined} data-day-tip={cell.day}>
      <p className="ctip__head">{dayWithWeekday(cell.day)}</p>
      {cell.state === 'before' ? (
        <p className="ctip__text">Before the archive starts. Claude Code had already deleted this day, so it is unknown, not zero.</p>
      ) : cell.value === 0 ? (
        <>
          <p className="ctip__text">No activity.</p>
          {cell.partial && <p className="ctip__flag">{PARTIAL_TIP}</p>}
        </>
      ) : (
        <>
          <p className="ctip__big">
            <span className="num ctip__n" title={metric === 'cost' ? usdExact(cell.value) : undefined}>
              {valueText(metric, cell.value)}
            </span>
            {metricNoun(metric, cell.value) !== '' && ` ${metricNoun(metric, cell.value)}`}
          </p>
          {cell.partial && <p className="ctip__flag">{PARTIAL_TIP}</p>}
          <div className="ctip__sessions" data-loaded={sessions !== null ? 'true' : undefined}>
            {sessions === null ? (
              detail.error !== null ? (
                <p className="ctip__text">The sessions of this day could not be loaded.</p>
              ) : (
                <span className="skel skel--line skel--w60" aria-hidden="true" />
              )
            ) : (
              <>
                <div className="ctip__tally">
                  <Tally count={sessions.length} />
                  {metric !== 'sessions' && <span className="ctip__count">{plural(sessions.length, 'session')}</span>}
                </div>
                <ul className="ctip__list">
                  {shown.map((s) => (
                    <li key={s.sessionId}>
                      <span className="num ctip__time">
                        {clock(s.firstTs, tz)} to {clock(s.lastTs, tz)}
                      </span>
                      <span className="ctip__proj">{s.displayName}</span>
                      <span className="num ctip__cost" data-cost={s.costUsd} title={`API price equivalent ${usdExact(s.costUsd)}`}>
                        {usd(s.costUsd)}
                      </span>
                    </li>
                  ))}
                </ul>
                {sessions.length > shown.length && <p className="ctip__more">and {sessions.length - shown.length} more</p>}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- the grid ------------------------------------------------------------------------------------------------------

interface GridProps {
  data: HeatmapData;
  grid: Grid;
  metric: ActivityMetric;
  query: string;
  stale: boolean;
}

function HeatGrid({ data, grid, metric, query, stale }: GridProps) {
  const [scrollRef, width] = useWidth<HTMLDivElement>();
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; right: number; top: number; bottom: number; w: number; h: number } | null>(null);
  const [tipEl, setTipEl] = useState<HTMLDivElement | null>(null);
  const [tipH, setTipH] = useState(0);
  const scrolled = useRef(false);

  const cols = grid.cols;
  const pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.floor(Math.max(0, width - LEFT) / cols)));
  const size = pitch - GAP;
  const svgW = LEFT + cols * pitch - GAP;
  const gridH = 7 * pitch - GAP;
  const gx = (col: number): number => LEFT + col * pitch;
  const gy = (row: number): number => TOP + row * pitch;

  const byDay = useMemo(() => new Map(grid.cells.map((c) => [c.day, c])), [grid]);
  const rows = useMemo(() => WEEKDAYS.map((_, r) => grid.cells.filter((c) => c.row === r)), [grid]);
  const lastCell = grid.cells[grid.lastIndex];
  const rover = activeDay !== null && byDay.get(activeDay)?.state !== 'future' && byDay.has(activeDay) ? activeDay : (lastCell?.day ?? null);

  // The newest weeks matter most: when the grid is wider than its box (a phone), start at the right end.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null && width > 0 && !scrolled.current) {
      scrolled.current = true;
      el.scrollLeft = el.scrollWidth;
    }
  }, [scrollRef, width, svgW]);

  const tipDay = dismissed ? null : (hoverDay ?? focusDay);
  const tipCell = tipDay === null ? null : (byDay.get(tipDay) ?? null);
  const showTip = tipCell !== null && tipCell.state !== 'future';

  useLayoutEffect(() => {
    const host = hostRef.current;
    const g = tipDay === null ? null : svgRef.current?.querySelector<SVGGElement>(`[data-day="${tipDay}"]`);
    if (host === null || g === null || g === undefined) {
      setAnchor(null);
      return;
    }
    const h = host.getBoundingClientRect();
    const r = g.getBoundingClientRect();
    setAnchor({ left: r.left - h.left, right: r.right - h.left, top: r.top - h.top, bottom: r.bottom - h.top, w: h.width, h: h.height });
  }, [tipDay, pitch]);

  // The readout grows when the day's sessions arrive, so its height is observed, not guessed.
  useLayoutEffect(() => {
    if (tipEl === null) return undefined;
    const measure = (): void => setTipH(tipEl.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tipEl);
    return () => ro.disconnect();
  }, [tipEl]);

  const focusCell = (day: string): void => svgRef.current?.querySelector<SVGGElement>(`[data-day="${day}"]`)?.focus();

  const dayOf = (target: EventTarget): string | null => (target as Element).closest?.('[data-day]')?.getAttribute('data-day') ?? null;

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>): void => {
    const day = dayOf(e.target);
    if (day === null) return;
    if (e.key === 'Escape') {
      setDismissed(true);
      return;
    }
    const at = byDay.get(day);
    if (at === undefined) return;
    const next = moveIndex(e.key, at.index, grid.lastIndex);
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cell = grid.cells[next];
    if (cell !== undefined && next !== at.index) focusCell(cell.day);
  };

  const onFocus = (e: FocusEvent<SVGSVGElement>): void => {
    const day = dayOf(e.target);
    if (day === null) return;
    setActiveDay(day);
    setFocusDay(day);
    setDismissed(false);
  };

  const onBlur = (e: FocusEvent<SVGSVGElement>): void => {
    if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setFocusDay(null);
  };

  const onOver = (e: PointerEvent<SVGSVGElement>): void => {
    const day = dayOf(e.target);
    if (day === null) return;
    if (byDay.get(day)?.state === 'future') {
      setHoverDay(null);
      return;
    }
    setHoverDay(day);
    setDismissed(false);
  };

  // Two hairlines at most: where the archive starts, and where it becomes complete. Each steps along its day, and carries a flag
  // with its date. The flags are placed together, so they never overlap, and a flag sits beside the foot of its line.
  const lineX = (h: Horizon): number => gx(h.col) - GAP / 2;
  const marks: { id: 'archive' | 'complete'; h: Horizon; text: string }[] = [];
  if (grid.horizon !== null) marks.push({ id: 'archive', h: grid.horizon, text: `Archive starts ${dayLong(grid.horizon.day)}` });
  if (grid.complete !== null) marks.push({ id: 'complete', h: grid.complete, text: `Complete from ${dayLong(grid.complete.day)}` });
  const placed = placeFlags(
    marks.map((m) => ({ id: m.id, x: lineX(m.h), w: Math.ceil(m.text.length * FLAG_CHAR) })),
    0,
    svgW,
  );
  const rowsUsed = placed.reduce((hi, p) => Math.max(hi, p.row + 1), 1);
  // The last row of flags needs its baseline (20 px under the grid, 16 px per row) and a little room below it.
  const svgH = TOP + gridH + Math.max(BOTTOM, 28 + (rowsUsed - 1) * FLAG_ROW);
  const flags = marks.map((m) => {
    const p = placed.find((x) => x.id === m.id) ?? { anchor: 'start' as const, row: 0 };
    const x = lineX(m.h);
    const base = TOP + gridH + 20 + p.row * FLAG_ROW; // baseline of the text
    const yBottom = base - 4; // the line ends beside the middle of the text
    const xr = gx(m.h.col + 1) - GAP / 2;
    const yTop = TOP - 6;
    const yStep = gy(m.h.row) - GAP / 2;
    const path = m.h.row === 0 ? `M${x} ${yTop}V${yBottom}` : `M${x} ${yBottom}V${yStep}H${xr}V${yTop}`;
    return { ...m, path, textX: p.anchor === 'start' ? x + 6 : x - 6, base, anchor: p.anchor };
  });

  // Beside the cell when the card is wide enough (to the right, or to the left near the right edge), kept inside the card
  // vertically; above or below it on a narrow screen.
  let tipStyle = { left: 0, top: 0 };
  let tipAbove: boolean | null = null;
  if (anchor !== null && tipCell !== null) {
    if (anchor.w >= TIP_W * 2 + 48) {
      const rightOk = anchor.right + 8 + TIP_W <= anchor.w;
      const mid = (anchor.top + anchor.bottom) / 2;
      tipStyle = {
        left: rightOk ? anchor.right + 8 : anchor.left - 8 - TIP_W,
        top: Math.min(Math.max(mid - tipH / 2, 0), Math.max(0, anchor.h - tipH)),
      };
    } else {
      tipAbove = tipCell.row > 2;
      tipStyle = {
        left: Math.min(Math.max((anchor.left + anchor.right) / 2 - TIP_W / 2, 0), Math.max(0, anchor.w - TIP_W)),
        top: tipAbove ? anchor.top - 8 : anchor.bottom + 8,
      };
    }
  }

  return (
    <div className="hm" ref={hostRef} data-stale={stale ? 'true' : undefined}>
      <div className="hm__scroll" ref={scrollRef}>
        <svg
          ref={svgRef}
          className="hm__svg"
          width={svgW}
          height={svgH}
          role="grid"
          aria-label={`${METRIC_NAME[metric]} per day. Arrow keys move by day and by week, Home and End jump to the first and last day.`}
          aria-rowcount={7}
          aria-colcount={cols}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          onPointerOver={onOver}
          onPointerLeave={() => setHoverDay(null)}
        >
          <HatchDefs id={HATCH} />
          <PartialDefs id={PARTIAL} />
          <g className="hm__months" aria-hidden="true">
            {grid.months.map((m) => (
              <text key={m.col} className="hm__lbl" x={gx(m.col)} y={TOP - 8}>
                {m.text}
              </text>
            ))}
          </g>
          <g className="hm__days" aria-hidden="true">
            {[0, 2, 4].map((r) => (
              <text key={r} className="hm__lbl" x={0} y={gy(r) + size / 2} dominantBaseline="central">
                {WEEKDAYS[r]}
              </text>
            ))}
          </g>
          {rows.map((cells, r) => (
            <g role="row" aria-rowindex={r + 1} key={r}>
              {cells.map((c) => {
                const x = gx(c.col);
                const y = gy(c.row);
                const future = c.state === 'future';
                return (
                  <g
                    key={c.day}
                    className="hm__c"
                    role="gridcell"
                    aria-colindex={c.col + 1}
                    aria-label={future ? undefined : cellName(c, metric)}
                    aria-hidden={future ? true : undefined}
                    aria-describedby={showTip && anchor !== null && c.day === tipDay ? 'hm-tip' : undefined}
                    tabIndex={future ? undefined : c.day === rover ? 0 : -1}
                    data-day={c.day}
                    data-value={future || c.state === 'before' ? undefined : c.value}
                    data-level={c.state === 'value' ? c.level : undefined}
                    data-state={c.state}
                    data-partial={c.partial ? 'true' : undefined}
                  >
                    <rect className="hm__hit" x={x - GAP / 2} y={y - GAP / 2} width={pitch} height={pitch} />
                    <rect
                      className="hm__cell"
                      x={x}
                      y={y}
                      width={size}
                      height={size}
                      rx={2}
                      fill={c.state === 'before' ? `url(#${HATCH})` : undefined}
                    />
                    {c.partial && <rect className="hm__partial" x={x} y={y} width={size} height={size} rx={2} fill={`url(#${PARTIAL})`} />}
                  </g>
                );
              })}
            </g>
          ))}
          {flags.map((f) => (
            <g key={f.id} className={f.id === 'archive' ? 'hm__horizon' : 'hm__complete'} data-horizon={f.id === 'archive' ? f.h.day : undefined} data-complete-from={f.id === 'complete' ? f.h.day : undefined}>
              <path d={f.path} />
              <text className={f.id === 'archive' ? 'hm__flag' : 'hm__mark'} x={f.textX} y={f.base} textAnchor={f.anchor}>
                {f.text}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <ul className="hm__scale" aria-label="Colour scale">
        {stepRanges(data.thresholds, metric === 'cost').map((s) => (
          <li key={s.level}>
            <span className="hm__sw" data-level={s.level} aria-hidden="true" />
            <span className="num">{s.level === 0 ? (metric === 'cost' ? '$0' : '0') : rangeText(metric, s.level, s.from, s.to)}</span>
          </li>
        ))}
        {grid.anyPartial && (
          <li data-legend="partial">
            <span className="hm__sw hm__sw--partial" aria-hidden="true" />
            {PARTIAL_LABEL}
          </li>
        )}
        <li>
          <span className="hm__sw hm__sw--before" aria-hidden="true" />
          Before the archive
        </li>
      </ul>

      {showTip && tipCell !== null && anchor !== null && (
        <DayTip id="hm-tip" cell={tipCell} metric={metric} query={query} tz={data.range.tz} style={tipStyle} above={tipAbove} refCb={setTipEl} />
      )}
    </div>
  );
}

// ---- table view ----------------------------------------------------------------------------------------------------

function HeatTable({ grid, metric }: { grid: Grid; metric: ActivityMetric }) {
  const weeks = useMemo(() => Array.from({ length: grid.cols }, (_, c) => grid.cells.slice(c * 7, c * 7 + 7)), [grid]);
  return (
    <>
      <TableView label={`${METRIC_NAME[metric]} per day, as a table`} startAtEnd>
        <table className="dtable" data-table="heatmap">
          <caption className="sr-only">
            {METRIC_NAME[metric]} per day. Each row is a week that starts on Monday. Days before the archive are unknown, not zero.
            {grid.anyPartial ? ` Days marked ${PARTIAL_LABEL.toLowerCase()} may be missing some activity.` : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              {WEEKDAYS.map((d) => (
                <th scope="col" key={d}>
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w[0]?.day}>
                <th scope="row">{w[0] !== undefined ? dayLong(w[0].day) : ''}</th>
                {w.map((c) =>
                  c.state === 'future' ? (
                    <td key={c.day} className="dtable__none" data-day={c.day} data-state="future" />
                  ) : c.state === 'before' ? (
                    <td key={c.day} className="dtable__none" data-day={c.day} data-state="before">
                      unknown
                    </td>
                  ) : (
                    <td key={c.day} className={c.partial ? 'num dtable__partial' : 'num'} data-day={c.day} data-value={c.value} data-partial={c.partial ? 'true' : undefined}>
                      {valueText(metric, c.value)}
                      {c.partial && <span className="sr-only"> ({PARTIAL_LABEL.toLowerCase()})</span>}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableView>
      {grid.anyPartial && (
        <p className="tnote" data-note="partial-table">
          <span className="tnote__key" aria-hidden="true" /> {PARTIAL_LABEL}: the days with a hatched background may be missing some activity.
        </p>
      )}
    </>
  );
}

// ---- the card ------------------------------------------------------------------------------------------------------

export function Heatmap({ query, metric }: { query: string; metric: ActivityMetric }) {
  const api = useApi<HeatmapData>('/api/heatmap', chartQuery(query, { metric }));
  const [table, setTable] = useState(false);
  const grid = useMemo(() => (api.data === null ? null : buildGrid(api.data)), [api.data]);

  const empty = (): string | null => {
    if (api.data === null || grid === null) return null;
    const start = api.data.range.archiveStart;
    if (start === null) return 'Nothing is archived yet, so there is no activity to draw.';
    if (grid.allBefore) return `Nothing is recorded for these days. The archive starts ${dayLong(start)}.`;
    if (grid.allEmpty) return 'No activity in these weeks with these filters.';
    return null;
  };

  return (
    <ChartCard
      id="heatmap"
      title="Activity"
      sub={`${metric === 'cost' ? 'Cost (API price equivalent)' : METRIC_NAME[metric]} per day, ${grid === null ? '53' : grid.cols} weeks, Monday first`}
      table={grid === null || empty() !== null ? null : { shown: table, toggle: () => setTable((t) => !t) }}
    >
      <ChartBody api={api} height={HEATMAP_HEIGHT} isEmpty={empty}>
        {(data, stale) => (grid === null ? null : table ? <HeatTable grid={grid} metric={metric} /> : <HeatGrid data={data} grid={grid} metric={metric} query={query} stale={stale} />)}
      </ChartBody>
    </ChartCard>
  );
}
