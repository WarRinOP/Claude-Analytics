// Daily chart: one bar per day. Tokens are stacked by model in the validated model colours (stack order = the API's model order,
// 2 px surface gaps, rounded data end on the top segment only); messages and sessions are one series in one hue. One y axis,
// a recessive grid, a crosshair band with exact values on hover and focus, a legend for two or more series with direct labels
// when there are four or fewer, and a table view. Days before the archive are drawn hatched, never as zero. Days that are possibly
// incomplete keep their bars and sit on a light stipple of dots, up to a second hairline where the archive becomes complete.
import { max } from 'd3-array';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { useId, useMemo, useState } from 'react';
import type { ActivityMetric, Daily } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import { bucketDays, bucketSize, metricNoun, placeFlags, seriesOf, valueText, valueWithNoun, type Bucket, type Series } from '../lib/chartData.ts';
import { PARTIAL_LABEL, PARTIAL_TIP, PARTIAL_TIP_RUN } from '../lib/coverage.ts';
import { chartQuery } from '../lib/filters.ts';
import { axisNum, dayLong, dayOfMonth, dayShort, dayWithWeekday, monthShort, usdAxis, usdExact, yearOf } from '../lib/format.ts';
import { Bubble, ChartBody, ChartCard, HatchDefs, Legend, Live, PartialDefs, PartialKey, TableView, useBandCursor, useWidth } from './chartKit.tsx';
import { METRIC_NAME } from './Heatmap.tsx';

const ML = 46;
const MT = 24;
const MB = 28;
const PLOT_H = 184;
const SVG_H = MT + PLOT_H + MB;
const MAX_BAR = 24;
const MIN_LABEL_H = 13;
const FLAG_ROW = 16; // one more row of flag labels above the plot
const FLAG_CHAR = 6.9; // estimated width of one character of a flag label
const LEGEND_H = 31; // the legend row above the plot, drawn for two or more series
// Tokens and dollars are stacked by model (a legend above the plot); messages and sessions are one series.
const isStacked = (metric: ActivityMetric): boolean => metric === 'tokens' || metric === 'cost';
const heightFor = (metric: ActivityMetric): number => (isStacked(metric) ? SVG_H + LEGEND_H : SVG_H);

const SINGLE: Series = { key: 'single', label: '', members: [], slot: 0, color: 'var(--series-1)' };

function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  if (r < 1) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return `M${x} ${y + h}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h}Z`;
}

interface Seg {
  series: Series;
  value: number;
  y: number; // top, in plot pixels
  h: number;
  bottom: boolean;
  top: boolean;
}

const valueOf = (b: Bucket, s: Series, stacked: boolean): number => (stacked ? s.members.reduce((sum, m) => sum + (b.byModel[m] ?? 0), 0) : b.total);

const bucketName = (b: Bucket): string => (b.days === 1 ? dayWithWeekday(b.from) : `${dayShort(b.from)} to ${dayLong(b.to)}`);

function tickText(day: string, span: number): string {
  if (span > 60 && dayOfMonth(day) === 1) return monthShort(day) === 'Jan' ? `Jan ${yearOf(day)}` : monthShort(day);
  return dayShort(day);
}

interface PlotProps {
  data: Daily;
  metric: ActivityMetric;
  allModels: string[];
  stale: boolean;
}

function DailyPlot({ data, metric, allModels, stale }: PlotProps) {
  const [hostRef, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/:/g, '');
  const hatch = `ledger-hatch-daily-${uid}`;
  const partialId = `ledger-partial-daily-${uid}`;
  const tipId = `dc-tip-${uid}`;
  const archiveStart = data.range.archiveStart;
  const stacked = isStacked(metric);

  // Colours follow the model: its place in the all time list. If that list is unavailable, fall back to this view's order.
  const order = allModels.length > 0 ? allModels : data.models;
  const series = useMemo<Series[]>(() => (stacked ? seriesOf(data.models, order) : [{ ...SINGLE, label: METRIC_NAME[metric] }]), [stacked, data.models, order, metric]);

  // The plot is wide enough for bars of at least 3 px; past that, runs of days are added up (the table view keeps every day).
  const plotGuess = Math.max(120, width - ML - 12);
  const size = bucketSize(data.days.length, plotGuess);
  const buckets = useMemo(() => bucketDays(data, size, archiveStart, data.range.coverageGap), [data, size, archiveStart]);

  const top = max(buckets, (b) => (b.before ? 0 : b.total)) ?? 0;
  const y = useMemo(() => scaleLinear().domain([0, top > 0 ? top : 1]).nice(4).range([PLOT_H, 0]), [top]);

  const stacks = useMemo<Seg[][]>(
    () =>
      buckets.map((b) => {
        if (b.before) return [];
        let cum = 0;
        const segs: Seg[] = [];
        const vals = series.map((s) => valueOf(b, s, stacked));
        const lastIdx = vals.reduce((acc, v, i) => (v > 0 ? i : acc), -1);
        series.forEach((s, i) => {
          const v = vals[i] ?? 0;
          if (v <= 0) return;
          const y1 = y(cum);
          cum += v;
          const y2 = y(cum);
          segs.push({ series: s, value: v, y: y2, h: y1 - y2, bottom: segs.length === 0, top: i === lastIdx });
        });
        return segs;
      }),
    [buckets, series, y, stacked],
  );

  // Direct labels: only for four series or fewer, on the newest day with activity, only where the segment is tall enough.
  const recent = (() => {
    for (let i = buckets.length - 1; i >= 0; i--) if (!buckets[i]?.before && (buckets[i]?.total ?? 0) > 0) return i;
    return -1;
  })();
  const labels =
    stacked && series.length >= 2 && series.length <= 4 && width >= 720 && recent >= buckets.length - Math.max(1, Math.round(buckets.length * 0.12)) - 1
      ? (stacks[recent] ?? []).filter((s) => s.h >= MIN_LABEL_H).map((s) => ({ seg: s, text: s.series.label }))
      : [];
  const labelW = labels.length === 0 ? 0 : Math.ceil(Math.max(...labels.map((l) => l.text.length)) * 6.6) + 14;
  const gutter = labelW > 0 && labelW <= width * 0.26 ? labelW : 0;
  const shownLabels = gutter > 0 ? labels : [];

  const plotW = Math.max(60, width - ML - 10 - gutter);
  const step = plotW / Math.max(1, buckets.length);
  const gapPx = step >= 6 ? 2 : step >= 4 ? 1 : 0;
  const bw = Math.min(MAX_BAR, Math.max(1, step - gapPx));
  const bx = (i: number): number => ML + i * step + (step - bw) / 2;

  const say = (i: number): string => {
    const b = buckets[i];
    if (b === undefined) return '';
    return b.before
      ? `${bucketName(b)}, before the archive, not recorded`
      : `${bucketName(b)}, ${valueWithNoun(metric, b.total)}${b.partial ? `, ${PARTIAL_LABEL.toLowerCase()}` : ''}`;
  };
  const cursor = useBandCursor(buckets.length, step, say);
  const at = cursor.active === null ? null : (buckets[cursor.active] ?? null);

  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const ticks = useMemo(() => {
    if (first === undefined || last === undefined) return [];
    const d0 = new Date(`${first.from}T00:00:00Z`);
    const d1 = new Date(`${last.to}T00:00:00Z`);
    const dates = scaleUtc().domain([d0, d1]).ticks(Math.max(3, Math.floor(plotW / 80)));
    const out: { i: number; text: string }[] = [];
    const span = data.days.length;
    for (const d of dates) {
      const iso = d.toISOString().slice(0, 10);
      const i = buckets.findIndex((b) => b.from <= iso && iso <= b.to);
      const prev = out[out.length - 1];
      // labels about 50 px wide need at least 70 px between their centres
      if (i >= 0 && (prev === undefined || (i - prev.i) * step >= 70)) out.push({ i, text: tickText(iso, span) });
    }
    return out;
  }, [buckets, first, last, plotW, step, data.days.length]);

  const firstReal = buckets.findIndex((b) => !b.before);
  const horizonX = firstReal > 0 ? ML + firstReal * step : null;
  // The possibly incomplete days are a run from the first real day up to the day before completeFrom.
  const firstPartial = buckets.findIndex((b) => b.partial && !b.before);
  const lastPartial = buckets.reduce((hi, b, i) => (b.partial && !b.before ? i : hi), -1);
  const anyPartial = firstPartial >= 0;
  const completeX = anyPartial && lastPartial + 1 < buckets.length && data.range.completeFrom !== null ? ML + (lastPartial + 1) * step : null;
  // Two hairlines at most, each with a flag at its head. The flags are placed together so they never overlap.
  const marks: { id: 'archive' | 'complete'; x: number; text: string }[] = [];
  if (horizonX !== null && archiveStart !== null) marks.push({ id: 'archive', x: horizonX, text: `Archive starts ${dayLong(archiveStart)}` });
  if (completeX !== null && data.range.completeFrom !== null) marks.push({ id: 'complete', x: completeX, text: `Complete from ${dayLong(data.range.completeFrom)}` });
  const placed = placeFlags(
    marks.map((m) => ({ id: m.id, x: m.x, w: Math.ceil(m.text.length * FLAG_CHAR) })),
    2,
    width - 2,
  );
  const rowsUsed = placed.reduce((hi, p) => Math.max(hi, p.row + 1), 1);
  // The second row of flags sits 16 px above the first; the text of that row needs 14 px more room above the plot.
  const mt = MT + (rowsUsed - 1) * (FLAG_ROW - 2);
  const svgH = mt + PLOT_H + MB;
  const flags = marks.map((m) => {
    const p = placed.find((x) => x.id === m.id) ?? { anchor: 'start' as const, row: 0 };
    const base = mt - 10 - p.row * FLAG_ROW;
    return { ...m, base, anchor: p.anchor, textX: p.anchor === 'start' ? m.x + 6 : m.x - 6 };
  });

  const gridTicks = y.ticks(4);
  const bandX = cursor.active === null ? 0 : ML + cursor.active * step;
  const side = cursor.active !== null && cursor.active < buckets.length / 2 ? 'right' : 'left';
  const tipX = cursor.active === null ? 0 : ML + (cursor.active + 0.5) * step;

  const total = data.days.length;
  const groupLabel = `${METRIC_NAME[metric]} per day${stacked ? ' by model' : ''}, ${total} ${total === 1 ? 'day' : 'days'}. Left and right arrow keys move between ${size === 1 ? 'days' : 'bars'}, Home and End jump to the first and last.`;

  return (
    <div className="dc" ref={hostRef} data-stale={stale ? 'true' : undefined}>
      {series.length >= 2 && <Legend series={series} label="Models" partial={anyPartial} />}
      {width > 0 && (
        <div className="dc__plot">
          <svg className="dc__svg" width={width} height={svgH} role="group" aria-label={`${METRIC_NAME[metric]} per day`}>
            <HatchDefs id={hatch} />
            <PartialDefs id={partialId} band />
            {anyPartial && (
              <rect
                className="dc__partial"
                x={ML + firstPartial * step}
                y={mt}
                width={(lastPartial - firstPartial + 1) * step}
                height={PLOT_H}
                fill={`url(#${partialId})`}
                data-from={buckets[firstPartial]?.from}
                data-to={buckets[lastPartial]?.to}
                aria-hidden="true"
              />
            )}
            <g className="ax" aria-hidden="true">
              {gridTicks.map((t) => (
                <g key={t}>
                  {t > 0 && <line className="ax__grid" x1={ML} x2={ML + plotW} y1={mt + y(t)} y2={mt + y(t)} />}
                  <text className="ax__t" x={ML - 8} y={mt + y(t)} textAnchor="end" dominantBaseline="central">
                    {metric === 'cost' ? usdAxis(t) : axisNum(t)}
                  </text>
                </g>
              ))}
              <line className="ax__base" x1={ML} x2={ML + plotW} y1={mt + PLOT_H} y2={mt + PLOT_H} />
              {ticks.map((t) => {
                const x = ML + (t.i + 0.5) * step;
                const anchor = x < ML + 22 ? 'start' : x > ML + plotW - 22 ? 'end' : 'middle';
                return (
                  <text key={t.i} className="ax__t" x={anchor === 'start' ? ML : anchor === 'end' ? ML + plotW : x} y={mt + PLOT_H + 18} textAnchor={anchor}>
                    {t.text}
                  </text>
                );
              })}
            </g>

            <g
              className="dc__chart"
              role="group"
              aria-roledescription="chart"
              aria-label={groupLabel}
              aria-describedby={at !== null ? tipId : undefined}
              {...cursor.focusProps}
            >
              {at !== null && <rect className="dc__band" x={bandX} y={mt} width={step} height={PLOT_H} />}
              <g className="dc__bars">
                {buckets.map((b, i) =>
                  b.before ? (
                    <rect key={b.from} className="dc__before" x={bx(i)} y={mt} width={bw} height={PLOT_H} fill={`url(#${hatch})`} data-day={b.from} data-state="before" />
                  ) : (
                    <g key={b.from} data-bar={b.from}>
                      {(stacks[i] ?? []).map((s) => {
                        const gap = s.bottom ? 0 : Math.min(2, s.h / 2);
                        const h = s.h - gap;
                        return (
                          <path
                            key={s.series.key}
                            className="dc__seg"
                            d={s.top ? roundedTop(bx(i), mt + s.y, bw, h) : `M${bx(i)} ${mt + s.y}h${bw}v${h}h${-bw}Z`}
                            fill={s.series.color}
                            data-day={b.from}
                            data-to={b.to}
                            data-model={stacked ? s.series.key : undefined}
                            data-value={s.value}
                          />
                        );
                      })}
                    </g>
                  ),
                )}
              </g>
              <rect className="dc__hit" x={ML} y={mt} width={plotW} height={PLOT_H} {...cursor.overlayProps} />
            </g>

            {flags.map((f) => (
              <g
                key={f.id}
                className={f.id === 'archive' ? 'hm__horizon' : 'hm__complete'}
                data-horizon={f.id === 'archive' ? (archiveStart ?? undefined) : undefined}
                data-complete-from={f.id === 'complete' ? (data.range.completeFrom ?? undefined) : undefined}
                aria-hidden="true"
              >
                <path d={`M${f.x} ${f.base - 4}V${mt + PLOT_H}`} />
                <text className={f.id === 'archive' ? 'hm__flag' : 'hm__mark'} x={f.textX} y={f.base} textAnchor={f.anchor}>
                  {f.text}
                </text>
              </g>
            ))}

            {shownLabels.length > 0 && recent >= 0 && (
              <g className="dc__direct" aria-hidden="true">
                {shownLabels.map(({ seg, text }) => {
                  const cy = mt + seg.y + (seg.h - Math.min(2, seg.h / 2)) / 2;
                  return (
                    <g key={seg.series.key}>
                      <line className="ax__leader" x1={bx(recent) + bw + 3} x2={ML + plotW + 6} y1={cy} y2={cy} />
                      <text className="ax__t ax__t--label" x={ML + plotW + 10} y={cy} dominantBaseline="central">
                        {text}
                      </text>
                    </g>
                  );
                })}
              </g>
            )}
          </svg>

          {at !== null && cursor.active !== null && (
            <Bubble x={tipX} side={side} id={tipId}>
              <p className="ctip__head">{bucketName(at)}</p>
              {at.before ? (
                <p className="ctip__text">Before the archive starts. These days are unknown, not zero.</p>
              ) : at.total === 0 ? (
                <p className="ctip__text">No activity.</p>
              ) : stacked ? (
                <>
                  <ul className="ctip__rows">
                    {series
                      .map((s) => ({ s, v: valueOf(at, s, stacked) }))
                      .filter((r) => r.v > 0)
                      .map(({ s, v }) => (
                        <li key={s.key}>
                          <span className="ctip__key" style={{ background: s.color }} aria-hidden="true" />
                          <span className="num ctip__n" title={metric === 'cost' ? usdExact(v) : undefined}>
                            {valueText(metric, v)}
                          </span>
                          <span className="ctip__name">{s.label}</span>
                        </li>
                      ))}
                  </ul>
                  {series.filter((s) => valueOf(at, s, stacked) > 0).length > 1 && (
                    <p className="ctip__total">
                      <span className="num ctip__n" title={metric === 'cost' ? usdExact(at.total) : undefined}>
                        {valueText(metric, at.total)}
                      </span>{' '}
                      <span className="ctip__name">total</span>
                    </p>
                  )}
                </>
              ) : (
                <p className="ctip__big">
                  <span className="num ctip__n">{valueText(metric, at.total)}</span>
                  {metricNoun(metric, at.total) !== '' && ` ${metricNoun(metric, at.total)}`}
                </p>
              )}
              {at.partial && !at.before && <p className="ctip__flag">{at.days === 1 ? PARTIAL_TIP : PARTIAL_TIP_RUN}</p>}
            </Bubble>
          )}
          <Live text={cursor.announce} />
        </div>
      )}
    </div>
  );
}

function DailyTable({ data, metric }: { data: Daily; metric: ActivityMetric }) {
  const stacked = isStacked(metric);
  const start = data.range.archiveStart;
  const before = (day: string): boolean => data.range.coverageGap && start !== null && day < start;
  const anyPartial = data.days.some((d) => d.partial);
  const cols = stacked ? data.models : [];
  return (
    <TableView label={`${METRIC_NAME[metric]} per day, as a table`}>
      <table className="dtable" data-table="daily">
        <caption className="sr-only">{METRIC_NAME[metric]} per day{stacked ? ' by model' : ''}. Days before the archive are unknown, not zero.{anyPartial ? ` Days marked ${PARTIAL_LABEL.toLowerCase()} may be missing some activity.` : ''}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {stacked ? (
              <>
                {cols.map((m) => (
                  <th scope="col" key={m}>
                    {m}
                  </th>
                ))}
                <th scope="col">Total</th>
              </>
            ) : (
              <th scope="col">{METRIC_NAME[metric]}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.days.map((d) =>
            before(d.day) ? (
              <tr key={d.day} data-day={d.day} data-state="before">
                <th scope="row">{dayWithWeekday(d.day)}</th>
                <td className="dtable__none" colSpan={stacked ? cols.length + 1 : 1}>
                  unknown
                </td>
              </tr>
            ) : (
              <tr key={d.day} data-day={d.day} data-partial={d.partial ? 'true' : undefined}>
                <th scope="row">
                  {dayWithWeekday(d.day)}
                  {d.partial && <span className="dtable__sub">{PARTIAL_LABEL}</span>}
                </th>
                {stacked &&
                  cols.map((m) => (
                    <td key={m} className="num" data-model={m} data-value={d.byModel[m] ?? 0}>
                      {valueText(metric, d.byModel[m] ?? 0)}
                    </td>
                  ))}
                <td className="num" data-total={d.total} data-value={stacked ? undefined : d.total}>
                  {valueText(metric, d.total)}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </TableView>
  );
}

interface Props {
  query: string;
  metric: ActivityMetric;
  hideCacheRead: boolean;
  allModels: string[] | null; // null until /api/filters answers: the colours need the all time order
  onHideCacheRead: (hide: boolean) => void;
}

export function DailyChart({ query, metric, hideCacheRead, allModels, onHideCacheRead }: Props) {
  const hide = metric === 'tokens' && hideCacheRead;
  const api = useApi<Daily>('/api/daily', chartQuery(query, { metric, ...(hide ? { hideCacheRead: '1' } : {}) }));
  const [table, setTable] = useState(false);

  const empty = (d: Daily): string | null => {
    if (d.days.every((x) => x.total === 0)) {
      const start = d.range.archiveStart;
      return start !== null && d.range.to < start ? `Nothing is recorded for these days. The archive starts ${dayLong(start)}.` : 'No activity on these days with these filters.';
    }
    return null;
  };

  // The key for possibly incomplete days joins the model legend when there is one; otherwise it sits in the card's head.
  const anyPartial = api.data?.days.some((d) => d.partial) ?? false;
  const keyInHead = anyPartial && !(isStacked(metric) && (api.data?.models.length ?? 0) >= 2);

  const sub = metric === 'tokens' ? `Tokens by model${hide ? ', cache reads hidden' : ''}` : metric === 'cost' ? 'Cost by model, API price equivalent' : `${METRIC_NAME[metric]} per day`;
  return (
    <ChartCard
      id="daily"
      title="Daily"
      sub={sub}
      tools={
        <>
          {keyInHead && (
            <ul className="marks" aria-label="Marks">
              <PartialKey />
            </ul>
          )}
          {metric === 'tokens' && (
            <label className="chk">
              <input type="checkbox" checked={hideCacheRead} onChange={(e) => onHideCacheRead(e.target.checked)} />
              <span>Hide cache reads</span>
            </label>
          )}
        </>
      }
      table={api.data === null || empty(api.data) !== null ? null : { shown: table, toggle: () => setTable((t) => !t) }}
    >
      <ChartBody api={api} height={heightFor(metric)} isEmpty={empty}>
        {(data, stale) =>
          table ? (
            <DailyTable data={data} metric={metric} />
          ) : isStacked(metric) && allModels === null ? (
            <div className="chart__skel skel" aria-hidden="true" style={{ height: heightFor(metric) }} />
          ) : (
            <DailyPlot data={data} metric={metric} allModels={allModels ?? []} stale={stale} />
          )
        }
      </ChartBody>
    </ChartCard>
  );
}
