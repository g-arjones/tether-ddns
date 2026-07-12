import { useEffect, useState } from 'react';
import type { HookConfig, HookDef } from '../types';
import { SchemaForm, type JsonSchema } from './SchemaForm';
import { Select } from './Select';

export interface HookModalProps {
  open: boolean;
  hooks: HookDef[];
  editing: HookConfig | null;
  onClose: () => void;
  onSave: (input: HookFormValue) => void;
}

export interface HookFormValue {
  hook: string;
  events: string[];
  config: Record<string, unknown>;
}

const EMPTY: HookFormValue = { hook: '', events: [], config: {} };

export function HookModal({ open, hooks, editing, onClose, onSave }: HookModalProps) {
  const [form, setForm] = useState<HookFormValue>(EMPTY);

  useEffect(() => {
    if (editing) {
      setForm({ hook: editing.hook, events: editing.events, config: editing.config ?? {} });
    } else {
      setForm({ ...EMPTY, hook: hooks[0]?.key ?? '' });
    }
  }, [editing, hooks, open]);

  const selected = hooks.find((h) => h.key === form.hook);
  const schema = (selected?.schema ?? {}) as JsonSchema;
  const availableEvents = selected?.events ?? [];

  const toggleEvent = (event: string) => {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event],
    }));
  };

  return (
    <div className={`modal-overlay${open ? ' open' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <h3>{editing ? 'Edit Hook' : 'Add Hook'}</h3>
          <button type="button" className="icon-btn" style={{ width: 34, height: 34 }} onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="fHook">Hook</label>
            <Select
              id="fHook"
              ariaLabel="Hook"
              value={form.hook}
              options={hooks.map((h) => ({ value: h.key, label: h.display_name }))}
              onChange={(hook) => setForm({ ...form, hook, config: {}, events: [] })}
            />
          </div>
          {schema.description ? <p className="modal-blurb">{schema.description}</p> : null}
          <div className="field">
            <label>Events</label>
            <div className="chips">
              {availableEvents.map((event) => (
                <button
                  type="button"
                  key={event.key}
                  className={`chip${form.events.includes(event.key) ? ' active' : ''}`}
                  aria-pressed={form.events.includes(event.key)}
                  onClick={() => toggleEvent(event.key)}
                >
                  {event.label}
                </button>
              ))}
            </div>
          </div>
          <SchemaForm schema={schema} value={form.config} onChange={(config) => setForm({ ...form, config })} />
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(form)}>
            {editing ? 'Save Changes' : 'Add Hook'}
          </button>
        </div>
      </div>
    </div>
  );
}
