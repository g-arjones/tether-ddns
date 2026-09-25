import type { JSX } from 'react';
import type { HealthchecksProject, ProjectRuntime } from '../types';
import { EmptyState } from '../components/EmptyState';
import { ProjectCard } from '../components/ProjectCard';
import { SectionHeader } from '../components/SectionHeader';
import { IconHeartPulse, IconPlus } from '../components/icons';

export interface HealthchecksViewProps {
  projects: HealthchecksProject[];
  runtime: Record<string, ProjectRuntime> | undefined;
  nowMs: number;
  onAdd: () => void;
  onEdit: (project: HealthchecksProject) => void;
  onDelete: (id: string) => void;
  onFetch: (id: string) => Promise<void>;
  onToggleOverview: (id: string, next: boolean) => void;
  onToggleCheck: (id: string, key: string, visible: boolean) => void;
}

export function HealthchecksView(props: HealthchecksViewProps): JSX.Element {
  const { projects, runtime, nowMs, onAdd, onEdit, onDelete, onFetch, onToggleOverview, onToggleCheck } = props;
  const header = (
    <SectionHeader
      title="Healthchecks"
      count={{ n: projects.length, noun: 'project' }}
      action={(
        <button type="button" className="btn btn-primary" onClick={onAdd}>
          <IconPlus strokeWidth={2.5} />
          Add project
        </button>
      )}
    />
  );
  if (projects.length === 0) {
    return (
      <>
        {header}
        <EmptyState icon={<IconHeartPulse strokeWidth={1.5} />} title="No projects yet">
          Add a healthchecks.io project with a read-only API key.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {header}
      <div className="hc-list">
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            runtime={runtime?.[p.id]}
            nowMs={nowMs}
            onToggleOverview={(next) => onToggleOverview(p.id, next)}
            onToggleCheck={(key, visible) => onToggleCheck(p.id, key, visible)}
            onFetch={() => onFetch(p.id)}
            onEdit={() => onEdit(p)}
            onDelete={() => onDelete(p.id)}
          />
        ))}
      </div>
    </>
  );
}
