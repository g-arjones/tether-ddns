import type { JSX } from 'react';
import type { HookConfig, HookDef } from '../types';

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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Hook
          </button>
        </div>
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 10a10 10 0 0 1 10 10" />
            <path d="M4 16a4 4 0 0 1 4 4" />
            <circle cx="5" cy="19" r="1" />
            <path d="m12 10 4-4a2.83 2.83 0 0 1 4 4l-4 4" />
            <path d="m14 8 3 3" />
            <path d="m9 15 3 3" />
          </svg>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Hook
        </button>
      </div>
      <div className="hook-list">
        {hooks.map((hook) => (
          <div key={hook.id} className="hook-row">
            <div className="hook-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 10 4-4a2.83 2.83 0 0 1 4 4l-4 4" />
                <path d="m14 8 3 3" />
                <path d="m9 15 3 3" />
                <path d="M4 10a10 10 0 0 1 10 10" />
              </svg>
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
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
              <button
                className="act-btn"
                onClick={() => onEdit(hook)}
                title="Edit"
                aria-label="Edit"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
                </svg>
              </button>
              <button
                className="act-btn danger"
                onClick={() => onDelete(hook.id)}
                title="Delete"
                aria-label="Delete"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
