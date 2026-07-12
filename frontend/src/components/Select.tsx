import { useEffect, useRef, useState } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

/**
 * Styled combo-box matching the mockup's `.cs` widget.
 *
 * A visually-hidden but focusable native `<select>` is the accessibility and
 * form source of truth (screen readers, keyboard, and tests use it); the
 * `aria-hidden` trigger + menu provide the styled visuals for pointer users.
 */
export function Select({ id, value, options, onChange, ariaLabel }: SelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className={`cs${open ? ' open' : ''}`} ref={wrapRef}>
      <select
        className="cs-native"
        id={id}
        aria-label={ariaLabel}
        value={value}
        tabIndex={-1}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <button
        type="button"
        className="cs-trigger"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cs-label">{selected?.label ?? ''}</span>
        <svg className="cs-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className="cs-menu" role="listbox" aria-hidden="true">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`cs-option${o.value === value ? ' sel' : ''}`}
            onClick={() => choose(o.value)}
          >
            <span>{o.label}</span>
            <svg className="cs-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5L20 7" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
