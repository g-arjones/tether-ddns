import type { DomainConfig, DomainState } from '../types';
import { DomainCard } from '../components/DomainCard';

export interface DomainsViewProps {
  domains: DomainConfig[];
  runtimeById: Map<string, DomainState>;
  onAdd: () => void;
  onSync: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}

export function DomainsView({
  domains,
  runtimeById,
  onAdd,
  onSync,
  onEdit,
  onDelete,
  onToggle,
}: DomainsViewProps): JSX.Element {
  const count = domains.length;
  const recordLabel = count === 1 ? 'record' : 'records';

  return (
    <>
      <div className="section-head">
        <h3>Domains</h3>
        <span className="count-badge">{count} {recordLabel}</span>
        <div className="spacer"></div>
        <button className="btn btn-primary" onClick={onAdd}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Add Domain
        </button>
      </div>
      {domains.length === 0 ? (
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>
          </svg>
          <h3>No domains yet</h3>
          <p>Add your first domain to get started.</p>
        </div>
      ) : (
        <div className="domain-grid">
          {domains.map((domain) => {
            const runtime = runtimeById.get(domain.id) ?? {
              id: domain.id,
              status: 'pending',
              ip: null,
              updated: null,
              message: '',
            };
            return (
              <DomainCard
                key={domain.id}
                domain={domain}
                runtime={runtime}
                onSync={onSync}
                onEdit={onEdit}
                onDelete={onDelete}
                onToggle={onToggle}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
