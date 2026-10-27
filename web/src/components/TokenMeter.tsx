// Token composition: one stacked bar of input, output, cache write and cache read with 2 px surface gaps, and the same four
// numbers as a real table underneath (name, exact count, share). The table is the legend and the accessible version of the bar.
import type { TokenTotals } from '../../../src/api/types.ts';
import { full, percent } from '../lib/format.ts';
import { Digits } from './BigNumber.tsx';
import { Tip } from './Tip.tsx';

interface Kind {
  id: 'input' | 'output' | 'cacheWrite' | 'cacheRead';
  name: string;
  color: string;
}

// Bar order. Colours are the validated token sequence in tokens.css.
export const KINDS: Kind[] = [
  { id: 'input', name: 'Input', color: 'var(--tok-input)' },
  { id: 'output', name: 'Output', color: 'var(--tok-output)' },
  { id: 'cacheWrite', name: 'Cache write', color: 'var(--tok-write)' },
  { id: 'cacheRead', name: 'Cache read', color: 'var(--tok-read)' },
];

const SKELETON_ROWS = [0, 1, 2, 3];

export function TokenMeter({ tokens, background }: { tokens: TokenTotals | null; background: TokenTotals | null }) {
  if (tokens === null) {
    return (
      <div className="tokens" aria-hidden="true">
        <div className="meter meter--skel skel" />
        <table className="mini">
          <tbody>
            {SKELETON_ROWS.map((i) => (
              <tr key={i}>
                <th scope="row">
                  <span className="skel skel--line skel--w40" />
                </th>
                <td>
                  <span className="skel skel--line skel--w60" />
                </td>
                <td>
                  <span className="skel skel--line skel--w30" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="card__note">&nbsp;</p>
      </div>
    );
  }

  const total = tokens.total;
  const share = (n: number): number => (total > 0 ? n / total : 0);
  const summary = KINDS.map((k) => `${k.name} ${percent(share(tokens[k.id]))}`).join(', ');

  return (
    <div className="tokens">
      <div className="meter" role="img" aria-label={`Token composition: ${summary}`}>
        {KINDS.filter((k) => tokens[k.id] > 0).map((k) => (
          <Tip
            key={k.id}
            focusable={false}
            align={k.id === 'cacheRead' ? 'end' : 'start'}
            className="meter__seg"
            kind={k.id}
            style={{ flexGrow: tokens[k.id] }}
            text={`${k.name}: ${full(tokens[k.id])} tokens, ${percent(share(tokens[k.id]))}`}
          />
        ))}
      </div>
      <table className="mini">
        <caption className="sr-only">Token composition in this range</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Tokens</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {KINDS.map((k) => (
            <tr key={k.id} data-kind={k.id}>
              <th scope="row">
                <span className="swatch" data-kind={k.id} aria-hidden="true" />
                {k.name}
              </th>
              <td className="mini__n" data-kpi={`tokens.${k.id}`} data-full={full(tokens[k.id])}>
                <Digits text={full(tokens[k.id])} />
              </td>
              <td className="mini__p">{percent(share(tokens[k.id]))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="card__note">
        {background === null ? (
          <>Background calls are not included.</>
        ) : (
          <>
            Includes <span className="num">{full(background.total)}</span> tokens from background calls.
          </>
        )}
      </p>
    </div>
  );
}
