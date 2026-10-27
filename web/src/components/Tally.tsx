// Tally marks: one stroke per session, grouped in fives with the fifth drawn across the four before it, the way a ledger is
// kept by hand. Drawn in ink, decorative: the count is always written next to it.
import { tallyGroups } from '../lib/chartData.ts';

const STROKE = 5; // distance between strokes
const HEIGHT = 18;

function Group({ n }: { n: number }) {
  const full = n === 5;
  const gw = full ? 24 : (n - 1) * STROKE + 6;
  return (
    <svg className="tally__group" width={gw} height={HEIGHT} viewBox={`0 0 ${gw} ${HEIGHT}`} data-ticks={n} focusable="false">
      {Array.from({ length: Math.min(n, 4) }, (_, i) => (
        <line key={i} className="tally__tick" x1={3 + i * STROKE} y1={2} x2={3 + i * STROKE} y2={HEIGHT - 2} />
      ))}
      {full && <line className="tally__tick tally__slash" x1={0.5} y1={HEIGHT - 4} x2={gw - 0.5} y2={4} />}
    </svg>
  );
}

export function Tally({ count }: { count: number }) {
  return (
    <span className="tally" aria-hidden="true" data-count={count}>
      {tallyGroups(count).map((n, i) => (
        <Group key={i} n={n} />
      ))}
    </span>
  );
}
