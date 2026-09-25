import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { HealthchecksProject } from '../types';
import { Modal } from './Modal';

export interface ProjectFormValue {
  name: string;
  base_url: string;
  api_key: string;
  poll_interval: number;
}

export interface ProjectModalProps {
  open: boolean;
  editing: HealthchecksProject | null;
  onClose: () => void;
  onSave: (value: ProjectFormValue) => Promise<void>;
}

const POLL_INTERVALS = [
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
  { value: 3600, label: '1 hr' },
];

const EMPTY: ProjectFormValue = { name: '', base_url: 'https://healthchecks.io', api_key: '', poll_interval: 300 };

export function ProjectModal({ open, editing, onClose, onSave }: ProjectModalProps): JSX.Element {
  const [form, setForm] = useState<ProjectFormValue>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(editing
      ? { name: editing.name, base_url: editing.base_url, api_key: '', poll_interval: editing.poll_interval }
      : EMPTY);
    setErrors({});
    setFormError(null);
  }, [editing, open]);

  const update = (patch: Partial<ProjectFormValue>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
    setFormError(null);
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(form);
    } catch (err) {
      const fields = err instanceof ApiError ? err.fieldErrors : {};
      setErrors(fields);
      setFormError(Object.keys(fields).length === 0 ? 'Failed to save project' : null);
    } finally {
      setSaving(false);
    }
  };

  const help = (key: string, fallback?: ReactNode) => (
    <div id={`hc-${key}-help`} className={`field-help${errors[key] ? ' hb-error' : ''}`}>
      {errors[key] ?? fallback}
    </div>
  );
  const invalid = (key: string) => ({
    className: errors[key] ? 'hc-invalid' : undefined,
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': `hc-${key}-help`,
  });

  return (
    <Modal
      open={open}
      title={editing ? 'Edit project' : 'Add project'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void submit(); }}>
            {editing ? 'Save' : 'Add & fetch'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor="hcName">Name</label>
        <input
          id="hcName" type="text" autoComplete="off" placeholder="Homelab" value={form.name}
          {...invalid('name')} onChange={(e) => update({ name: e.target.value })}
        />
        {help('name', 'Shown on the Healthchecks view and the Overview.')}
      </div>
      <div className="field">
        <label htmlFor="hcUrl">Base URL <span className="hint">— change for a self-hosted instance</span></label>
        <input
          id="hcUrl" type="text" autoComplete="off" spellCheck={false} value={form.base_url}
          {...invalid('base_url')} onChange={(e) => update({ base_url: e.target.value })}
        />
        {help('base_url')}
      </div>
      <div className="field">
        <label htmlFor="hcKey">API key</label>
        <input
          id="hcKey" type="password" autoComplete="off" placeholder={editing ? 'unchanged' : ''} value={form.api_key}
          {...invalid('api_key')} onChange={(e) => update({ api_key: e.target.value })}
        />
        {help('api_key', <>Use a <strong>read-only</strong> API key (Healthchecks → Project Settings → API Access).</>)}
      </div>
      <div>
        <div className="sr-text" style={{ marginBottom: 10 }}>
          <span className="t">Poll interval</span>
          <span className="d">How often to refresh check status while online.</span>
        </div>
        <div className="chips" role="group" aria-label="Poll interval">
          {POLL_INTERVALS.map(({ value, label }) => (
            <button
              type="button"
              key={value}
              className={`chip${form.poll_interval === value ? ' active' : ''}`}
              onClick={() => update({ poll_interval: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {formError ? <div className="field-help hb-error" role="alert">{formError}</div> : null}
    </Modal>
  );
}
