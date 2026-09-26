import type { ReactNode } from 'react';

export interface FieldHelpProps {
  id: string;
  error?: string;
  children?: ReactNode;
}

// Renders nothing when empty: an empty child would still add the .field flex gap.
export function FieldHelp({ id, error, children }: FieldHelpProps) {
  const text = error ?? children;
  if (text == null || text === '') return null;
  return <div id={id} className={`field-help${error ? ' hb-error' : ''}`}>{text}</div>;
}
