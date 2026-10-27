// Hour of day: 24 bars in local time, the metric follows the shared switch. One series in one hue, the peak hour labelled
// directly, exact values in a tooltip on hover and focus, and a table view.
import { max } from 'd3-array';
import { scaleLinear } from 'd3-scale';
import { useId, useMemo, useState } from 'react';
import type { ActivityMetric, Hours } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import { metricNoun, valueText, valueWithNoun } from '../lib/chartData.ts';
import { chartQuery } from '../lib/filters.ts';
import { axisNum, hourRange, usdAxis, usdExact } from '../lib/format.ts';
import { Bubble, ChartBody, ChartCard, Live, TableView, useBandCursor, useWidth } from './chartKit.tsx';
import { METRIC_NAME } from './Heatmap.tsx';

const ML = 46;
const MT = 28;
const MB = 28;
const PLOT_H = 150;
const SVG_H = MT + PLOT_H + MB;
const MAX_BAR = 24;
const HOURS_HEIGHT = SVG_H;

const pad = (h: number): string => String(h).padStart(2, '0');

function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  if (r < 1) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return `M${x} ${y + h}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h}Z`;
}

function HourPlot({ data, metric, stale }: { data: Hours; metric: ActivityMetric; stale: boolean }) {
  const [hostRef, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/:/g, '');
  const tipId = `hr-tip-${uid}`;
  const hours = data.hours;
  const top = max(hours, (h) => h.value) ?? 0;
  const y = useMemo(() => scaleLinear().domain([0, top > 0 ? top : 1]).nice(3).range([PLOT_H, 0]), [top]);

  const plotW = Math.max(120, width - ML - 10);
  const step = plotW / 24;
  const bw = Math.min(MAX_BAR, Math.max(2, step - 2));
  const bx = (i: number): number => ML + i * step + (step - bw) / 2;
  const peak = hours.reduce((best, h, i) => (h.value > (hours[best]?.value ?? 0) ? i : best), 0);

  const say = (i: number): string => `${hourRange(i)}, ${valueWithNoun(metric, hours[i]?.value ?? 0)}`;
  const cursor = useBandCursor(24, step, say);
  const act = cursor.active;
  const side = act !== null && act < 12 ? 'right' : 'left';

  const labelEvery = plotW >= 480 ? 3 : 6;
  const peakText = `Peak ${pad(peak)}:00`;
  const peakX = ML + (peak + 0.5) * step;
  const peakAnchor = peakX < ML + 40 ? 'start' : peakX > ML + plotW - 40 ? 'end' : 'middle';

  return (
    <div className="hr" ref={hostRef} data-stale={stale ? 'true' : undefined}>
      {width > 0 && (
        <div className="dc__plot">
          <svg className="dc__svg" width={width} height={SVG_H} role="group" aria-label={`${METRIC_NAME[metric]} by local hour`}>
            <g className="ax" aria-hidden="true">
              {y.ticks(3).map((t) => (
                <g key={t}>
                  {t > 0 && <line className="ax__grid" x1={ML} x2={ML + plotW} y1={MT + y(t)} y2={MT + y(t)} />}
                  <text className="ax__t" x={ML - 8} y={MT + y(t)} textAnchor="end" dominantBaseline="central">
                    {metric === 'cost' ? usdAxis(t) : axisNum(t)}
                  </text>
                </g>
              ))}
              <line className="ax__base" x1={ML} x2={ML + plotW} y1={MT + PLOT_H} y2={MT + PLOT_H} />
              {hours.map((h, i) =>
                h.hour % labelEvery === 0 ? (
                  <text key={h.hour} className="ax__t" x={ML + (i + 0.5) * step} y={MT + PLOT_H + 18} textAnchor="middle">
                    {pad(h.hour)}
                  </text>
                ) : null,
              )}
            </g>
            <g
              className="dc__chart"
              role="group"
              aria-roledescription="chart"
              aria-label={`${METRIC_NAME[metric]} by local hour, 24 bars. Left and right arrow keys move between hours, Home and End jump to midnight and 23:00.`}
              aria-describedby={act !== null ? tipId : undefined}
              {...cursor.focusProps}
            >
              {act !== null && <rect className="dc__band" x={ML + act * step} y={MT} width={step} height={PLOT_H} />}
              <g className="dc__bars">
                {hours.map((h, i) => {
                  const hgt = PLOT_H - y(h.value);
                  return h.value > 0 ? (
                    <path key={h.hour} className="dc__seg" d={roundedTop(bx(i), MT + y(h.value), bw, hgt)} fill="var(--series-1)" data-hour={h.hour} data-value={h.value} />
                  ) : (
                    <rect key={h.hour} className="dc__seg" x={bx(i)} y={MT + PLOT_H - 1} width={bw} height={1} fill="var(--series-1)" data-hour={h.hour} data-value={0} />
                  );
                })}
              </g>
              <rect className="dc__hit" x={ML} y={MT} width={plotW} height={PLOT_H} {...cursor.overlayProps} />
            </g>
            {top > 0 && (
              <text className="ax__t ax__t--label hr__peak" x={peakX} y={MT + y(hours[peak]?.value ?? 0) - 8} textAnchor={peakAnchor} aria-hidden="true">
                {peakText}
              </text>
            )}
          </svg>
          {act !== null && (
            <Bubble x={ML + (act + 0.5) * step} side={side} id={tipId}>
              <p className="ctip__head">{hourRange(act)}</p>
              <p className="ctip__big">
                <span className="num ctip__n" title={metric === 'cost' ? usdExact(hours[act]?.value ?? 0) : undefined}>
                  {valueText(metric, hours[act]?.value ?? 0)}
                </span>
                {metricNoun(metric, hours[act]?.value ?? 0) !== '' && ` ${metricNoun(metric, hours[act]?.value ?? 0)}`}
              </p>
            </Bubble>
          )}
          <Live text={cursor.announce} />
        </div>
      )}
    </div>
  );
}

function HourTable({ data, metric }: { data: Hours; metric: ActivityMetric }) {
  return (
    <TableView label={`${METRIC_NAME[metric]} by local hour, as a table`}>
      <table className="dtable" data-table="hours">
        <caption className="sr-only">{METRIC_NAME[metric]} by local hour of day.</caption>
        <thead>
          <tr>
            <th scope="col">Hour</th>
            <th scope="col">{METRIC_NAME[metric]}</th>
          </tr>
        </thead>
        <tbody>
          {data.hours.map((h) => (
            <tr key={h.hour} data-hour={h.hour}>
              <th scope="row">{hourRange(h.hour)}</th>
              <td className="num" data-value={h.value}>
                {valueText(metric, h.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableView>
  );
}

export function HourChart({ query, metric }: { query: string; metric: ActivityMetric }) {
  const api = useApi<Hours>('/api/hours', chartQuery(query, { metric }));
  const [table, setTable] = useState(false);
  const empty = (d: Hours): string | null => (d.hours.every((h) => h.value === 0) ? 'No activity in this range with these filters.' : null);
  return (
    <ChartCard
      id="hours"
      title="Hour of day"
      sub={`${METRIC_NAME[metric]} by local hour`}
      table={api.data === null || empty(api.data) !== null ? null : { shown: table, toggle: () => setTable((t) => !t) }}
    >
      <ChartBody api={api} height={HOURS_HEIGHT} isEmpty={empty}>
        {(data, stale) => (table ? <HourTable data={data} metric={metric} /> : <HourPlot data={data} metric={metric} stale={stale} />)}
      </ChartBody>
    </ChartCard>
  );
}
