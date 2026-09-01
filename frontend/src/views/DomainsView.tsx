import type { JSX } from 'react';
import type { DomainConfig, DomainState } from '../types';
import { DomainCard } from '../components/DomainCard';
import { IconGlobe, IconPlus } from '../components/icons';

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
          <IconPlus strokeWidth={2.5} />
          Add Domain
        </button>
      </div>
      {domains.length === 0 ? (
        <div className="empty">
          <IconGlobe strokeWidth={1.5} />
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
