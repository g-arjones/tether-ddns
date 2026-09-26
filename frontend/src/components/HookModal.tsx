import { useEffect, useRef, useState } from 'react';
import { subErrors, useFormErrors } from '../formErrors';
import type { HookConfig, HookDef } from '../types';
import { FieldHelp } from './FieldHelp';
import { SchemaForm, type JsonSchema } from './SchemaForm';
import { Select } from './Select';
import { Modal } from './Modal';

export interface HookModalProps {
  open: boolean;
  hooks: HookDef[];
  editing: HookConfig | null;
  onClose: () => void;
  onSave: (input: HookFormValue) => Promise<void>;
}

export interface HookFormValue {
  hook: string;
  events: string[];
  config: Record<string, unknown>;
}

const EMPTY: HookFormValue = { hook: '', events: [], config: {} };

const CONFIG = 'config';
const inConfig = (key: string) => key === CONFIG || key.startsWith(`${CONFIG}.`);

export function HookModal({ open, hooks, editing, onClose, onSave }: HookModalProps) {
  const [form, setForm] = useState<HookFormValue>(EMPTY);
  const { errors, formError, saving, reset, clear, submit } = useFormErrors('Failed to save hook');
  // Read, not depended on: a ws reconnect refetches hooks and must not wipe the form.
  const hooksRef = useRef(hooks);
  useEffect(() => { hooksRef.current = hooks; }, [hooks]);

  // Reset only on open: a closing modal keeps its content while it fades out.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({ hook: editing.hook, events: editing.events, config: editing.config ?? {} });
    } else {
      setForm({ ...EMPTY, hook: hooksRef.current[0]?.key ?? '' });
    }
    reset();
  }, [editing, open, reset]);

  useEffect(() => {
    if (!editing && form.hook === '' && hooks.length > 0) {
      setForm((f) => ({ ...f, hook: hooks[0].key }));
    }
  }, [editing, form.hook, hooks]);

  const selected = hooks.find((h) => h.key === form.hook);
  const schema = (selected?.schema ?? {}) as JsonSchema;
  const availableEvents = selected?.events ?? [];
  const configErrors = subErrors(errors, CONFIG);
  const alert = formError ?? configErrors[''] ?? null;

  const changeHook = (hook: string) => {
    setForm((f) => ({ ...f, hook, config: {}, events: [] }));
    clear((k) => k === 'hook' || k === 'events' || inConfig(k));
  };
  const toggleEvent = (event: string) => {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event],
    }));
    clear((k) => k === 'events');
  };
  const changeConfig = (config: Record<string, unknown>) => {
    const changed = Object.keys(config).filter((k) => config[k] !== form.config[k]);
    setForm((f) => ({ ...f, config }));
    clear((k) => k === CONFIG || changed.some((c) => k === `${CONFIG}.${c}` || k.startsWith(`${CONFIG}.${c}.`)));
  };

  return (
    <Modal
      open={open}
      title={editing ? 'Edit Hook' : 'Add Hook'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void submit(() => onSave(form)); }}>
            {editing ? 'Save Changes' : 'Add Hook'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor="fHook">Hook</label>
        <Select
          id="fHook"
          ariaLabel="Hook"
          value={form.hook}
          options={hooks.map((h) => ({ value: h.key, label: h.display_name }))}
          invalid={Boolean(errors.hook)}
          describedBy={errors.hook ? 'fHook-help' : undefined}
          onChange={changeHook}
        />
        <FieldHelp id="fHook-help" error={errors.hook} />
      </div>
      {schema.description ? <p className="modal-blurb">{schema.description}</p> : null}
      <div className="field">
        <label>Events</label>
        <div
          className="chips"
          role="group"
          aria-label="Events"
          aria-describedby={errors.events ? 'fEvents-help' : undefined}
        >
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
        <FieldHelp id="fEvents-help" error={errors.events} />
      </div>
      <SchemaForm schema={schema} value={form.config} errors={configErrors} onChange={changeConfig} />
      {alert ? <div className="field-help hb-error" role="alert">{alert}</div> : null}
    </Modal>
  );
}
