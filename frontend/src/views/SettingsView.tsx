import type { Settings } from '../types';

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
  if (!settings) {
    return (
      <div className="view-settings">
        <div className="section-head">
          <h3>Settings</h3>
        </div>
        <div className="settings-loading">Loading settings…</div>
      </div>
    );
  }

  return (
    <div className="view-settings">
      <div className="section-head">
        <h3>Settings</h3>
      </div>

      <section className="settings-panel">
        <h4>Scheduling</h4>
        <div className="interval-chips">
          {INTERVALS.map(({ value, label }) => (
            <button
              key={value}
              className={settings.check_interval === value ? 'active' : ''}
              onClick={() => onSave({ check_interval: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-panel">
        <h4>Behavior</h4>
        <label className="switch-label">
          <input
            type="checkbox"
            checked={settings.update_on_startup}
            onChange={() => onSave({ update_on_startup: !settings.update_on_startup })}
          />
          Update on startup
        </label>
        <label className="switch-label">
          <input
            type="checkbox"
            checked={settings.notify}
            onChange={() => onSave({ notify: !settings.notify })}
          />
          Notify
        </label>
        <label className="switch-label">
          <input
            type="checkbox"
            checked={settings.retry_on_failure}
            onChange={() => onSave({ retry_on_failure: !settings.retry_on_failure })}
          />
          Retry on failure
        </label>
      </section>

      <section className="settings-panel">
        <h4>IP Source</h4>
        <select
          value={settings.ip_source}
          onChange={(e) => onSave({ ip_source: e.target.value })}
        >
          {ipSources.map((source) => (
            <option key={source.key} value={source.key}>
              {source.display_name}
            </option>
          ))}
        </select>
      </section>
    </div>
  );
}
