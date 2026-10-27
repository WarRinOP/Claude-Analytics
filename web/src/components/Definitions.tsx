// Definitions: every item of /api/definitions, in the API's own wording. Backtick marks in the wording become code styling,
// and the words are not changed. The section is closed until opened, and the list is fetched the first time it opens.
import type { Definitions } from '../../../src/api/types.ts';
import { useApi } from '../lib/api.ts';
import { withCode } from '../lib/definitions.ts';
import { Disclosure } from './Disclosure.tsx';

function List() {
  const api = useApi<Definitions>('/api/definitions', '');
  if (api.data === null && api.error !== null) {
    return (
      <div className="chart__fail" role="alert" data-state="error">
        <p className="chart__failtitle">The definitions did not load</p>
        <p className="chart__failtext">{api.error.message}</p>
        <button type="button" className="btn" onClick={api.retry}>
          Retry
        </button>
      </div>
    );
  }
  if (api.data === null) return <div className="chart__skel skel" aria-hidden="true" style={{ height: 240 }} />;
  return (
    <dl className="defs" data-testid="definitions-list">
      {api.data.definitions.map((d) => (
        <div className="defs__item" key={d.id} data-definition={d.id}>
          <dt id={`def-${d.id}`}>{d.term}</dt>
          <dd>{withCode(d.text).map((p, i) => (typeof p === 'string' ? p : <code key={i}>{p.code}</code>))}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DefinitionsPanel() {
  return (
    <Disclosure id="definitions" title="Definitions" summary="What each figure on this page counts">
      <List />
    </Disclosure>
  );
}
