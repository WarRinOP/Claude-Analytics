// The top of the ledger: coverage note, four KPI cards and the secondary stats row, all from /api/summary.
import type { Filters, Summary } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import { Kpis } from './Kpis.tsx';
import { Stats } from './Stats.tsx';
import { CoverageGhost, CoverageNote, EmptyState, ErrorState } from './States.tsx';

export function isEmpty(s: Summary): boolean {
  return s.sessions === 0 && s.messages === 0 && s.tokens.total === 0;
}

export function Coverage({ query, from, info }: { query: string; from: string | null; info: Filters | null }) {
  const s = useApi<Summary>('/api/summary', query);
  // Until this range's own answer arrives, guess from the archive start and the complete from day, so the note does not pop in late.
  const archiveStart = info?.archiveStart ?? null;
  const knownComplete = info?.completeFrom ?? null;
  const predictedUnknown = archiveStart !== null && from !== null && from < archiveStart;
  const predictedPartial = archiveStart !== null && knownComplete !== null && knownComplete > archiveStart && (from === null || from < knownComplete);
  const fresh = s.data !== null && !s.stale ? s.data.range : null;
  const coverageGap = fresh !== null ? fresh.coverageGap : predictedUnknown;
  const partialGap = fresh !== null ? fresh.partialGap : predictedPartial;
  const start = s.data?.range.archiveStart ?? archiveStart;
  const completeFrom = s.data?.range.completeFrom ?? knownComplete;
  if (fresh === null && info === null && s.error === null) return <CoverageGhost />;
  if ((!coverageGap && !partialGap) || start === null) return null;
  return <CoverageNote archiveStart={start} completeFrom={completeFrom} coverageGap={coverageGap} partialGap={partialGap} />;
}

interface Props {
  query: string;
  anyFilter: boolean;
  onReset: () => void;
}

export function SummaryPanel({ query, anyFilter, onReset }: Props) {
  const s = useApi<Summary>('/api/summary', query);

  if (s.data === null && s.error !== null) return <ErrorState error={s.error} onRetry={s.retry} onReset={onReset} />;
  if (s.data !== null && !s.stale && isEmpty(s.data)) return <EmptyState onShowAll={onReset} canWiden={anyFilter} />;

  return (
    <div className="panel" data-stale={s.stale ? 'true' : undefined} aria-busy={s.data === null || s.stale}>
      {s.error !== null && s.data !== null && (
        <p className="inline-error" role="alert">
          These numbers could not be refreshed. {s.error.message}{' '}
          <button type="button" className="linkbtn" onClick={s.retry}>
            Retry
          </button>
        </p>
      )}
      <section aria-labelledby="h-figures">
        <h2 className="sr-only" id="h-figures">
          Key figures
        </h2>
        <Kpis data={s.data} />
      </section>
      <Stats data={s.data} />
    </div>
  );
}
