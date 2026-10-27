// A figure in Commit Mono. The full number is shown, with the separators drawn quieter; only when it does not fit the space
// does it fall back to a compact form (8.72B), and then the full value is the tooltip and the accessible name.
import { useLayoutEffect, useRef, useState } from 'react';
import { compact, full } from '../lib/format.ts';
import { Tip } from './Tip.tsx';

export function Digits({ text }: { text: string }) {
  const bits = text.split(',');
  return (
    <>
      {bits.map((b, i) => (
        <span key={i}>
          {i > 0 && <span className="sep">,</span>}
          {b}
        </span>
      ))}
    </>
  );
}

// Width the full number would take, measured with a throwaway copy that is removed again, so the page never carries a second
// copy of the digits (screen readers, text search and tests see each number once).
function fullWidth(host: HTMLElement, text: string): number {
  const probe = document.createElement('span');
  probe.className = 'bignum__probe';
  text.split(',').forEach((group, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ',';
      probe.appendChild(sep);
    }
    probe.appendChild(document.createTextNode(group));
  });
  host.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  host.removeChild(probe);
  return width;
}

interface BigNumberProps {
  value: number;
  kpi: string;
  // For a figure that is not a plain count (dollars): the text shown, the shorter text when it does not fit, and the exact value
  // that names it for assistive technology and the tooltip. Absent, the count is written in full and compacted as 8.72B.
  shown?: string;
  short?: string;
  exact?: string;
  // Extra data attributes on the figure (the unrounded value, for tests and scripts).
  data?: Record<string, string>;
}

export function BigNumber({ value, kpi, shown, short: shortText, exact, data }: BigNumberProps) {
  const fullText = shown ?? full(value);
  const exactText = exact ?? fullText;
  const wrap = useRef<HTMLSpanElement>(null);
  const [short, setShort] = useState(false);

  useLayoutEffect(() => {
    const w = wrap.current;
    if (w === null) return undefined;
    const measure = (): void => setShort(fullWidth(w, fullText) > w.getBoundingClientRect().width + 0.5);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(w);
    return () => ro.disconnect();
  }, [fullText]);

  return (
    <span className="bignum" ref={wrap} data-kpi={kpi} data-full={fullText} data-compact={short ? 'true' : undefined} {...data}>
      {short ? (
        <Tip text={exactText} className="bignum__tip">
          <span role="img" aria-label={exactText}>
            {shortText ?? compact(value)}
          </span>
        </Tip>
      ) : exact !== undefined && exact !== fullText ? (
        <span role="img" aria-label={exactText}>
          <Digits text={fullText} />
        </span>
      ) : (
        <Digits text={fullText} />
      )}
    </span>
  );
}
