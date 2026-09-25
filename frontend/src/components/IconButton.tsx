import type { JSX, ReactNode } from 'react';

export interface IconButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  variant?: 'icon' | 'act';
  danger?: boolean;
  disabled?: boolean;
  className?: string;
}

// One `label` drives both the accessible name and the tooltip, so an icon-only
// button cannot ship without a name.
export function IconButton({
  label,
  onClick,
  children,
  variant = 'icon',
  danger = false,
  disabled = false,
  className,
}: IconButtonProps): JSX.Element {
  const classes = [variant === 'icon' ? 'icon-btn' : 'act-btn'];
  if (danger) classes.push('danger');
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(' ')}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
