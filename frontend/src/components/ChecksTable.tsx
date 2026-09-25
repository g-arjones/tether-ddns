import type { JSX } from 'react';
import type { CheckStatus, HealthchecksProject, ProjectRuntime } from '../types';
import { DISPLAY_LABEL, ago, checkDisplayStatus, humanDuration } from '../utils';

export interface ChecksTableProps {
  project: HealthchecksProject;
  runtime: ProjectRuntime | undefined;
  nowMs: number;
  onToggleCheck: (key: string, visible: boolean) => void;
}

function Period({ live }: { live: CheckStatus }): JSX.Element {
  if (live.schedule) {
    return <><span className="mono">{live.schedule}</span>{live.tz ? ` ${live.tz}` : null}</>;
  }
  return <>{humanDuration(live.timeout ?? 0)}</>;
}

export function ChecksTable({ project, runtime, nowMs, onToggleCheck }: ChecksTableProps): JSX.Element {
  return (
    <table className="hc-table">
      <thead>
        <tr>
          <th className="hc-c-status">Status</th>
          <th>Name</th>
          <th className="hc-c-slug">Slug</th>
          <th className="hc-c-period">Period / Grace</th>
          <th>Last ping</th>
          <th className="hc-c-ov">Overview</th>
        </tr>
      </thead>
      <tbody>
        {project.checks.length === 0 ? (
          <tr><td colSpan={6} className="hc-empty-row">No checks in this project.</td></tr>
        ) : project.checks.map((ref) => {
          const display = checkDisplayStatus(runtime, ref.key);
          const live = runtime?.checks[ref.key];
          const name = live?.name ?? ref.name;
          const label = DISPLAY_LABEL[display];
          const lastPing = live?.last_ping ?? null;
          return (
            <tr key={ref.key} className={display === 'gone' ? 'hc-gone-row' : undefined}>
              <td className="hc-c-status">
                <span className={`hc-pill hc-${display}`}><i aria-hidden="true" />{label}</span>
              </td>
              <td className="hc-c-name">
                <span className="hc-mob">
                  <i className={`hc-dot hc-${display}`} aria-hidden="true" />
                  <span className="hc-sr">{label}: </span>
                </span>
                {name}
                {display === 'gone' ? <span className="hc-sub">Not in last poll — Fetch to remove</span> : null}
                {live ? (
                  <span className="hc-sub hc-period-sub"><Period live={live} /> · grace {humanDuration(live.grace)}</span>
                ) : null}
              </td>
              <td className="hc-c-slug mono">{live?.slug ?? ref.slug}</td>
              <td className="hc-c-period">
                {live ? <><Period live={live} /><span className="hc-sub">{humanDuration(live.grace)}</span></> : '—'}
              </td>
              <td title={lastPing !== null ? new Date(lastPing * 1000).toLocaleString() : undefined}>
                <span className="hc-long">{ago(lastPing, nowMs)}</span>
                <span className="hc-short">{ago(lastPing, nowMs, true)}</span>
              </td>
              <td className="hc-c-ov">
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label={`Show ${name} on Overview`}
                    checked={ref.visible}
                    onChange={() => onToggleCheck(ref.key, !ref.visible)}
                  />
                  <span className="slider" />
                </label>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
