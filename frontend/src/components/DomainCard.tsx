import type { DomainConfig, DomainState } from '../types';

export interface DomainCardProps {
  domain: DomainConfig;
  runtime: DomainState;
  onSync: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}

const STATUS_META: Record<string, { cls: string; label: string }> = {
  synced: { cls: 'st-synced', label: 'Synced' },
  pending: { cls: 'st-pending', label: 'Pending' },
  error: { cls: 'st-error', label: 'Error' },
  paused: { cls: 'st-paused', label: 'Paused' },
  updating: { cls: 'st-updating', label: 'Updating' },
};

function relTime(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function DomainCard({ domain, runtime, onSync, onEdit, onDelete, onToggle }: DomainCardProps) {
  const status = domain.enabled ? runtime.status : 'paused';
  const meta = STATUS_META[status] ?? STATUS_META.synced;
  const initials = domain.provider.slice(0, 2).toUpperCase();

  return (
    <div className={`domain-card${status === 'updating' ? ' updating' : ''}`}>
      <div className="dc-head">
        <div className="provider-badge" title={domain.provider}>{initials}</div>
        <div className="dc-title">
          <div className="name">{domain.hostname}</div>
          <div className="meta">
            <span className="rec-type">{domain.record_type}</span>
            <span>{domain.provider}</span>
            <span>· TTL {domain.ttl}</span>
          </div>
        </div>
        <span className={`status-badge ${meta.cls}`}><span className="s-dot" />{meta.label}</span>
      </div>

      <div className="dc-ip">
        <div>
          <div className="ip-label">Assigned {domain.record_type === 'AAAA' ? 'IPv6' : 'IPv4'}</div>
          <div className="ip-val">{runtime.ip ?? '—'}</div>
        </div>
      </div>

      <div className="dc-foot">
        <div className="dc-updated">Updated {relTime(runtime.updated)}</div>
        <div className="dc-actions">
          <button
            type="button"
            className="act-btn"
            title={domain.enabled ? 'Pause' : 'Resume'}
            onClick={() => onToggle(domain.id)}
          >
            {domain.enabled ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>
          <button type="button" className="act-btn" title="Force update now" onClick={() => onSync(domain.id)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          </button>
          <button type="button" className="act-btn" title="Edit" onClick={() => onEdit(domain.id)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          </button>
          <button type="button" className="act-btn danger" title="Delete" onClick={() => onDelete(domain.id)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
