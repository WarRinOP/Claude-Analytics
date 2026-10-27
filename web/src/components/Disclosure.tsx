// An expandable section with an anchor. The heading is a button (aria-expanded); the body animates with grid rows and is
// hidden from the tab order and screen readers while closed. A link to `#<id>` (the sync pill) opens it and brings it into view.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export const OPEN_EVENT = 'ledger:open';

// Asks the section with this anchor to open. The sync pill calls it, so a second click on the same address still opens it.
export function requestOpen(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: id }));
}

interface Props {
  id: string;
  title: string;
  summary: ReactNode;
  children: ReactNode;
}

export function Disclosure({ id, title, summary, children }: Props) {
  const uid = useId().replace(/:/g, '');
  const [open, setOpen] = useState(() => window.location.hash === `#${id}`);
  const [seen, setSeen] = useState(open); // the body is built the first time it opens, then kept
  const host = useRef<HTMLElement>(null);
  const wanted = useRef(open);

  useEffect(() => {
    const show = (): void => {
      wanted.current = true;
      setOpen(true);
      setSeen(true);
    };
    const onHash = (): void => {
      if (window.location.hash === `#${id}`) show();
    };
    const onAsk = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === id) show();
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener(OPEN_EVENT, onAsk);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener(OPEN_EVENT, onAsk);
    };
  }, [id]);

  // Opened by an address or by the pill: bring the heading to the top once the page around it has settled.
  useEffect(() => {
    if (!open || !wanted.current) return undefined;
    wanted.current = false;
    const t = window.setTimeout(() => host.current?.scrollIntoView({ block: 'start' }), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    <section ref={host} className="disc" id={id} data-panel={id} data-open={open ? 'true' : 'false'}>
      <h2 className="disc__h">
        <button
          type="button"
          className="disc__btn"
          aria-expanded={open}
          aria-controls={`${uid}-body`}
          aria-labelledby={`${uid}-title`}
          aria-describedby={`${uid}-sum`}
          onClick={() => {
            setOpen((o) => !o);
            setSeen(true);
          }}
        >
          <svg className="disc__caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M4 2.2 8.2 6 4 9.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="disc__title" id={`${uid}-title`}>
            {title}
          </span>
          <span className="disc__sum" id={`${uid}-sum`}>
            {summary}
          </span>
        </button>
      </h2>
      <div className="disc__body" id={`${uid}-body`} role="region" aria-labelledby={`${uid}-title`}>
        <div className="disc__inner">{seen ? children : null}</div>
      </div>
    </section>
  );
}
