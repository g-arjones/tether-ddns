import { useState, type JSX } from 'react';
import type { HealthchecksProject, ProjectRuntime } from '../types';
import { ago, formatInterval, hostOf } from '../utils';
import { ChecksTable } from './ChecksTable';
import { HcSummary } from './HcSummary';
import { IconButton } from './IconButton';
import { IconChevronDown, IconEdit, IconRefresh, IconTrash } from './icons';

export interface ProjectCardProps {
  project: HealthchecksProject;
  runtime: ProjectRuntime | undefined;
  nowMs: number;
  onToggleOverview: (next: boolean) => void;
  onToggleCheck: (key: string, visible: boolean) => void;
  onFetch: () => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
}

export function ProjectCard(props: ProjectCardProps): JSX.Element {
  const { project, runtime, nowMs, onToggleOverview, onToggleCheck, onFetch, onEdit, onDelete } = props;
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  const runFetch = async () => {
    if (fetching) return;
    setFetching(true);
    try {
      await onFetch();
    } finally {
      setFetching(false);
    }
  };

  let banner: JSX.Element | null = null;
  if (runtime?.offline) {
    banner = <div className="hc-banner">System is offline — polling paused.</div>;
  } else if (runtime && !runtime.ok && runtime.error) {
    banner = <div className="hc-banner hc-banner-err" role="alert">Last poll failed: {runtime.error}</div>;
  }

  return (
    <div className="hc-card">
      <div className="hc-card-head">
        <IconButton
          label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
          variant="act"
          expanded={open}
          className={`hc-chevron${open ? ' open' : ''}`}
          onClick={() => setOpen((v) => !v)}
        >
          <IconChevronDown />
        </IconButton>
        <div className="hc-card-title">
          <strong>{project.name}</strong>
          <HcSummary refs={project.checks} runtime={runtime} withTotal />
        </div>
        <div className="hc-card-actions">
          <label className="hc-ov-toggle">
            <span className="switch">
              <input
                type="checkbox"
                checked={project.show_on_overview}
                onChange={() => onToggleOverview(!project.show_on_overview)}
              />
              <span className="slider" />
            </span>
            Show on Overview
          </label>
          <IconButton
            label="Fetch checks"
            variant="act"
            disabled={fetching}
            className={fetching ? 'spin' : undefined}
            onClick={() => { void runFetch(); }}
          >
            <IconRefresh />
          </IconButton>
          <IconButton label="Edit" variant="act" onClick={onEdit}><IconEdit /></IconButton>
          <IconButton label="Delete" variant="act" danger onClick={onDelete}><IconTrash /></IconButton>
        </div>
      </div>
      <div className="hc-facts">
        <span className="mono">{hostOf(project.base_url)}</span>
        <span>Poll every <b>{formatInterval(project.poll_interval)}</b></span>
        <span>Last poll <b>{ago(runtime?.polled_at ?? null, nowMs, true)}</b></span>
        <span>Fetched <b>{ago(project.fetched_at, nowMs, true)}</b></span>
      </div>
      {banner}
      {open ? (
        <div className="hc-inner">
          <ChecksTable project={project} runtime={runtime} nowMs={nowMs} onToggleCheck={onToggleCheck} />
        </div>
      ) : null}
    </div>
  );
}
