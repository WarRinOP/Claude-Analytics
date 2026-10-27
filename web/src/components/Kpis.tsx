// The four KPI cards. With `data` null every value is a skeleton block of the same size, so the layout never moves when
// the numbers arrive.
import type { Summary } from '../../../src/api/types.ts';
import { dayLong, full, plural, tokenWords, usd, usdCompact, usdExact } from '../lib/format.ts';
import { BigNumber, Digits } from './BigNumber.tsx';
import { TokenMeter } from './TokenMeter.tsx';

function FigSkel() {
  return <span className="skel skel--fig" aria-hidden="true" />;
}

// A plain average with one decimal, or 0 when there is nothing to divide by. Both parts come from /api/summary.
const ratio = (n: number, per: number): string => (per > 0 ? (n / per).toFixed(1) : '0');

// A dollar average over a count, or $0.00 when there is nothing to divide by. Both parts come from /api/summary; the
// background part of the total is left out because the counts do not include it.
const dollarsPer = (s: Summary, per: number): string => (per > 0 ? usd((s.cost.usd - (s.cost.backgroundUsd ?? 0)) / per) : usd(0));

function CostCard({ data }: { data: Summary | null }) {
  const c = data?.cost ?? null;
  return (
    <article className="card card--cost" aria-labelledby="k-cost">
      <h3 className="card__label" id="k-cost">
        API price equivalent
      </h3>
      <p className="card__fig">
        {c === null ? (
          <FigSkel />
        ) : (
          <BigNumber value={c.usd} kpi="cost" shown={usd(c.usd)} short={usdCompact(c.usd)} exact={usdExact(c.usd)} data={{ 'data-usd': c.usd.toFixed(6) }} />
        )}
      </p>
      <p className="card__cap" data-kpi="cost.caveat">
        {c === null ? <span className="skel skel--line skel--w70" aria-hidden="true" /> : `At list API prices of ${dayLong(c.priceTableDate)}. Not what you paid.`}
      </p>
      <dl className="rows">
        <div>
          <dt>Per active day</dt>
          <dd data-kpi="costPerDay">{data === null ? <span className="skel skel--line skel--w40" aria-hidden="true" /> : dollarsPer(data, data.activeDays)}</dd>
        </div>
        <div>
          <dt>Per session</dt>
          <dd data-kpi="costPerSession">{data === null ? <span className="skel skel--line skel--w40" aria-hidden="true" /> : dollarsPer(data, data.sessions)}</dd>
        </div>
      </dl>
      {c !== null && c.unpricedResponses > 0 && (
        <p className="card__note card__note--flag" data-kpi="cost.unpriced" data-count={c.unpricedResponses}>
          {plural(c.unpricedResponses, 'response')} used a model without a listed price and add nothing here, so the total is a floor.
        </p>
      )}
      {c !== null && c.backgroundUsd !== null && (
        <p className="card__note" data-kpi="cost.background">
          Includes <span className="num">{usd(c.backgroundUsd)}</span> from background calls, as Claude Code recorded it.
        </p>
      )}
    </article>
  );
}

export function Kpis({ data }: { data: Summary | null }) {
  const days = data?.range.days ?? 0;
  const active = data?.activeDays ?? 0;
  return (
    <div className="kpis">
      <article className="card card--sessions" aria-labelledby="k-sessions">
        <h3 className="card__label" id="k-sessions">
          Sessions
        </h3>
        <p className="card__fig">{data === null ? <FigSkel /> : <BigNumber value={data.sessions} kpi="sessions" />}</p>
        <p className="card__cap">with a prompt or response in range</p>
        <dl className="rows">
          <div>
            <dt>Per active day</dt>
            <dd data-kpi="sessionsPerDay">{data === null ? <span className="skel skel--line skel--w40" aria-hidden="true" /> : ratio(data.sessions, data.activeDays)}</dd>
          </div>
          <div>
            <dt>Messages per session</dt>
            <dd data-kpi="messagesPerSession">{data === null ? <span className="skel skel--line skel--w40" aria-hidden="true" /> : ratio(data.messages, data.sessions)}</dd>
          </div>
        </dl>
      </article>

      <article className="card card--messages" aria-labelledby="k-messages">
        <h3 className="card__label" id="k-messages">
          Messages
        </h3>
        <p className="card__fig">{data === null ? <FigSkel /> : <BigNumber value={data.messages} kpi="messages" />}</p>
        <p className="card__cap">prompts you sent plus responses Claude gave</p>
        <dl className="rows">
          <div>
            <dt>Prompts</dt>
            <dd data-kpi="prompts" data-full={data === null ? undefined : full(data.prompts)}>
              {data === null ? <span className="skel skel--line skel--w60" aria-hidden="true" /> : <Digits text={full(data.prompts)} />}
            </dd>
          </div>
          <div>
            <dt>Responses</dt>
            <dd data-kpi="responses" data-full={data === null ? undefined : full(data.responses)}>
              {data === null ? <span className="skel skel--line skel--w60" aria-hidden="true" /> : <Digits text={full(data.responses)} />}
            </dd>
          </div>
        </dl>
      </article>

      <article className="card card--days" aria-labelledby="k-days">
        <h3 className="card__label" id="k-days">
          Active days
        </h3>
        <p className="card__fig">
          {data === null ? (
            <FigSkel />
          ) : (
            <>
              <span aria-hidden="true">
                <BigNumber value={active} kpi="activeDays" />
                <span className="fig__of">
                  {' / '}
                  <span data-kpi="days" data-full={full(days)}>
                    {full(days)}
                  </span>
                </span>
              </span>
              <span className="sr-only">
                {full(active)} of {plural(days, 'day')}
              </span>
            </>
          )}
        </p>
        <p className="card__cap">days with a prompt or response, of the days in range</p>
        {data === null ? (
          <div className="bar skel" aria-hidden="true" />
        ) : (
          <div className="bar" role="meter" aria-label="Active days" aria-valuemin={0} aria-valuemax={days} aria-valuenow={active}>
            <span className="bar__fill" style={{ width: `${days > 0 ? (active / days) * 100 : 0}%` }} />
          </div>
        )}
      </article>

      <CostCard data={data} />

      <article className="card card--tokens" aria-labelledby="k-tokens">
        <h3 className="card__label" id="k-tokens">
          Tokens
        </h3>
        <p className="card__fig">{data === null ? <FigSkel /> : <BigNumber value={data.tokens.total} kpi="tokens" />}</p>
        {data === null ? (
          <p className="card__words">
            <span className="skel skel--line skel--w40" aria-hidden="true" />
          </p>
        ) : (
          tokenWords(data.tokens.total) !== null && (
            <p className="card__words" data-kpi="tokens.words">
              {tokenWords(data.tokens.total)}
            </p>
          )
        )}
        <p className="card__cap">input, output, cache write and cache read, each counted once per response</p>
        <TokenMeter tokens={data?.tokens ?? null} background={data?.backgroundTokens ?? null} />
      </article>
    </div>
  );
}
