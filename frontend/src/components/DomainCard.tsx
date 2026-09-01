import type { DomainConfig, DomainState } from '../types';
import { providerColor } from '../utils';
import { IconEdit, IconRefresh, IconTrash } from './icons';

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
  const status = runtime.status;
  const meta = STATUS_META[status] ?? STATUS_META.synced;
  const initials = domain.provider.slice(0, 2).toUpperCase();

  return (
    <div className={`domain-card${status === 'updating' ? ' updating' : ''}`}>
      <div className="dc-head">
        <div className="provider-badge" style={{ background: providerColor(domain.provider) }} title={domain.provider}>{initials}</div>
        <div className="dc-title">
          <div className="name">{domain.hostname}</div>
          <div className="meta">
            <span className="rec-type">{domain.record_type}</span>
            <span>{domain.provider}</span>
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
          <label className="switch">
            <input type="checkbox" checked={domain.enabled} onChange={() => onToggle(domain.id)} />
            <span className="slider" />
          </label>
          <button type="button" className="act-btn" title="Force update now" onClick={() => onSync(domain.id)}>
            <IconRefresh />
          </button>
          <button type="button" className="act-btn" title="Edit" onClick={() => onEdit(domain.id)}>
            <IconEdit />
          </button>
          <button type="button" className="act-btn danger" title="Delete" onClick={() => onDelete(domain.id)}>
            <IconTrash />
          </button>
        </div>
      </div>
    </div>
  );
}
