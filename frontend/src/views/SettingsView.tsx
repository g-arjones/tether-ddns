import type { Settings } from '../types';
import { Select } from '../components/Select';

export interface SettingsViewProps {
  settings: Settings | null;
  ipSources: { key: string; display_name: string }[];
  onSave: (patch: Partial<Settings>) => void;
}

const INTERVALS = [
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 600, label: '10 min' },
  { value: 1800, label: '30 min' },
  { value: 3600, label: '1 hr' },
];

export function SettingsView({ settings, ipSources, onSave }: SettingsViewProps) {
  return (
    <>
      <div className="section-head">
        <h3>Settings</h3>
      </div>
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
                <div className="chips">
                  {INTERVALS.map(({ value, label }) => (
                    <button
                      type="button"
                      key={value}
                      className={`chip${settings.check_interval === value ? ' active' : ''}`}
                      onClick={() => onSave({ check_interval: value })}
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
                    onChange={() => onSave({ update_on_startup: !settings.update_on_startup })}
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
                    onChange={() => onSave({ notify: !settings.notify })}
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
                    onChange={() => onSave({ retry_on_failure: !settings.retry_on_failure })}
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
                  onChange={(ip_source) => onSave({ ip_source })}
                />
              </div>
              <div className="field-help">
                Sources are pluggable; drop a new module in{' '}
                <code style={{ fontFamily: 'var(--mono)' }}>ip_sources/</code> to add one.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
