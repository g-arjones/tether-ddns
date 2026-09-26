import { useCallback, useRef, useState } from 'react';
import { ApiError } from './api';

export interface FormErrors {
  errors: Record<string, string>;
  formError: string | null;
  saving: boolean;
  reset: () => void;
  clear: (match: (key: string) => boolean) => void;
  submit: (save: () => Promise<void>) => Promise<void>;
}

// Server-validated form state: a rejected save keeps its 422 field errors, else shows `fallback`.
export function useFormErrors(fallback: string): FormErrors {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  const reset = useCallback(() => {
    setErrors({});
    setFormError(null);
  }, []);

  const clear = useCallback((match: (key: string) => boolean) => {
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !match(key))));
    setFormError(null);
  }, []);

  const submit = useCallback(async (save: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await save();
    } catch (err) {
      const fields = err instanceof ApiError ? err.fieldErrors : {};
      setErrors(fields);
      setFormError(Object.keys(fields).length === 0 ? fallback : null);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [fallback]);

  return { errors, formError, saving, reset, clear, submit };
}

export function invalidProps(error: string | undefined, helpId: string, hasHelp = Boolean(error)) {
  return {
    className: error ? 'field-invalid' : undefined,
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': hasHelp ? helpId : undefined,
  };
}
