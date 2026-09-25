import type { JSX } from 'react';
import type { HealthchecksProject, ProjectRuntime } from '../types';
import { DISPLAY_LABEL, ago, checkDisplayStatus } from '../utils';
import { HcSummary } from './HcSummary';

export interface HealthchecksPanelProps {
  projects: HealthchecksProject[];
  runtime: Record<string, ProjectRuntime> | undefined;
  nowMs: number;
}

export function HealthchecksPanel({ projects, runtime, nowMs }: HealthchecksPanelProps): JSX.Element | null {
  const rows = projects
    .filter((p) => p.show_on_overview)
    .map((p) => ({ project: p, refs: p.checks.filter((c) => c.visible) }))
    .filter((row) => row.refs.length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="panel ov-wide hc-panel">
      <div className="panel-head">
        <h4>Healthchecks</h4>
        <span className="sub">{rows.length} {rows.length === 1 ? 'project' : 'projects'}</span>
      </div>
      {rows.map(({ project, refs }) => {
        const rt = runtime?.[project.id];
        return (
          <div className="hc-row" key={project.id}>
            <div className="hc-row-name">
              <strong>{project.name}</strong>
              <HcSummary refs={refs} runtime={rt} />
            </div>
            <div className="hc-badges">
              {refs.map((ref) => {
                const display = checkDisplayStatus(rt, ref.key);
                const live = rt?.checks[ref.key];
                return (
                  <span
                    key={ref.key}
                    className={`hc-badge hc-${display}`}
                    title={`${DISPLAY_LABEL[display]} · last ping ${ago(live?.last_ping ?? null, nowMs)}`}
                  >
                    <i aria-hidden="true" />
                    <span className="hc-sr">{DISPLAY_LABEL[display]}: </span>
                    {live?.name ?? ref.name}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
