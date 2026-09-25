import { useState, type JSX } from 'react';
import type { Settings } from '../types';
import { ApiError } from '../api';
import { Select } from '../components/Select';
import { SectionHeader } from '../components/SectionHeader';

export interface SettingsViewProps {
  settings: Settings | null;
  ipSources: { key: string; display_name: string }[];
  onSave: (patch: Partial<Settings>) => Promise<void>;
}

const INTERVALS = [
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 600, label: '10 min' },
  { value: 1800, label: '30 min' },
  { value: 3600, label: '1 hr' },
];

const HEARTBEAT_INTERVALS = [
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
];

type Save = SettingsViewProps['onSave'];

// App has already toasted any failure; fire-and-forget controls just swallow it.
const fire = (onSave: Save, patch: Partial<Settings>) => { void onSave(patch).catch(() => undefined); };

function HeartbeatPanel({ settings, onSave }: { settings: Settings; onSave: Save }): JSX.Element {
  const saved = settings.heartbeat_url ?? '';
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.trim() !== saved;

  const submit = async () => {
    if (!dirty) return;
    try {
      await onSave({ heartbeat_url: draft.trim() || null });
    } catch (err) {
      setError(err instanceof ApiError ? err.fieldErrors.heartbeat_url ?? null : null);
    }
  };

  return (
    <div className="panel">
      <div className="settings-group">
        <div className="sg-title">Heartbeat</div>
        <div className="field">
          <label htmlFor="setHeartbeatUrl">
            Ping URL <span className="hint">— GET on every interval, while online</span>
          </label>
          <form className="hb-url" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <input
              id="setHeartbeatUrl"
              type="text"
              className={error ? 'hb-invalid' : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby="setHeartbeatUrlHelp"
              placeholder="https://hc-ping.com/your-uuid"
              spellCheck={false}
              autoComplete="off"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
            />
            <button type="submit" className="btn btn-ghost" disabled={!dirty}>Save</button>
          </form>
          <div id="setHeartbeatUrlHelp" className={`field-help${error ? ' hb-error' : ''}`}>
            {error ?? 'Leave empty to disable.'}
          </div>
        </div>
        <div>
          <div className="sr-text" style={{ marginBottom: 10 }}>
            <span className="t">Interval</span>
            <span className="d">How often to ping while online.</span>
          </div>
          <div className={`chips${saved ? '' : ' hb-dim'}`} role="group" aria-label="Heartbeat interval">
            {HEARTBEAT_INTERVALS.map(({ value, label }) => (
              <button
                type="button"
                key={value}
                className={`chip${settings.heartbeat_interval === value ? ' active' : ''}`}
                onClick={() => fire(onSave, { heartbeat_interval: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsView({ settings, ipSources, onSave }: SettingsViewProps) {
  return (
    <>
      <SectionHeader title="Settings" />
      {settings === null ? (
        <div className="empty"><p>Loading settings…</p></div>
      ) : (
        <div className="settings-grid">
          <div className="panel">
            <div className="settings-group">
              <div className="sg-title">Scheduling</div>
              <div>
                <div className="sr-text" style={{ marginBottom: 10 }}>
                  <span className="t">Check interval</span>
                  <span className="d">How often to check for a public-IP change.</span>
                </div>
                <div className="chips" role="group" aria-label="Check interval">
                  {INTERVALS.map(({ value, label }) => (
                    <button
                      type="button"
                      key={value}
                      className={`chip${settings.check_interval === value ? ' active' : ''}`}
                      onClick={() => fire(onSave, { check_interval: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="settings-group">
              <div className="sg-title">Behavior</div>
              <div className="switch-row">
                <div className="sr-text">
                  <span className="t">Update on startup</span>
                  <span className="d">Force a sync when the service launches.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Update on startup"
                    checked={settings.update_on_startup}
                    onChange={() => fire(onSave, { update_on_startup: !settings.update_on_startup })}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="switch-row">
                <div className="sr-text">
                  <span className="t">Notifications</span>
                  <span className="d">Notify on IP change and update failures.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Notifications"
                    checked={settings.notify}
                    onChange={() => fire(onSave, { notify: !settings.notify })}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="switch-row">
                <div className="sr-text">
                  <span className="t">Retry on failure</span>
                  <span className="d">Auto-retry failed updates with backoff.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Retry on failure"
                    checked={settings.retry_on_failure}
                    onChange={() => fire(onSave, { retry_on_failure: !settings.retry_on_failure })}
                  />
                  <span className="slider" />
                </label>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="settings-group">
              <div className="sg-title">IP source</div>
              <div className="field">
                <label htmlFor="setSource">
                  Primary source <span className="hint">— queried for the public IP</span>
                </label>
                <Select
                  id="setSource"
                  ariaLabel="Primary source"
                  value={settings.ip_source}
                  options={ipSources.map((s) => ({ value: s.key, label: s.display_name }))}
                  onChange={(ip_source) => fire(onSave, { ip_source })}
                />
              </div>
              <div className="field-help">
                Sources are pluggable; drop a new module in{' '}
                <code style={{ fontFamily: 'var(--mono)' }}>ip_sources/</code> to add one.
              </div>
            </div>
          </div>

          {/* Keyed on the saved URL so a save (incl. server normalisation) resets the draft. */}
          <HeartbeatPanel key={settings.heartbeat_url ?? ''} settings={settings} onSave={onSave} />
        </div>
      )}
    </>
  );
}
