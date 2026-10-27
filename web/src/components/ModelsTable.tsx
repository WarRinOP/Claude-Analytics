// Models table: one row per model from /api/models (transcripts only), sortable, with the share of the total as a small bar
// beside the number. Background calls (models that only appear in a session's cost record) are a separate, labelled group
// that appears when the toggle in the head is on; the toggle is `includeBackground` in the address.
import { useState } from 'react';
import type { Models, Summary } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import { modelSlot, slotColor } from '../lib/chartData.ts';
import type { FilterState } from '../lib/filters.ts';
import { dayLong, full, percent, plural, usd, usdExact } from '../lib/format.ts';
import { MODEL_COLUMNS, modelTotals, modelValue, nextSort, sortRows, type ModelKey, type ModelRow, type SortState } from '../lib/tables.ts';
import { Digits } from './BigNumber.tsx';
import { ChartBody, ChartCard } from './chartKit.tsx';
import { SortTh, Swatch, TableScroll } from './DataTable.tsx';

const BACKGROUND_LABEL = "Background calls (from Claude Code's session cost record)";
const COLS = MODEL_COLUMNS.length;

// A dollar amount, with the exact value as the tooltip and in the data attribute so the cell can be checked against the API.
function Money({ value }: { value: number }) {
  return (
    <td className="num dt__num dt__cost" data-value={value} title={usdExact(value)}>
      <Digits text={usd(value)} />
    </td>
  );
}

// A model that is not in the price table has no cost, which is not the same as a cost of zero.
function NoPrice() {
  return (
    <td className="dt__num dt__nopr" data-value="" data-priced="false">
      <span className="dt__nopr-t">No price</span>
      <span className="sr-only"> listed for this model, so its cost is unknown</span>
    </td>
  );
}

function Num({ value }: { value: number }) {
  return (
    <td className="num dt__num" data-value={value}>
      <Digits text={full(value)} />
    </td>
  );
}

function Star() {
  return (
    <svg className="fav__star" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M6 .9 7.5 4.3l3.7.3-2.8 2.4.9 3.6L6 8.7 2.7 10.6l.9-3.6L.8 4.6l3.7-.3z" fill="currentColor" />
    </svg>
  );
}

function ShareCell({ share, color, kind }: { share: number; color: string; kind?: string }) {
  return (
    <td className="dt__num dt__share" data-value={share} data-share={kind}>
      <span className="share">
        <span className="share__track" aria-hidden="true">
          <span className="share__bar" style={{ width: `${Math.max(share > 0 ? 1.5 : 0, share * 100)}%`, background: color }} />
        </span>
        <span className="num share__n">{percent(share)}</span>
      </span>
    </td>
  );
}

function ModelsGrid({ data, allModels, sort, onSort, stale }: { data: Models; allModels: string[]; sort: SortState<ModelKey>; onSort: (k: ModelKey) => void; stale: boolean }) {
  const rows = sortRows<ModelRow>(data.rows, (r) => modelValue(r, sort.key), sort.dir);
  const totals = modelTotals(data.rows);
  const colorOf = (m: string): string => slotColor(modelSlot(m, allModels));
  const bg = data.background;
  return (
    <TableScroll label="Models table">
      <table className="dt dt--models" data-table="models" data-stale={stale ? 'true' : undefined}>
        <caption className="sr-only">Tokens, responses and API price equivalent per model in the selected range. Column headers sort the table.</caption>
        <thead>
          <tr>
            {MODEL_COLUMNS.map((c) => (
              <SortTh
                key={c.key}
                label={c.label}
                numeric={c.numeric}
                sorted={sort.key === c.key ? sort.dir : null}
                onSort={() => onSort(c.key)}
              />
            ))}
          </tr>
        </thead>
        <tbody data-group="models">
          {rows.map((r) => (
            <tr key={r.model} data-model={r.model} data-favorite={r.favorite ? 'true' : undefined}>
              <th scope="row" className="dt__name">
                <span className="dt__model">
                  <Swatch color={colorOf(r.model)} />
                  <span className="dt__modelname">{r.model}</span>
                  {r.favorite && (
                    <span className="fav" title="Favorite model: the most tokens in this range.">
                      <Star />
                      <span>Favorite</span>
                    </span>
                  )}
                </span>
              </th>
              <Num value={r.responses} />
              <Num value={r.input} />
              <Num value={r.output} />
              <Num value={r.cacheWrite} />
              <Num value={r.cacheRead} />
              <Num value={r.total} />
              <ShareCell share={r.share} color={colorOf(r.model)} />
              {r.costUsd === null ? (
                <>
                  <NoPrice />
                  <td className="dt__num dt__na" data-share="cost">
                    <span className="sr-only">No share, the model has no price</span>
                  </td>
                </>
              ) : (
                <>
                  <Money value={r.costUsd} />
                  <ShareCell share={r.costShare} color={colorOf(r.model)} kind="cost" />
                </>
              )}
            </tr>
          ))}
          {data.rows.length > 0 && (
            <tr data-total="models" className="dt__total">
              <th scope="row" className="dt__name">
                All models
              </th>
              <Num value={totals.responses} />
              <Num value={totals.input} />
              <Num value={totals.output} />
              <Num value={totals.cacheWrite} />
              <Num value={totals.cacheRead} />
              <Num value={totals.total} />
              <td className="dt__num dt__share" data-value={1}>
                <span className="share">
                  <span className="share__track share__track--none" aria-hidden="true" />
                  <span className="num share__n">100%</span>
                </span>
              </td>
              <Money value={totals.cost} />
              <td className="dt__num dt__share" data-value={totals.cost > 0 ? 1 : 0} data-share="cost">
                <span className="share">
                  <span className="share__track share__track--none" aria-hidden="true" />
                  <span className="num share__n">{totals.cost > 0 ? '100%' : '0%'}</span>
                </span>
              </td>
            </tr>
          )}
        </tbody>
        {bg.length > 0 && (
          <tbody data-group="background" className="dt__bg">
            <tr className="dt__group">
              <th scope="rowgroup" colSpan={COLS}>
                <span className="dt__grouptitle">{BACKGROUND_LABEL}</span>
                <span className="dt__groupnote">Read from each session's last cost snapshot, with Claude Code's own cost for them. Not part of the totals above.</span>
              </th>
            </tr>
            {bg.map((r) => (
              <tr key={r.model} data-background-model={r.model}>
                <th scope="row" className="dt__name">
                  <span className="dt__model">
                    <Swatch color={colorOf(r.model)} />
                    <span className="dt__modelname">{r.model}</span>
                  </span>
                  <span className="dt__sub">{plural(r.sessions, 'session')}</span>
                </th>
                <td className="dt__num dt__na">
                  <span className="sr-only">Not recorded for background calls</span>
                </td>
                <Num value={r.input} />
                <Num value={r.output} />
                <Num value={r.cacheWrite} />
                <Num value={r.cacheRead} />
                <Num value={r.total} />
                <td className="dt__num dt__na">
                  <span className="sr-only">Not counted in shares</span>
                </td>
                <Money value={r.costUsd} />
                <td className="dt__num dt__na">
                  <span className="sr-only">Not counted in shares</span>
                </td>
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </TableScroll>
  );
}

interface Props {
  query: string;
  filters: FilterState;
  allModels: string[] | null;
  onChange: (next: FilterState) => void;
}

export function ModelsTable({ query, filters, allModels, onChange }: Props) {
  const api = useApi<Models>('/api/models', query);
  const summary = useApi<Summary>('/api/summary', query); // the same request the key figures make: it carries the price table date
  const [sort, setSort] = useState<SortState<ModelKey>>({ key: 'total', dir: 'desc' });
  const click = (k: ModelKey): void => {
    const natural = MODEL_COLUMNS.find((c) => c.key === k)?.natural ?? 'desc';
    setSort((s) => nextSort(s, k, natural));
  };
  const toggle = (
    <label className="chk chk--tool">
      <input type="checkbox" checked={filters.includeBackground} onChange={(e) => onChange({ ...filters, includeBackground: e.target.checked })} data-testid="models-background" />
      Show background calls
    </label>
  );
  return (
    <ChartCard id="models" title="Models" sub="Responses, tokens and API price equivalent per model, counted from the transcripts" tools={toggle} table={null}>
      <ChartBody api={api} height={190} isEmpty={(d) => (d.rows.length === 0 && d.background.length === 0 ? 'No model activity in this range with these filters.' : null)}>
        {(data, stale) => <ModelsGrid data={data} allModels={allModels ?? []} sort={sort} onSort={click} stale={stale} />}
      </ChartBody>
      <p className="tnote tnote--quiet" id="models-cost-note" data-note="cost">
        Cost is the API price equivalent{summary.data === null ? '' : ` at list API prices of ${dayLong(summary.data.cost.priceTableDate)}`}. Not what you paid. A model without a listed price shows No price and adds nothing to the total.
      </p>
      {!filters.includeBackground && (
        <p className="tnote tnote--quiet" id="models-bg-note">
          Background calls, such as session titles, are not counted here. Turn them on above to list them apart from these rows.
        </p>
      )}
    </ChartCard>
  );
}

