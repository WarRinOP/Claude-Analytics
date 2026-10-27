// Recent sessions: /api/sessions, 50 per page, newest first or by tokens or by active time (the server sorts, so the order is
// right across pages). A session whose source files are all gone is marked "kept in the archive". A session that started
// before the complete from day says it may be missing its first part.
import { useRef, useState } from 'react';
import type { Sessions } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import { modelSlot, slotColor } from '../lib/chartData.ts';
import { PARTIAL_LABEL, PARTIAL_TIP } from '../lib/coverage.ts';
import { chartQuery } from '../lib/filters.ts';
import { duration, full, plural, usd, usdExact } from '../lib/format.ts';
import { PAGE_SIZE, dateTimeText, pageCount, pageRange, shortSession, startedBeforeComplete, type SessionSort } from '../lib/tables.ts';
import { Digits } from './BigNumber.tsx';
import { ChartBody, ChartCard } from './chartKit.tsx';
import { PlainTh, SortTh, Swatch, TableScroll } from './DataTable.tsx';

const SORT_HINT: Record<SessionSort, string> = { start: 'Newest first', active: 'Most active time first', tokens: 'Most tokens first' };

export const KEPT_LABEL = 'Source deleted, kept in the archive';

function KeptMark() {
  return (
    <span className="mark mark--kept" title="Claude Code no longer has this session's transcript files. The archive still holds every count from them.">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M1.5 2.2h9v2.6h-9zM2.5 4.8v5h7v-5M4.6 7h2.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span>{KEPT_LABEL}</span>
    </span>
  );
}

function PartialMark() {
  return (
    <span className="mark mark--partial" title={PARTIAL_TIP}>
      <span className="mark__dots" aria-hidden="true" />
      <span>{PARTIAL_LABEL}</span>
    </span>
  );
}

function SessionsGrid({ data, allModels, sort, onSort, stale }: { data: Sessions; allModels: string[]; sort: SessionSort; onSort: (s: SessionSort) => void; stale: boolean }) {
  const tz = data.range.tz;
  const completeFrom = data.range.completeFrom;
  const sorted = (key: SessionSort) => (sort === key ? ('desc' as const) : null);
  return (
    <TableScroll label="Recent sessions table">
      <table className="dt dt--sessions" data-table="sessions" data-stale={stale ? 'true' : undefined}>
        <caption className="sr-only">Sessions in the selected range, with the API price equivalent of each. Start, active time and tokens sort the table, largest first.</caption>
        <thead>
          <tr>
            <SortTh label="Start" sorted={sorted('start')} onSort={() => onSort('start')} hint={SORT_HINT.start} />
            <PlainTh label="Project" />
            <PlainTh label="Title" />
            <SortTh label="Active time" numeric sorted={sorted('active')} onSort={() => onSort('active')} hint={SORT_HINT.active} />
            <PlainTh label="Wall clock" numeric />
            <PlainTh label="Prompts" numeric />
            <PlainTh label="Responses" numeric />
            <SortTh label="Tokens" numeric sorted={sorted('tokens')} onSort={() => onSort('tokens')} hint={SORT_HINT.tokens} />
            <PlainTh label="Cost" numeric />
            <PlainTh label="Models" />
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const partial = startedBeforeComplete(r.firstTs, tz, completeFrom);
            return (
              <tr key={r.sessionId} data-session={r.sessionId} data-source-deleted={r.sourceDeleted ? 'true' : undefined} data-partial={partial ? 'true' : undefined}>
                <th scope="row" className="dt__when dt__start num" data-value={r.firstTs}>
                  {dateTimeText(r.firstTs, tz)}
                </th>
                <td className="dt__project">{r.displayName}</td>
                <td className="dt__title">
                  <span className={r.title === null ? 'dt__none' : 'dt__titletext'}>{r.title ?? 'No title stored'}</span>
                  <span className="dt__ids">
                    <span className="num dt__id" title={r.sessionId}>
                      {shortSession(r.sessionId)}
                    </span>
                    {r.hasSubagents && <span className="dt__tag">Subagents</span>}
                  </span>
                  {(r.sourceDeleted || partial) && (
                    <span className="dt__marks">
                      {r.sourceDeleted && <KeptMark />}
                      {partial && <PartialMark />}
                    </span>
                  )}
                </td>
                <td className="num dt__num" data-value={r.activeMs}>
                  {duration(r.activeMs)}
                </td>
                <td className="num dt__num" data-value={r.wallMs}>
                  {duration(r.wallMs)}
                </td>
                <td className="num dt__num" data-value={r.prompts}>
                  <Digits text={full(r.prompts)} />
                </td>
                <td className="num dt__num" data-value={r.responses}>
                  <Digits text={full(r.responses)} />
                </td>
                <td className="num dt__num" data-value={r.tokens}>
                  <Digits text={full(r.tokens)} />
                </td>
                <td className="num dt__num dt__cost" data-value={r.costUsd} title={usdExact(r.costUsd)}>
                  <Digits text={usd(r.costUsd)} />
                </td>
                <td className="dt__models">
                  {r.models.length === 0 ? (
                    <span className="dt__none">None</span>
                  ) : (
                    <ul className="mlist">
                      {r.models.map((m) => (
                        <li key={m}>
                          <Swatch color={slotColor(modelSlot(m, allModels))} />
                          <span>{m}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

interface PagerProps {
  data: Sessions;
  onPage: (page: number) => void;
  where: 'top' | 'bottom';
}

// Previous and Next stay in the tab order at the ends of the list (aria-disabled, not disabled), so focus is never lost when
// the last page is reached.
function Pager({ data, onPage, where }: PagerProps) {
  const pages = pageCount(data.total, data.pageSize);
  const { from, to } = pageRange(data.total, data.page, data.pageSize);
  const atStart = data.page <= 1;
  const atEnd = data.page >= pages;
  return (
    <nav className="pager" aria-label={`Sessions pages, ${where}`} data-pager={where}>
      <p className="pager__text" data-testid={`sessions-range-${where}`}>
        {data.total === 0 ? 'No sessions' : `Sessions ${full(from)} to ${full(to)} of ${full(data.total)}`}
      </p>
      {pages > 1 && (
        <div className="pager__ctl">
          <button type="button" className="btn pager__btn" aria-disabled={atStart} data-testid={`sessions-prev-${where}`} onClick={() => !atStart && onPage(data.page - 1)}>
            Previous
          </button>
          <span className="pager__page num" data-testid={`sessions-page-${where}`}>
            Page {data.page} of {pages}
          </span>
          <button type="button" className="btn pager__btn" aria-disabled={atEnd} data-testid={`sessions-next-${where}`} onClick={() => !atEnd && onPage(data.page + 1)}>
            Next
          </button>
        </div>
      )}
    </nav>
  );
}

interface Props {
  query: string;
  allModels: string[] | null;
}

export function SessionsTable({ query, allModels }: Props) {
  // The page belongs to one filter slice and one sort: a new slice starts again at page 1.
  const [paged, setPaged] = useState<{ query: string; sort: SessionSort; page: number }>({ query, sort: 'start', page: 1 });
  const sort = paged.sort;
  const page = paged.query === query ? paged.page : 1;
  const card = useRef<HTMLDivElement>(null);
  const api = useApi<Sessions>('/api/sessions', chartQuery(query, { page: String(page), pageSize: String(PAGE_SIZE), sort }));
  const goto = (next: number, fromBottom: boolean): void => {
    setPaged({ query, sort, page: next });
    if (fromBottom) card.current?.scrollIntoView({ block: 'start' });
  };
  const resort = (s: SessionSort): void => setPaged({ query, sort: s, page: 1 });
  const total = api.data?.total ?? null;
  return (
    <div ref={card} className="sessions-card">
      <ChartCard
        id="sessions"
        title="Recent sessions"
        sub={total === null ? 'Sessions in this range' : `${plural(total, 'session')} in this range, ${SORT_HINT[sort].toLowerCase()}`}
        tools={api.data !== null && api.data.total > api.data.pageSize ? <Pager data={api.data} onPage={(p) => goto(p, false)} where="top" /> : null}
        table={null}
      >
        <ChartBody api={api} height={420} isEmpty={(d) => (d.total === 0 ? 'No sessions in this range with these filters.' : null)}>
          {(data, stale) => (
            <>
              <SessionsGrid data={data} allModels={allModels ?? []} sort={sort} onSort={resort} stale={stale} />
              <Pager data={data} onPage={(p) => goto(p, true)} where="bottom" />
            </>
          )}
        </ChartBody>
      </ChartCard>
    </div>
  );
}
