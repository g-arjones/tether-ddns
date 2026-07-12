import { useEffect, useState } from 'react';
import type { DomainConfig, Provider } from '../types';
import { SchemaForm, type JsonSchema } from './SchemaForm';
import { Select } from './Select';

export interface DomainModalProps {
  open: boolean;
  providers: Provider[];
  editing: DomainConfig | null;
  onClose: () => void;
  onSave: (input: DomainFormValue) => void;
}

export interface DomainFormValue {
  hostname: string;
  provider: string;
  record_type: string;
  enabled: boolean;
  provider_config: Record<string, unknown>;
}

const EMPTY: DomainFormValue = {
  hostname: '',
  provider: '',
  record_type: 'A',
  enabled: true,
  provider_config: {},
};

export function DomainModal({ open, providers, editing, onClose, onSave }: DomainModalProps) {
  const [form, setForm] = useState<DomainFormValue>(EMPTY);

  useEffect(() => {
    if (editing) {
      setForm({
        hostname: editing.hostname,
        provider: editing.provider,
        record_type: editing.record_type,
        enabled: editing.enabled,
        provider_config: editing.provider_config ?? {},
      });
    } else {
      setForm({ ...EMPTY, provider: providers[0]?.key ?? '' });
    }
  }, [editing, providers, open]);

  const selected = providers.find((p) => p.key === form.provider);
  const schema = (selected?.schema ?? {}) as JsonSchema;

  return (
    <div className={`modal-overlay${open ? ' open' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <h3>{editing ? 'Edit Domain' : 'Add Domain'}</h3>
          <button type="button" className="icon-btn" style={{ width: 34, height: 34 }} onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="fHostname">Hostname / FQDN</label>
            <input
              id="fHostname"
              type="text"
              placeholder="home.example.com"
              autoComplete="off"
              value={form.hostname}
              onChange={(e) => setForm({ ...form, hostname: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="fProvider">DNS Provider</label>
              <Select
                id="fProvider"
                ariaLabel="DNS Provider"
                value={form.provider}
                options={providers.map((p) => ({ value: p.key, label: p.display_name }))}
                onChange={(provider) => setForm({ ...form, provider, provider_config: {} })}
              />
            </div>
            <div className="field">
              <label htmlFor="fType">Record Type</label>
              <Select
                id="fType"
                ariaLabel="Record Type"
                value={form.record_type}
                options={[
                  { value: 'A', label: 'A (IPv4)' },
                  { value: 'AAAA', label: 'AAAA (IPv6)' },
                ]}
                onChange={(record_type) => setForm({ ...form, record_type })}
              />
            </div>
          </div>
          {schema.description ? <p className="modal-blurb">{schema.description}</p> : null}
          <SchemaForm schema={schema} value={form.provider_config} onChange={(provider_config) => setForm({ ...form, provider_config })} />
          <div className="switch-row">
            <div className="sr-text">
              <div className="t">Enable auto-update</div>
              <div className="d">Automatically sync this record on IP change</div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              <span className="slider" />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(form)}>
            {editing ? 'Save Changes' : 'Add Domain'}
          </button>
        </div>
      </div>
    </div>
  );
}
