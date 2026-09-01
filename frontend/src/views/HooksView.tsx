import type { JSX } from 'react';
import type { HookConfig, HookDef } from '../types';
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

  if (hooks.length === 0) {
    return (
      <>
        <div className="section-head">
          <h3>Hooks</h3>
          <span className="count-badge">0 hooks</span>
          <div className="spacer"></div>
          <button className="btn btn-primary" onClick={onAdd}>
            <IconPlus strokeWidth={2.5} />
            Add Hook
          </button>
        </div>
        <div className="empty">
          <IconHook strokeWidth={1.5} />
          <h3>No hooks configured</h3>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="section-head">
        <h3>Hooks</h3>
        <span className="count-badge">{hooks.length} {hooks.length === 1 ? 'hook' : 'hooks'}</span>
        <div className="spacer"></div>
        <button className="btn btn-primary" onClick={onAdd}>
          <IconPlus strokeWidth={2.5} />
          Add Hook
        </button>
      </div>
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
              <button
                className="act-btn"
                onClick={() => onRun(hook.id)}
                title="Run now"
                aria-label="Run now"
              >
                <IconPlay />
              </button>
              <button
                className="act-btn"
                onClick={() => onEdit(hook)}
                title="Edit"
                aria-label="Edit"
              >
                <IconEdit />
              </button>
              <button
                className="act-btn danger"
                onClick={() => onDelete(hook.id)}
                title="Delete"
                aria-label="Delete"
              >
                <IconTrash />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
