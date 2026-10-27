// Usage breakdown ledger: tokens and API price equivalent by month, week or day. A month or week opens into
// its days, and every row opens into per model lines. Real table with one row group per period; the first column holds the
// disclosure buttons and stays in view when the table scrolls sideways inside its own frame.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Breakdown, BreakdownModelRow, BreakdownPeriod, BreakdownRow, BreakdownTotals } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import {
  ALL_COLUMNS,
  COLUMNS,
  PERIODS,
  SORTS,
  arrange,
  collapseAll,
  columnValue,
  defaultOpen,
  expandAll,
  isAllClosed,
  isAllOpen,
  isSort,
  ledgerSlice,
  modelLines,
  rowId,
  saveColumns,
  savedColumns,
  shortModel,
  shownCount,
  toggled,
  topLevel,
  visibleRowCount,
  type ColumnKey,
  type Open,
  type SortId,
} from '../lib/breakdown.ts';
import { modelSlot, slotColor } from '../lib/chartData.ts';
import { PARTIAL_LABEL, PARTIAL_TIP, PARTIAL_TIP_RUN } from '../lib/coverage.ts';
import { chartQuery } from '../lib/filters.ts';
import { dayLong, full, plural, usd, usdExact } from '../lib/format.ts';
import { Digits } from './BigNumber.tsx';
import { ChartBody, ChartCard } from './chartKit.tsx';
import { Swatch, TableScroll } from './DataTable.tsx';

// ---- small pieces -----------------------------------------------------------------------------------------------------------

function Caret() {
  return (
    <svg className="lg__caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M4 2.2 8.2 6 4 9.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The dot stipple of possibly incomplete days, with the words for assistive technology.
function PartialMark({ run = false }: { run?: boolean }) {
  return (
    <span className="lg__partial" title={run ? PARTIAL_TIP_RUN : PARTIAL_TIP} data-mark="partial">
      <span className="mark__dots" aria-hidden="true" />
      <span className="sr-only">{PARTIAL_LABEL}</span>
    </span>
  );
}

function ModelList({ models, allModels }: { models: { model: string }[]; allModels: string[] }) {
  return (
    <ul className="lg__mlist">
      {models.map((m) => (
        <li key={m.model} title={m.model}>
          <Swatch color={slotColor(modelSlot(m.model, allModels))} />
          <span className="lg__mname">{shortModel(m.model)}</span>
        </li>
      ))}
    </ul>
  );
}

function Num({ col, value, text }: { col: ColumnKey; value: number; text?: string }) {
  return (
    <td className="num lg__n" data-col={col} data-value={value}>
      <Digits text={text ?? full(value)} />
    </td>
  );
}

// Cost cell. A line for a model that is not in the price table has no cost, which is not the same as a cost of zero. A row that
// mixes priced and unpriced models shows the priced total and says how many events it leaves out.
function CostCell({ t, line }: { t: BreakdownTotals; line: boolean }) {
  if (line && t.unpriced > 0 && t.costUsd === 0) {
    return (
      <td className="lg__n dt__nopr" data-col="cost" data-value="" data-priced="false">
        <span className="dt__nopr-t">No price</span>
        <span className="sr-only"> listed for this model, so its cost is unknown</span>
      </td>
    );
  }
  return (
    <td className="num lg__n lg__cost" data-col="cost" data-value={t.costUsd} title={usdExact(t.costUsd)}>
      <Digits text={usd(t.costUsd)} />
      {t.unpriced > 0 && (
        <span className="lg__np" data-unpriced={t.unpriced}>
          <span aria-hidden="true">+{full(t.unpriced)} no price</span>
          <span className="sr-only">, not counting {plural(t.unpriced, 'event')} without a listed price</span>
        </span>
      )}
    </td>
  );
}

function NumberCells({ t, columns, line = false }: { t: BreakdownTotals; columns: readonly ColumnKey[]; line?: boolean }) {
  return (
    <>
      {columns.map((c) => (c === 'cost' ? <CostCell key={c} t={t} line={line} /> : <Num key={c} col={c} value={columnValue(t, c)} />))}
    </>
  );
}

// ---- rows -------------------------------------------------------------------------------------------------------------------

interface LedgerCtx {
  columns: readonly ColumnKey[];
  allModels: string[];
  sort: SortId;
  open: Open;
  onDays: (key: string) => void;
  onModels: (id: string) => void;
}

const modelsText = (n: number): string => (n === 1 ? 'model' : 'models');

function ModelLine({ m, index, columns, allModels, depth, parent }: { m: BreakdownModelRow; index: number; columns: readonly ColumnKey[]; allModels: string[]; depth: 1 | 2; parent: string }) {
  return (
    <tr className="lg__row lg__row--model" data-row="model" data-depth={depth} data-model={m.model} id={`${parent}-m${index}`}>
      <th scope="row" className="lg__name">
        <div className="lg__cell">
          <Swatch color={slotColor(modelSlot(m.model, allModels))} />
          <span className="lg__mfull" title={m.model}>
            <span className="sr-only">Model </span>
            {m.model}
          </span>
        </div>
      </th>
      <td className="lg__models" aria-hidden="true" />
      <NumberCells t={m} columns={columns} line />
    </tr>
  );
}

interface RowProps {
  row: BreakdownRow;
  level: 'period' | 'day';
  depth: 0 | 1;
  ctx: LedgerCtx;
}

// A period row or a day row, with its per model lines when open. Days of a month or week are drawn by the caller, as groups of
// their own, right after this group.
function Group({ row, level, depth, ctx }: RowProps) {
  const { open, columns, allModels } = ctx;
  const id = `lg-${level === 'period' ? 'p' : 'd'}-${row.key}`;
  const mid = rowId(level, row.key);
  const hasDays = level === 'period' && row.days.length > 0;
  const daysOpen = hasDays && open.days.has(row.key);
  const modelsOpen = open.models.has(mid);
  const dayIds = hasDays ? row.days.map((d) => `lg-d-${d.key}`).join(' ') : undefined;
  const modelIds = row.models.map((_, i) => `${id}-m${i}`).join(' ');
  const n = row.models.length;
  return (
    <tbody
      className="lg__grp"
      id={id}
      data-group={level}
      data-key={row.key}
      data-depth={depth}
      data-partial={row.partial ? 'true' : undefined}
      data-days-open={hasDays ? String(daysOpen) : undefined}
      data-models-open={String(modelsOpen)}
    >
      <tr className={`lg__row lg__row--${level}`} data-row={level} data-depth={depth} data-key={row.key}>
        <th scope="row" className="lg__name">
          <div className="lg__cell">
            {hasDays ? (
              <button type="button" className="lg__days" aria-expanded={daysOpen} aria-controls={dayIds} onClick={() => ctx.onDays(row.key)} data-toggle="days">
                <Caret />
                <span className="lg__label">{row.label}</span>
                <span className="sr-only">, days</span>
              </button>
            ) : (
              <span className="lg__label lg__label--plain">{row.label}</span>
            )}
            {row.partial && <PartialMark />}
            <button
              type="button"
              className="lg__mods"
              aria-expanded={modelsOpen}
              aria-controls={modelIds === '' ? undefined : modelIds}
              onClick={() => ctx.onModels(mid)}
              data-toggle="models"
              data-n={n}
            >
              <Caret />
              <span className="num lg__mn">{n}</span>
              <span className="lg__mw"> {modelsText(n)}</span>
              <span className="sr-only"> for {row.label}</span>
            </button>
          </div>
        </th>
        <td className="lg__models">
          <ModelList models={row.models} allModels={allModels} />
        </td>
        <NumberCells t={row.totals} columns={columns} />
      </tr>
      {modelsOpen &&
        modelLines(row.models, ctx.sort).map((m) => (
          <ModelLine key={m.model} m={m} index={row.models.indexOf(m)} columns={columns} allModels={allModels} depth={(depth + 1) as 1 | 2} parent={id} />
        ))}
    </tbody>
  );
}

// ---- the table --------------------------------------------------------------------------------------------------------------

function Ledger({ data, rows, ctx, shown, stale }: { data: Breakdown; rows: BreakdownRow[]; ctx: LedgerCtx; shown: number; stale: boolean }) {
  const { columns, allModels } = ctx;
  const period = data.period;
  const level = topLevel(period);
  const allModelsInRange = useMemo(() => {
    const sums = new Map<string, number>();
    for (const r of data.rows) for (const m of r.models) sums.set(m.model, (sums.get(m.model) ?? 0) + m.total);
    return [...sums.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([model]) => ({ model }));
  }, [data.rows]);
  return (
    <TableScroll label="Usage breakdown table" className="tscroll--ledger">
      <table className="lg" data-table="breakdown" data-period={period} data-stale={stale ? 'true' : undefined}>
        <caption className="sr-only">
          Usage and API price equivalent by {PERIODS.find((p) => p.id === period)?.noun}, newest first unless sorted otherwise. Open a row for its{' '}
          {period === 'day' ? 'per model lines' : 'days'} and a model button for its per model lines.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="lg__th lg__th--name">
              Period
            </th>
            <th scope="col" className="lg__th">
              Models
            </th>
            {COLUMNS.filter((c) => columns.includes(c.key)).map((c) => (
              <th scope="col" key={c.key} className="lg__th lg__th--num" data-col={c.key}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="lg__grp lg__totals" data-group="totals">
          <tr className="lg__row lg__row--total" data-row="total">
            <th scope="row" className="lg__name">
              <div className="lg__cell lg__cell--total">
                <span className="lg__label lg__label--plain">Total</span>
                <span className="lg__range">
                  {dayLong(data.range.from)} to {dayLong(data.range.to)}
                </span>
              </div>
            </th>
            <td className="lg__models">
              <ModelList models={allModelsInRange} allModels={allModels} />
            </td>
            <NumberCells t={data.totals} columns={columns} />
          </tr>
        </tbody>
        {rows.slice(0, shown).map((r) => (
          <GroupWithDays key={`${level}-${r.key}`} row={r} level={level} ctx={ctx} />
        ))}
      </table>
    </TableScroll>
  );
}

// A top row and, when its days are open, one group per day right after it.
function GroupWithDays({ row, level, ctx }: { row: BreakdownRow; level: 'period' | 'day'; ctx: LedgerCtx }) {
  const daysOpen = level === 'period' && row.days.length > 0 && ctx.open.days.has(row.key);
  return (
    <>
      <Group row={row} level={level} depth={0} ctx={ctx} />
      {daysOpen && row.days.map((d) => <Group key={`d-${d.key}`} row={d} level="day" depth={1} ctx={ctx} />)}
    </>
  );
}

// ---- controls ---------------------------------------------------------------------------------------------------------------

function PeriodSwitch({ period, onPeriod }: { period: BreakdownPeriod; onPeriod: (p: BreakdownPeriod) => void }) {
  return (
    <div className="seg seg--quiet lg__switch" role="group" aria-label="Group the breakdown by">
      {PERIODS.map((p) => (
        <button key={p.id} type="button" className="seg__btn" aria-pressed={period === p.id} data-period={p.id} onClick={() => onPeriod(p.id)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

// Which numeric columns are shown. Not a modal: Tab moves through it and out of it, Escape closes it and returns focus to the
// button, a click outside closes it.
function ColumnPicker({ columns, onChange }: { columns: readonly ColumnKey[]; onChange: (next: ColumnKey[]) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  const panelId = useId();

  // Opens to the right of its button; when that would leave the window it opens to the left instead.
  useLayoutEffect(() => {
    const el = pop.current;
    setFlip(open && el !== null && el.getBoundingClientRect().right > window.innerWidth - 8);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const toggle = (k: ColumnKey): void => onChange(ALL_COLUMNS.filter((c) => (c === k ? !columns.includes(c) : columns.includes(c))));

  return (
    <div
      className="ms lg__cols"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
      onBlur={(e) => {
        if (open && root.current !== null && !root.current.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button ref={button} type="button" className="ms__btn" aria-expanded={open} aria-controls={open ? panelId : undefined} data-active={columns.length < ALL_COLUMNS.length ? 'true' : undefined} data-testid="breakdown-columns" onClick={() => setOpen((o) => !o)}>
        <span className="ms__name">Columns</span>
        <span className="ms__value">
          {columns.length} of {ALL_COLUMNS.length}
        </span>
        <svg className="ms__chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div ref={pop} className={flip ? 'ms__pop ms__pop--end lg__colpop' : 'ms__pop lg__colpop'} id={panelId} role="group" aria-label="Columns shown in the breakdown">
          <ul className="ms__list">
            {COLUMNS.map((c) => (
              <li key={c.key}>
                <label className="ms__item">
                  <input type="checkbox" checked={columns.includes(c.key)} onChange={() => toggle(c.key)} data-col={c.key} />
                  <span className="ms__text">
                    <span className="ms__label">{c.label}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="ms__foot">
            <p className="lg__colnote">Period and Models are always shown.</p>
            <button type="button" className="linkbtn" disabled={columns.length === ALL_COLUMNS.length} onClick={() => onChange(ALL_COLUMNS)}>
              Show all columns
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- the section ------------------------------------------------------------------------------------------------------------

// The height of the placeholder while the first answer loads: about a month open to its days, so the page below does not jump far.
const SKELETON_HEIGHT = 600;

interface Props {
  query: string; // the data slice of the page (range, models, projects, subagents)
  period: BreakdownPeriod;
  onPeriod: (p: BreakdownPeriod) => void;
  allModels: string[] | null;
  // The ledger is the heaviest answer and sits below the first screen, so it asks once the key figures have answered: the
  // browser keeps only a few requests going at a time, and the first screen's panels go first.
  ready: boolean;
}

export function UsageBreakdown({ query, period, onPeriod, allModels, ready }: Props) {
  const requested = chartQuery(ledgerSlice(query), { period });
  const api = useApi<Breakdown>('/api/breakdown', requested, ready);
  const [sort, setSort] = useState<SortId>('newest');
  const [columns, setColumns] = useState<ColumnKey[]>(savedColumns);
  const [overrides, setOverrides] = useState<Partial<Record<BreakdownPeriod, Open>>>({});
  // The pages of rows drawn belong to one request: another range, filter or period starts again at the first page.
  const [paged, setPaged] = useState<{ key: string; pages: number }>({ key: requested, pages: 1 });
  const pages = paged.key === requested ? paged.pages : 1;
  const data = api.data;

  const csvHref = `/api/breakdown.csv?${requested}`;

  const rows = useMemo(() => (data === null ? [] : arrange(data.rows, sort)), [data, sort]);
  // The answer on screen may belong to the previous period while the new one loads: draw it as it is, keyed by its own period.
  const shownPeriod = data?.period ?? period;
  const open: Open = overrides[shownPeriod] ?? (data === null ? collapseAll() : defaultOpen(data.rows, shownPeriod));
  const setOpen = (fn: (o: Open) => Open): void => {
    if (data === null) return;
    setOverrides((prev) => ({ ...prev, [shownPeriod]: fn(prev[shownPeriod] ?? defaultOpen(data.rows, shownPeriod)) }));
  };

  const ctx: LedgerCtx = {
    columns,
    allModels: allModels ?? [],
    sort,
    open,
    onDays: (key) => setOpen((o) => ({ ...o, days: toggled(o.days, key) })),
    onModels: (id) => setOpen((o) => ({ ...o, models: toggled(o.models, id) })),
  };

  const allOpen = data !== null && data.rows.length > 0 && isAllOpen(data.rows, shownPeriod, open);
  const allClosed = isAllClosed(open);
  const shown = data === null ? 0 : shownCount(rows, shownPeriod, open, pages);
  const noun = PERIODS.find((p) => p.id === shownPeriod)?.noun ?? 'period';
  const anyPartial = data !== null && data.rows.some((r) => r.partial || r.days.some((d) => d.partial));

  const changeColumns = (next: ColumnKey[]): void => {
    setColumns(next);
    saveColumns(next);
  };

  const controls = (
    <div className="lg__bar" data-bar="breakdown">
      <PeriodSwitch period={period} onPeriod={onPeriod} />
      <div className="lg__tools">
        <button type="button" className="btn lg__btn" aria-disabled={data === null || allOpen} onClick={() => data !== null && !allOpen && setOpen(() => expandAll(data.rows, shownPeriod))} data-testid="breakdown-expand">
          Expand all
        </button>
        <button type="button" className="btn lg__btn" aria-disabled={data === null || allClosed} onClick={() => !allClosed && setOpen(() => collapseAll())} data-testid="breakdown-collapse">
          Collapse all
        </button>
        <ColumnPicker columns={columns} onChange={changeColumns} />
        <label className="lg__sort">
          <span className="ms__name">Sort</span>
          <select className="lg__select" value={sort} onChange={(e) => isSort(e.target.value) && setSort(e.target.value)} data-testid="breakdown-sort">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <a className="btn lg__btn lg__csv" href={csvHref} download data-testid="breakdown-csv">
          Download CSV
        </a>
      </div>
    </div>
  );

  return (
    <ChartCard
      id="breakdown"
      title="Usage breakdown"
      sub="Tokens and API price equivalent by month, week or day. Open a row for its days and its models."
      table={null}
    >
      {controls}
      <ChartBody api={api} height={SKELETON_HEIGHT} isEmpty={(d) => (d.rows.length === 0 ? 'No usage in this range with these filters.' : null)}>
        {(d, stale) => (
          <>
            <Ledger data={d} rows={rows} ctx={ctx} shown={shown} stale={stale} />
            {shown < rows.length && (
              <div className="lg__more">
                <p className="lg__morecount" role="status">
                  Showing {full(shown)} of {plural(rows.length, noun)}, {full(visibleRowCount(rows, shownPeriod, open))} rows are open.
                </p>
                <button type="button" className="btn" data-testid="breakdown-more" onClick={() => setPaged({ key: requested, pages: pages + 1 })}>
                  Show more
                </button>
              </div>
            )}
            {anyPartial && (
              <p className="tnote" data-note="ledger-partial">
                <span className="tnote__key" aria-hidden="true" />
                {PARTIAL_LABEL}: Claude Code may have deleted part of these days before the archive began.
              </p>
            )}
            {d.range.coverageGap && d.range.archiveStart !== null && (
              <p className="tnote tnote--quiet" data-note="ledger-coverage">
                Days before {dayLong(d.range.archiveStart)} are not in the archive, so they are not listed.
              </p>
            )}
            <p className="tnote tnote--quiet" data-note="ledger-cost">
              Cost is the API price equivalent at list API prices of {dayLong(d.priceTableDate)}. Not what you paid. Background calls are not included.
            </p>
          </>
        )}
      </ChartBody>
    </ChartCard>
  );
}
