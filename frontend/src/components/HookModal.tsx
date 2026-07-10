import { useEffect, useState } from 'react';
import type { HookConfig, HookDef } from '../types';
import { SchemaForm, type JsonSchema } from './SchemaForm';

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
            <select id="fHook" value={form.hook} onChange={(e) => setForm({ ...form, hook: e.target.value, config: {}, events: [] })}>
              {hooks.map((h) => (
                <option key={h.key} value={h.key}>{h.display_name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Events</label>
            {availableEvents.map((event) => (
              <label className="switch-row" key={event} style={{ cursor: 'pointer' }}>
                <div className="sr-text"><div className="t">{event}</div></div>
                <input
                  type="checkbox"
                  aria-label={event}
                  checked={form.events.includes(event)}
                  onChange={() => toggleEvent(event)}
                />
              </label>
            ))}
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
