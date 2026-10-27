// A tooltip that never gates anything: the same text is the accessible description of its trigger, it opens on hover and on
// keyboard focus, and Escape closes it. The bubble sits inside the wrapper, so it needs no portal.
import { useId, useState, type CSSProperties, type ReactNode } from 'react';

interface Props {
  text: string;
  children?: ReactNode;
  style?: CSSProperties;
  kind?: string;
  align?: 'start' | 'end';
  // false for text that is not otherwise reachable by keyboard: the wrapper then takes a tab stop
  focusable?: boolean;
  className?: string;
}

export function Tip({ text, children, style, kind, align = 'start', focusable = true, className = '' }: Props) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className={`tip ${className}`.trim()}
      data-align={align}
      data-kind={kind}
      style={style}
      data-dismissed={dismissed ? 'true' : undefined}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={id}
      onPointerLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setDismissed(true);
      }}
    >
      {children}
      <span role="tooltip" id={id} className="tip__bubble">
        {text}
      </span>
    </span>
  );
}
