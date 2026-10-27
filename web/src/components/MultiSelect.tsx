// A filter that opens a small panel of checkboxes. Not a modal: Tab moves through it and out of it, Escape closes it and
// returns focus to the button, a click outside closes it.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

interface Props {
  name: string; // "Model", "Project"
  plural: string; // "models", "projects"
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  children?: ReactNode; // extra rows at the foot of the panel
  badge?: boolean; // the foot toggles are not default
}

export function MultiSelect({ name, plural, options, selected, onChange, children, badge = false }: Props) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase();
    return n === '' ? options : options.filter((o) => o.label.toLowerCase().includes(n) || (o.hint ?? '').toLowerCase().includes(n));
  }, [options, needle]);

  const known = new Set(options.map((o) => o.value));
  const value =
    selected.length === 0
      ? 'All'
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0] ?? '')
        : `${selected.length} of ${options.length}`;

  const toggle = (v: string): void => onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);

  return (
    <div
      className="ms"
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
      <button
        ref={button}
        type="button"
        className="ms__btn"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-active={selected.length > 0 || badge ? 'true' : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ms__name">{name}</span>
        <span className="ms__value">{value}</span>
        <svg className="ms__chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ms__pop" id={panelId} role="group" aria-label={`${name} filter`}>
          {options.length > 8 && (
            <input
              type="search"
              className="ms__search"
              placeholder={`Find a ${name.toLowerCase()}`}
              aria-label={`Find a ${name.toLowerCase()}`}
              value={needle}
              onChange={(e) => setNeedle(e.target.value)}
              autoComplete="off"
            />
          )}
          <ul className="ms__list">
            {shown.length === 0 && <li className="ms__none">Nothing matches.</li>}
            {shown.map((o) => (
              <li key={o.value}>
                <label className="ms__item">
                  <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
                  <span className="ms__text">
                    <span className="ms__label">{o.label}</span>
                    {o.hint !== undefined && <span className="ms__hint">{o.hint}</span>}
                  </span>
                </label>
              </li>
            ))}
            {/* a filter value from the address that the archive does not know is still shown, so it can be removed */}
            {selected
              .filter((s) => !known.has(s))
              .map((s) => (
                <li key={s}>
                  <label className="ms__item">
                    <input type="checkbox" checked onChange={() => toggle(s)} />
                    <span className="ms__text">
                      <span className="ms__label">{s}</span>
                      <span className="ms__hint">Not in the archive</span>
                    </span>
                  </label>
                </li>
              ))}
          </ul>
          <div className="ms__foot">
            <button type="button" className="linkbtn" disabled={selected.length === 0} onClick={() => onChange([])}>
              {selected.length === 0 ? `All ${plural}` : `Clear, show all ${plural}`}
            </button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
