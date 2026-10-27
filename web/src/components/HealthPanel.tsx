// Data health (anchor #health, opened by the sync pill): the same checks and wording as `cli.ts doctor`, then the facts behind
// them. Every status is a shape plus words, never a colour alone: circle OK, triangle worth a look, diamond problem.
import type { ReactNode } from 'react';
import type { Health } from '../../../src/api/types.ts';
import {
  COST_CHECK_WHY,
  CANARY_NAME,
  bytesText,
  countText,
  dayText,
  durationText,
  errorExplanation,
  healthChecks,
  overall,
  plural,
  shortId,
  stampText,
  type Verdict,
} from '../../../src/metrics/healthChecks.ts';
import { useApi } from '../lib/api.ts';
import { Disclosure } from './Disclosure.tsx';
import { TableScroll } from './DataTable.tsx';

export function VerdictShape({ verdict, size = 14 }: { verdict: Verdict; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 14 14', 'aria-hidden': true as const, focusable: 'false' as const, className: `vs vs--${verdict}` };
  if (verdict === 'ok') {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="4.5" fill="currentColor" />
      </svg>
    );
  }
  if (verdict === 'note') {
    return (
      <svg {...common}>
        <path d="M7 2 12.5 11.5h-11z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M7 1.5 12.5 7 7 12.5 1.5 7z" fill="currentColor" />
    </svg>
  );
}

function Kv({ rows, label }: { rows: Array<{ k: string; v: ReactNode; id: string }>; label: string }) {
  return (
    <dl className="kv" aria-label={label}>
      {rows.map((r) => (
        <div key={r.id} className="kv__row" data-kv={r.id}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="hp__sec" data-hp={id} aria-label={title}>
      <header className="hp__head">
        <h3 className="hp__title">{title}</h3>
        {note !== undefined && <p className="hp__note">{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Empty({ children, verdict = 'ok' }: { children: string; verdict?: Verdict }) {
  return (
    <p className="hp__none" data-empty="true">
      <VerdictShape verdict={verdict} size={12} />
      <span>{children}</span>
    </p>
  );
}

function Mini({ label, children, name }: { label: string; name: string; children: ReactNode }) {
  return (
    <TableScroll label={label}>
      <table className="dt dt--mini" data-table={name}>
        <caption className="sr-only">{label}</caption>
        {children}
      </table>
    </TableScroll>
  );
}

const th = (label: string, numeric = false) => (
  <th scope="col" className={numeric ? 'th th--num th--plain' : 'th th--plain'}>
    <span>{label}</span>
  </th>
);

function Body({ h, now }: { h: Health; now: number }) {
  const checks = healthChecks(h, { now, live: true });
  const tz = h.tz;
  const p = h.lastPass;
  const exact = (ms: number | null): string => (ms === null ? 'None yet' : stampText(ms, tz));
  return (
    <div className="hp" data-testid="health-body">
      <ul className="checks" aria-label="Health checks">
        {checks.map((c) => (
          <li key={c.id} className="checks__row" data-check={c.id} data-verdict={c.verdict}>
            <span className="checks__shape">
              <VerdictShape verdict={c.verdict} />
            </span>
            <span className="checks__name">{c.name}</span>
            <span className="checks__word">{c.word}</span>
            <p className="checks__text">{c.text}</p>
          </li>
        ))}
      </ul>

      <div className="hp__cols">
        <Section id="sync" title="Sync">
          <Kv
            label="Sync"
            rows={[
              { id: 'state', k: 'State', v: h.sync.running ? 'Reading a pass now' : 'Idle' },
              { id: 'watcher', k: 'Watcher', v: h.sync.watcherAlive ? 'Watching the transcript folder' : 'Not watching. The minute poll still runs.' },
              { id: 'last-pass', k: 'Last pass', v: <span className="num">{exact(p?.at ?? null)}</span> },
              { id: 'duration', k: 'Took', v: p === null ? 'No pass yet' : <span className="num">{durationText(p.durationMs)}</span> },
              { id: 'trigger', k: 'Started by', v: p === null ? 'No pass yet' : p.trigger },
              { id: 'files', k: 'Files', v: p === null ? 'No pass yet' : <span className="num">{`${countText(p.filesChanged)} changed of ${countText(p.filesScanned)} scanned`}</span> },
              { id: 'lines', k: 'Lines read', v: p === null ? 'No pass yet' : <span className="num">{countText(p.linesRead)}</span> },
              { id: 'last-success', k: 'Last successful sync', v: <span className="num">{exact(h.sync.lastSuccessAt)}</span> },
              { id: 'last-error', k: 'Last error', v: h.sync.lastError === null ? 'None' : h.sync.lastError },
            ]}
          />
        </Section>
        <Section id="archive" title="Archive">
          <Kv
            label="Archive"
            rows={[
              { id: 'tz', k: 'Time zone', v: <span className="num">{h.tz}</span> },
              { id: 'start', k: 'Archive starts', v: h.archiveStart === null ? 'Nothing archived yet' : <span className="num">{dayText(h.archiveStart)}</span> },
              { id: 'complete', k: 'Complete from', v: h.completeFrom === null ? 'Not known yet' : <span className="num">{dayText(h.completeFrom)}</span> },
              { id: 'retention', k: 'Retention', v: <span className="num">{plural(h.retentionDays, 'day')}</span> },
              { id: 'source', k: 'Source folder', v: <span className="num hp__path">{h.sourceRoot === '' ? 'Not known' : h.sourceRoot}</span> },
              { id: 'db', k: 'Database size', v: <span className="num">{bytesText(h.dbBytes)}</span> },
              { id: 'files', k: 'Files tracked', v: <span className="num">{`${countText(h.files.active)} active, ${countText(h.files.deleted)} deleted at the source`}</span> },
              { id: 'sessions', k: 'Sessions', v: <span className="num">{`${countText(h.sessions.total)} archived, ${countText(h.sessions.sourceDeleted)} kept after their source was deleted`}</span> },
            ]}
          />
        </Section>
      </div>

      <Section id="errors" title="Ingest errors" note={h.errors.total === 0 ? undefined : `${plural(h.errors.total, 'problem')}, newest first${h.recentErrors.length < h.errors.total ? ` (the newest ${h.recentErrors.length} are listed)` : ''}. A skipped line is never stored, only where it was.`}>
        {h.recentErrors.length === 0 ? (
          <Empty>No ingest errors. Every line and file read so far was understood.</Empty>
        ) : (
          <Mini label="Ingest errors, newest first" name="health-errors">
            <thead>
              <tr>
                {th('When')}
                {th('File')}
                {th('Line', true)}
                {th('Byte offset', true)}
                {th('What happened')}
              </tr>
            </thead>
            <tbody>
              {h.recentErrors.map((e, i) => (
                <tr key={i} data-file={e.file} data-line={e.lineNo ?? ''} data-error={e.error}>
                  <td className="num dt__when">{stampText(e.at, tz)}</td>
                  <th scope="row" className="dt__name dt__path">
                    <span className="num">{e.file}</span>
                  </th>
                  <td className="num dt__num" data-value={e.lineNo ?? ''}>
                    {e.lineNo === null ? <span className="dt__none">whole file</span> : countText(e.lineNo)}
                  </td>
                  <td className="num dt__num" data-value={e.byteOffset ?? ''}>
                    {e.byteOffset === null ? <span className="dt__none">not applicable</span> : countText(e.byteOffset)}
                  </td>
                  <td className="dt__what">
                    <span>{errorExplanation(e.error)}</span>
                    <span className="num dt__code">{e.error}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Mini>
        )}
      </Section>

      <div className="hp__cols">
        <Section id="unknown-types" title="Unknown record types" note="Lines with a type this app does not know. They are counted and otherwise ignored.">
          {h.unknownTypes.length === 0 ? (
            <Empty>None. Every record type was recognised.</Empty>
          ) : (
            <Mini label="Unknown record types by Claude Code version" name="health-unknown-types">
              <thead>
                <tr>
                  {th('Type')}
                  {th('Claude Code')}
                  {th('Lines', true)}
                  {th('Last seen')}
                </tr>
              </thead>
              <tbody>
                {h.unknownTypes.map((u) => (
                  <tr key={`${u.type}|${u.version}`} data-type={u.type} data-version={u.version}>
                    <th scope="row" className="dt__name num">
                      {u.type}
                    </th>
                    <td className="num">{u.version === '' ? <span className="dt__none">not recorded</span> : u.version}</td>
                    <td className="num dt__num" data-value={u.count}>
                      {countText(u.count)}
                    </td>
                    <td className="num dt__when">{stampText(u.lastSeenAt, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </Mini>
          )}
        </Section>
        <Section id="missing-fields" title="Missing usage fields" note="Usage counts that a line did not carry. A missing count is read as 0.">
          {h.missingFields.length === 0 ? (
            <Empty>None. Every usage line carried every field.</Empty>
          ) : (
            <Mini label="Missing usage fields by Claude Code version" name="health-missing-fields">
              <thead>
                <tr>
                  {th('Field')}
                  {th('Claude Code')}
                  {th('Lines', true)}
                </tr>
              </thead>
              <tbody>
                {h.missingFields.map((f) => (
                  <tr key={`${f.field}|${f.version}`} data-field={f.field} data-version={f.version}>
                    <th scope="row" className="dt__name num">
                      {f.field}
                    </th>
                    <td className="num">{f.version === '' ? <span className="dt__none">not recorded</span> : f.version}</td>
                    <td className="num dt__num" data-value={f.count}>
                      {countText(f.count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Mini>
          )}
        </Section>
      </div>

      <div className="hp__cols">
        <Section id="versions" title="Claude Code versions" note="Versions that wrote the archived responses.">
          {h.versions.length === 0 ? (
            <Empty>No responses archived yet.</Empty>
          ) : (
            <Mini label="Claude Code versions seen" name="health-versions">
              <thead>
                <tr>
                  {th('Version')}
                  {th('Responses', true)}
                  {th('First seen')}
                  {th('Last seen')}
                </tr>
              </thead>
              <tbody>
                {h.versions.map((v) => (
                  <tr key={v.version} data-version={v.version}>
                    <th scope="row" className="dt__name num">
                      {v.version === '' ? <span className="dt__none">not recorded</span> : v.version}
                    </th>
                    <td className="num dt__num" data-value={v.responses}>
                      {countText(v.responses)}
                    </td>
                    <td className="num dt__when">{stampText(v.firstTs, tz)}</td>
                    <td className="num dt__when">{stampText(v.lastTs, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </Mini>
          )}
        </Section>
        <div className="hp__stack">
          <Section id="entrypoints" title="Entrypoints" note="Where the responses came from.">
            {h.entrypoints.length === 0 ? (
              <Empty>No responses archived yet.</Empty>
            ) : (
              <Mini label="Entrypoints seen" name="health-entrypoints">
                <thead>
                  <tr>
                    {th('Entrypoint')}
                    {th('Responses', true)}
                  </tr>
                </thead>
                <tbody>
                  {h.entrypoints.map((e) => (
                    <tr key={e.entrypoint} data-entrypoint={e.entrypoint}>
                      <th scope="row" className="dt__name num">
                        {e.entrypoint === '' ? <span className="dt__none">not recorded</span> : e.entrypoint}
                      </th>
                      <td className="num dt__num" data-value={e.responses}>
                        {countText(e.responses)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Mini>
            )}
          </Section>
          <Section id="aliases" title="Symlink aliases" note="Project folders that are links to another project folder. They are skipped, so nothing is counted twice.">
            {h.aliases.length === 0 ? (
              <Empty>None found.</Empty>
            ) : (
              <Mini label="Symlink aliases" name="health-aliases">
                <thead>
                  <tr>
                    {th('Alias folder')}
                    {th('Points at')}
                  </tr>
                </thead>
                <tbody>
                  {h.aliases.map((a) => (
                    <tr key={a.aliasDir} data-alias={a.aliasDir}>
                      <th scope="row" className="dt__name dt__path">
                        <span className="num">{a.aliasDir}</span>
                      </th>
                      <td className="num dt__path">{a.targetDir}</td>
                    </tr>
                  ))}
                </tbody>
              </Mini>
            )}
          </Section>
        </div>
      </div>

      <Section id="cost" title="Cost record cross check" note="Claude Code's own record of each session's tokens, compared with what the transcripts add up to.">
        <p className="hp__lead" data-testid="cost-summary">
          {checks.find((c) => c.id === 'cost')?.text}
        </p>
        {h.costCheck.exceptions.length > 0 && (
          <Mini label="Sessions where the cost record and the transcripts differ most" name="health-cost">
            <thead>
              <tr>
                {th('Session')}
                {th('Transcripts', true)}
                {th('Cost record', true)}
                {th('Difference', true)}
              </tr>
            </thead>
            <tbody>
              {h.costCheck.exceptions.map((e) => (
                <tr key={e.sessionId} data-session={e.sessionId}>
                  <th scope="row" className="dt__name num" title={e.sessionId}>
                    {shortId(e.sessionId)}
                  </th>
                  <td className="num dt__num" data-value={e.ours}>
                    {countText(e.ours)}
                  </td>
                  <td className="num dt__num" data-value={e.theirs}>
                    {countText(e.theirs)}
                  </td>
                  <td className="num dt__num" data-value={e.percent}>
                    {`${e.percent >= 0 ? '+' : ''}${e.percent.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </Mini>
        )}
        <p className="hp__why" data-testid="cost-why">
          {COST_CHECK_WHY}
        </p>
      </Section>

      <Section id="prices" title="Prices" note="The table behind the API price equivalent. A model that is not in it is counted, never priced as zero.">
        <p className="hp__lead" data-testid="prices-summary">
          {checks.find((c) => c.id === 'prices')?.text}
        </p>
        <Kv
          label="Prices"
          rows={[
            { id: 'table-date', k: 'Price table dated', v: <span className="num">{dayText(h.prices.tableDate)}</span> },
            {
              id: 'unpriced-models',
              k: 'Models without a price',
              v: h.prices.unpricedModels.length === 0 ? 'None' : <span className="num">{plural(h.prices.unpricedModels.length, 'model')}</span>,
            },
            {
              id: 'remainder',
              k: 'Cache writes without a split',
              v: <span className="num">{plural(h.prices.cacheWriteRemainderEvents, 'response')}</span>,
            },
          ]}
        />
        {h.prices.unpricedModels.length > 0 && (
          <Mini label="Models without a price" name="health-unpriced">
            <thead>
              <tr>
                {th('Model')}
                {th('Responses', true)}
              </tr>
            </thead>
            <tbody>
              {h.prices.unpricedModels.map((m) => (
                <tr key={m.model} data-model={m.model}>
                  <th scope="row" className="dt__name num">
                    {m.model}
                  </th>
                  <td className="num dt__num" data-value={m.responses}>
                    {countText(m.responses)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Mini>
        )}
        <p className="hp__why" data-testid="prices-why">
          Prices are Anthropic's published list prices per million tokens. A cache write that has no 5 minute and 1 hour split is priced at the 5 minute rate. The totals are an equivalent at list prices, not what a Claude subscription charges.
        </p>
      </Section>
    </div>
  );
}

function Summary({ h, error, now }: { h: Health | null; error: boolean; now: number }) {
  if (h === null) {
    return error ? (
      <span className="hsum" data-verdict="problem">
        <VerdictShape verdict="problem" />
        <strong className="hsum__word">Not connected</strong>
        <span className="hsum__text">The ledger service is not answering.</span>
      </span>
    ) : (
      <span className="hsum">
        <span className="skel skel--line skel--w60" aria-hidden="true" />
      </span>
    );
  }
  const checks = healthChecks(h, { now, live: true });
  const head = overall(h, checks);
  const looks = checks.filter((c) => c.verdict !== 'ok').map((c) => (c.id === 'canary' && c.verdict === 'problem' ? CANARY_NAME : c.name));
  return (
    <span className="hsum" data-verdict={head.verdict} data-testid="health-summary">
      <VerdictShape verdict={head.verdict} />
      <strong className="hsum__word">{head.word}</strong>
      <span className="hsum__text">{looks.length === 0 ? `Last pass ${h.lastPass === null ? 'not yet' : stampText(h.lastPass.at, h.tz)}` : looks.join(', ')}</span>
    </span>
  );
}

export function HealthPanel() {
  const api = useApi<Health>('/api/health', '');
  const now = Date.now();
  return (
    <Disclosure id="health" title="Data health" summary={<Summary h={api.data} error={api.error !== null} now={now} />}>
      {api.data === null ? (
        api.error !== null ? (
          <div className="chart__fail" role="alert" data-state="error">
            <p className="chart__failtitle">Data health did not load</p>
            <p className="chart__failtext">{api.error.message}</p>
            <button type="button" className="btn" onClick={api.retry}>
              Retry
            </button>
          </div>
        ) : (
          <div className="chart__skel skel" aria-hidden="true" style={{ height: 320 }} />
        )
      ) : (
        <Body h={api.data} now={now} />
      )}
    </Disclosure>
  );
}
