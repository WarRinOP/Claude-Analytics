// Projects table: from /api/projects, sortable. A row click sets the project filter in the address (the project alone);
// clicking the project that is already the whole filter clears it. Aliases (symlink folders pointing at the same project) are
// listed under the display name.
import { useState } from 'react';
import type { Projects } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import type { FilterState } from '../lib/filters.ts';
import { full, plural, usd, usdExact } from '../lib/format.ts';
import { PROJECT_COLUMNS, dateTimeText, nextSort, projectValue, sortRows, toggleProject, type ProjectKey, type ProjectRow, type SortState } from '../lib/tables.ts';
import { Digits } from './BigNumber.tsx';
import { ChartBody, ChartCard } from './chartKit.tsx';
import { SortTh, TableScroll } from './DataTable.tsx';

function ProjectsGrid({ data, selected, sort, onSort, onPick, stale }: { data: Projects; selected: readonly string[]; sort: SortState<ProjectKey>; onSort: (k: ProjectKey) => void; onPick: (key: string) => void; stale: boolean }) {
  const rows = sortRows<ProjectRow>(data.rows, (r) => projectValue(r, sort.key), sort.dir);
  const tz = data.range.tz;
  return (
    <TableScroll label="Projects table" tall>
      <table className="dt dt--projects" data-table="projects" data-stale={stale ? 'true' : undefined}>
        <caption className="sr-only">Sessions, messages, tokens and API price equivalent per project in the selected range. Choosing a row filters the whole page to that project. Column headers sort the table.</caption>
        <thead>
          <tr>
            {PROJECT_COLUMNS.map((c) => (
              <SortTh key={c.key} label={c.label} numeric={c.numeric} sorted={sort.key === c.key ? sort.dir : null} onSort={() => onSort(c.key)} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const on = selected.length === 1 && selected[0] === r.projectKey;
            return (
              <tr key={r.projectKey} className="dt__pick" data-project={r.projectKey} data-selected={on ? 'true' : undefined} onClick={() => onPick(r.projectKey)}>
                <th scope="row" className="dt__name">
                  <button type="button" className="rowbtn" aria-pressed={on} title={r.projectDir === '' ? undefined : r.projectDir}>
                    <span className="rowbtn__name">{r.displayName}</span>
                    {on && <span className="rowbtn__on">Filtering</span>}
                  </button>
                  {r.aliases.length > 0 && <span className="dt__sub">Also seen as {r.aliases.join(', ')}</span>}
                </th>
                <td className="num dt__num" data-value={r.sessions}>
                  <Digits text={full(r.sessions)} />
                </td>
                <td className="num dt__num" data-value={r.messages}>
                  <Digits text={full(r.messages)} />
                </td>
                <td className="num dt__num" data-value={r.tokens}>
                  <Digits text={full(r.tokens)} />
                </td>
                <td className="num dt__num dt__cost" data-value={r.costUsd} title={usdExact(r.costUsd)}>
                  <Digits text={usd(r.costUsd)} />
                </td>
                <td className="num dt__num dt__when" data-value={r.lastActiveTs ?? 0}>
                  {r.lastActiveTs === null ? <span className="dt__none">No activity</span> : dateTimeText(r.lastActiveTs, tz)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

interface Props {
  query: string;
  filters: FilterState;
  onChange: (next: FilterState) => void;
}

export function ProjectsTable({ query, filters, onChange }: Props) {
  const api = useApi<Projects>('/api/projects', query);
  const [sort, setSort] = useState<SortState<ProjectKey>>({ key: 'tokens', dir: 'desc' });
  const click = (k: ProjectKey): void => {
    const natural = PROJECT_COLUMNS.find((c) => c.key === k)?.natural ?? 'desc';
    setSort((s) => nextSort(s, k, natural));
  };
  const count = api.data?.rows.length ?? 0;
  return (
    <ChartCard
      id="projects"
      title="Projects"
      sub={api.data === null ? 'Choose a row to filter the whole page' : `${plural(count, 'project')}. Choose a row to filter the whole page, choose it again to clear.`}
      table={null}
    >
      <ChartBody api={api} height={200} isEmpty={(d) => (d.rows.length === 0 ? 'No project activity in this range with these filters.' : null)}>
        {(data, stale) => <ProjectsGrid data={data} selected={filters.projects} sort={sort} onSort={click} onPick={(key) => onChange({ ...filters, projects: toggleProject(filters.projects, key) })} stale={stale} />}
      </ChartBody>
    </ChartCard>
  );
}
