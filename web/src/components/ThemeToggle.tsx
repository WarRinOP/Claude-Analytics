import { useState } from 'react';
import { applyTheme, savedTheme, type ThemeChoice } from '../lib/theme.ts';

const CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => savedTheme());
  return (
    <div className="seg seg--quiet" role="group" aria-label="Theme">
      {CHOICES.map((c) => (
        <button
          key={c.id}
          type="button"
          className="seg__btn"
          aria-pressed={choice === c.id}
          onClick={() => {
            setChoice(c.id);
            applyTheme(c.id);
          }}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
