import type { JSX } from 'react';
import type { HookConfig, HookDef } from '../types';
import { EmptyState } from '../components/EmptyState';
import { IconButton } from '../components/IconButton';
import { SectionHeader } from '../components/SectionHeader';
import { IconEdit, IconHook, IconPlay, IconPlus, IconTrash } from '../components/icons';

export interface HooksViewProps {
  hooks: HookConfig[];
  hookDefs: HookDef[];
  onAdd: () => void;
  onRun: (id: string) => void;
  onEdit: (hook: HookConfig) => void;
  onDelete: (id: string) => void;
}

export function HooksView(props: HooksViewProps): JSX.Element {
  const { hooks, hookDefs, onAdd, onRun, onEdit, onDelete } = props;

  // Helper to get display name from hookDefs by key
  const getHookName = (hookKey: string): string => {
    const def = hookDefs.find((d) => d.key === hookKey);
    return def ? def.display_name : hookKey;
  };

  const header = (
    <SectionHeader
      title="Hooks"
      count={{ n: hooks.length, noun: 'hook' }}
      action={(
        <button className="btn btn-primary" onClick={onAdd}>
          <IconPlus strokeWidth={2.5} />
          Add Hook
        </button>
      )}
    />
  );

  if (hooks.length === 0) {
    return (
      <>
        {header}
        <EmptyState icon={<IconHook strokeWidth={1.5} />} title="No hooks configured" />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="hook-list">
        {hooks.map((hook) => (
          <div key={hook.id} className="hook-row">
            <div className="hook-ico">
              <IconHook />
            </div>
            <div className="hook-main">
              <div className="hook-name">{getHookName(hook.hook)}</div>
              <div className="hook-events">
                {hook.events.length === 0 ? (
                  <span style={{ color: 'var(--text-3)' }}>no events</span>
                ) : (
                  hook.events.map((event) => (
                    <span key={event} className="evt-tag">
                      {event}
                    </span>
                  ))
                )}
              </div>
            </div>
            <div className="hook-actions">
              <IconButton label="Run now" onClick={() => onRun(hook.id)} variant="act">
                <IconPlay />
              </IconButton>
              <IconButton label="Edit" onClick={() => onEdit(hook)} variant="act">
                <IconEdit />
              </IconButton>
              <IconButton label="Delete" onClick={() => onDelete(hook.id)} variant="act" danger>
                <IconTrash />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
