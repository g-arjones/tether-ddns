import { useEffect, useRef, useState } from 'react';
import { subErrors } from '../api';
import { invalidProps, useFormErrors } from '../formErrors';
import type { DomainConfig, Provider } from '../types';
import { FieldHelp } from './FieldHelp';
import { SchemaForm, type JsonSchema } from './SchemaForm';
import { Select } from './Select';
import { Modal } from './Modal';

export interface DomainModalProps {
  open: boolean;
  providers: Provider[];
  editing: DomainConfig | null;
  onClose: () => void;
  onSave: (input: DomainFormValue) => Promise<void>;
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

const CONFIG = 'provider_config';
const inConfig = (key: string) => key === CONFIG || key.startsWith(`${CONFIG}.`);

export function DomainModal({ open, providers, editing, onClose, onSave }: DomainModalProps) {
  const [form, setForm] = useState<DomainFormValue>(EMPTY);
  const { errors, formError, saving, reset, clear, submit } = useFormErrors('Failed to save domain');
  // Read, not depended on: a ws reconnect refetches providers and must not wipe the form.
  const providersRef = useRef(providers);
  useEffect(() => { providersRef.current = providers; }, [providers]);

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
      setForm({ ...EMPTY, provider: providersRef.current[0]?.key ?? '' });
    }
    reset();
  }, [editing, open, reset]);

  useEffect(() => {
    if (!editing && form.provider === '' && providers.length > 0) {
      setForm((f) => ({ ...f, provider: providers[0].key }));
    }
  }, [editing, form.provider, providers]);

  const update = (patch: Partial<DomainFormValue>) => {
    setForm((f) => ({ ...f, ...patch }));
    const keys = Object.keys(patch);
    clear((k) => keys.includes(k));
  };
  const changeProvider = (provider: string) => {
    setForm((f) => ({ ...f, provider, provider_config: {} }));
    clear((k) => k === 'provider' || inConfig(k));
  };
  const changeConfig = (provider_config: Record<string, unknown>) => {
    const changed = Object.keys(provider_config).filter((k) => provider_config[k] !== form.provider_config[k]);
    setForm((f) => ({ ...f, provider_config }));
    clear((k) => k === CONFIG || changed.some((c) => k === `${CONFIG}.${c}` || k.startsWith(`${CONFIG}.${c}.`)));
  };

  const selected = providers.find((p) => p.key === form.provider);
  const schema = (selected?.schema ?? {}) as JsonSchema;
  const configErrors = subErrors(errors, CONFIG) ?? {};
  const alert = formError ?? configErrors[''] ?? null;

  return (
    <Modal
      open={open}
      title={editing ? 'Edit Domain' : 'Add Domain'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void submit(() => onSave(form)); }}>
            {editing ? 'Save Changes' : 'Add Domain'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor="fHostname">Hostname / FQDN</label>
        <input
          id="fHostname"
          type="text"
          placeholder="home.example.com"
          autoComplete="off"
          value={form.hostname}
          {...invalidProps(errors.hostname, 'fHostname-help')}
          onChange={(e) => update({ hostname: e.target.value })}
        />
        <FieldHelp id="fHostname-help" error={errors.hostname} />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="fProvider">DNS Provider</label>
          <Select
            id="fProvider"
            ariaLabel="DNS Provider"
            value={form.provider}
            options={providers.map((p) => ({ value: p.key, label: p.display_name }))}
            invalid={Boolean(errors.provider)}
            describedBy={errors.provider ? 'fProvider-help' : undefined}
            onChange={changeProvider}
          />
          <FieldHelp id="fProvider-help" error={errors.provider} />
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
            invalid={Boolean(errors.record_type)}
            describedBy={errors.record_type ? 'fType-help' : undefined}
            onChange={(record_type) => update({ record_type })}
          />
          <FieldHelp id="fType-help" error={errors.record_type} />
        </div>
      </div>
      {schema.description ? <p className="modal-blurb">{schema.description}</p> : null}
      <SchemaForm schema={schema} value={form.provider_config} errors={configErrors} onChange={changeConfig} />
      <div className="switch-row">
        <div className="sr-text">
          <div className="t">Enable auto-update</div>
          <div className="d">Automatically sync this record on IP change</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={form.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span className="slider" />
        </label>
      </div>
      {alert ? <div className="field-help hb-error" role="alert">{alert}</div> : null}
    </Modal>
  );
}
