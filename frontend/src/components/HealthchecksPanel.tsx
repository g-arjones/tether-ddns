import type { JSX } from 'react';
import type { HealthcheckRef, HealthchecksProject, ProjectRuntime } from '../types';
import {
  DISPLAY_LABEL, ago, checkDisplayStatus, elapsedShort, overviewPill, projectUnknown, type CheckDisplay,
} from '../utils';
import { HcSummary } from './HcSummary';

export interface HealthchecksPanelProps {
  projects: HealthchecksProject[];
  runtime: Record<string, ProjectRuntime> | undefined;
  nowMs: number;
}

const BAR_ORDER: CheckDisplay[] = ['down', 'grace', 'up', 'paused', 'new', 'gone'];
const DENSE_AFTER = 40;
const TIMED: CheckDisplay[] = ['up', 'grace', 'down'];

function unknownNote(rt: ProjectRuntime | undefined): { text: string; err: boolean } {
  if (rt?.offline) return { text: 'System is offline — polling paused.', err: false };
  if (rt && !rt.ok && rt.error) return { text: `Last poll failed: ${rt.error}`, err: true };
  return { text: 'Waiting for first poll.', err: false };
}

interface ProjectBlockProps {
  project: HealthchecksProject;
  refs: HealthcheckRef[];
  rt: ProjectRuntime | undefined;
  nowMs: number;
}

function ProjectBlock({ project, refs, rt, nowMs }: ProjectBlockProps): JSX.Element {
  const unknown = projectUnknown(rt);
  const items = refs.map((ref) => ({ ref, display: checkDisplayStatus(rt, ref.key) }));
  const segments = [...items].sort((a, b) => BAR_ORDER.indexOf(a.display) - BAR_ORDER.indexOf(b.display));
  const note = unknown ? unknownNote(rt) : null;
  const barClass = `hcp-bar${unknown ? ' hc-unknown' : ''}${refs.length > DENSE_AFTER ? ' dense' : ''}`;
  return (
    <div className="hcp-proj">
      <div className="hcp-head">
        <strong>{project.name}</strong>
        <div className={barClass} aria-hidden="true">
          {unknown ? null : segments.map(({ ref, display }) => <span key={ref.key} className={`hc-${display}`} />)}
        </div>
        <HcSummary refs={refs} runtime={rt} />
      </div>
      {note ? <div className={`hcp-note${note.err ? ' hcp-note-err' : ''}`}>{note.text}</div> : null}
      <div className="hcp-chips">
        {items.map(({ ref, display }) => {
          const live = rt?.checks[ref.key];
          return (
            <span
              key={ref.key}
              className={`hcp-chip hc-${display}`}
              title={`${DISPLAY_LABEL[display]} · last ping ${ago(live?.last_ping ?? null, nowMs)}`}
            >
              <i aria-hidden="true" />
              <span className="hcp-name">
                <span className="hc-sr">{DISPLAY_LABEL[display]}: </span>
                {live?.name ?? ref.name}
              </span>
              <span className="hcp-time">
                {TIMED.includes(display) ? elapsedShort(live?.last_ping ?? null, nowMs) : DISPLAY_LABEL[display]}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function HealthchecksPanel({ projects, runtime, nowMs }: HealthchecksPanelProps): JSX.Element | null {
  const rows = projects
    .filter((p) => p.show_on_overview)
    .map((p) => ({ project: p, refs: p.checks.filter((c) => c.visible), runtime: runtime?.[p.id] }))
    .filter((row) => row.refs.length > 0);
  if (rows.length === 0) return null;
  const pill = overviewPill(rows);
  const total = rows.reduce((n, row) => n + row.refs.length, 0);
  return (
    <div className="panel ov-wide hc-panel">
      <div className="panel-head">
        <h4>Healthchecks</h4>
        <span className={`hc-pill hc-${pill.status}`}><i aria-hidden="true" />{pill.text}</span>
        <span className="sub">
          {rows.length} {rows.length === 1 ? 'project' : 'projects'}
          <span className="hcp-n-checks"> · {total} {total === 1 ? 'check' : 'checks'}</span>
        </span>
      </div>
      {rows.map(({ project, refs, runtime: rt }) => (
        <ProjectBlock key={project.id} project={project} refs={refs} rt={rt} nowMs={nowMs} />
      ))}
    </div>
  );
}
