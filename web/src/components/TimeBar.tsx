// One row above the three time charts: what they count. The choice is shared by the activity heatmap, the daily chart and
// the hour of day chart, and it lives in the address as `metric`.
import type { ActivityMetric } from '../../../src/api/types.ts';
import { METRICS } from '../lib/filters.ts';

export function TimeBar({ metric, onMetric }: { metric: ActivityMetric; onMetric: (m: ActivityMetric) => void }) {
  return (
    <div className="timebar">
      <h2 className="timebar__title">Over time</h2>
      <div className="timebar__right">
        <p className="timebar__note" id="timebar-note">
          The three charts below count the same thing.
        </p>
        <div className="seg seg--quiet" role="group" aria-label="What the time charts count" aria-describedby="timebar-note">
          {METRICS.map((m) => (
            <button key={m.id} type="button" className="seg__btn" aria-pressed={metric === m.id} data-metric={m.id} onClick={() => onMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
