import type { Filters, Summary } from '../../src/api/types.ts';
import { Header } from './components/Header.tsx';
import { DailyChart } from './components/DailyChart.tsx';
import { DefinitionsPanel } from './components/Definitions.tsx';
import { HealthPanel } from './components/HealthPanel.tsx';
import { Heatmap } from './components/Heatmap.tsx';
import { HourChart } from './components/HourChart.tsx';
import { ModelsTable } from './components/ModelsTable.tsx';
import { ProjectsTable } from './components/ProjectsTable.tsx';
import { SessionsTable } from './components/SessionsTable.tsx';
import { UsageBreakdown } from './components/UsageBreakdown.tsx';
import { Coverage, SummaryPanel } from './components/Summary.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { TimeBar } from './components/TimeBar.tsx';
import { useApi, useLiveEvents } from './lib/api.ts';
import { apiQuery, countActive, resetFilters } from './lib/filters.ts';
import { useFilters } from './lib/useFilters.ts';
import { useMedia } from './lib/useMedia.ts';

export function App() {
  const [filters, setFilters] = useFilters();
  const query = apiQuery(filters);
  const info = useApi<Filters>('/api/filters', '');
  const summary = useApi<Summary>('/api/summary', query);
  const narrow = useMedia('(max-width: 700px)');
  useLiveEvents();

  return (
    <>
      <a className="skip" href="#main">
        Skip to the figures
      </a>
      <Header filters={filters} options={info.data} summary={summary.data} onChange={setFilters} />
      <main id="main" className="page">
        <Coverage query={query} from={filters.from} info={info.data} />
        <SummaryPanel query={query} anyFilter={countActive(filters) > 0} onReset={() => setFilters(resetFilters(filters))} />

        <div className="slots">
          <TimeBar metric={filters.metric} onMetric={(metric) => setFilters({ ...filters, metric })} />
          <Heatmap query={query} metric={filters.metric} />
          <DailyChart
            query={query}
            metric={filters.metric}
            hideCacheRead={filters.hideCacheRead}
            allModels={info.data?.models ?? (info.error !== null ? [] : null)}
            onHideCacheRead={(hideCacheRead) => setFilters({ ...filters, hideCacheRead })}
          />
          <UsageBreakdown
            query={query}
            period={filters.breakdown}
            onPeriod={(breakdown) => setFilters({ ...filters, breakdown })}
            allModels={info.data?.models ?? null}
            ready={summary.data !== null || summary.error !== null}
          />
          <div className="slots__pair slots__pair--hours">
            <HourChart query={query} metric={filters.metric} />
            <ProjectsTable query={query} filters={filters} onChange={setFilters} />
          </div>
          <ModelsTable query={query} filters={filters} allModels={info.data?.models ?? null} onChange={setFilters} />
          <SessionsTable query={query} allModels={info.data?.models ?? null} />
          <div className="fold">
            <DefinitionsPanel />
            <HealthPanel />
          </div>
        </div>
      </main>
      <footer className="foot">
        <div className="foot__inner">
          <p>Everything here is computed from the archive on this Mac. Nothing leaves it.</p>
          {narrow && <ThemeToggle />}
        </div>
      </footer>
    </>
  );
}
