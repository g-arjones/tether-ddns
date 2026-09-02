import type { JSX } from 'react';
import type { DomainConfig, DomainState } from '../types';
import { DomainCard } from '../components/DomainCard';
import { EmptyState } from '../components/EmptyState';
import { SectionHeader } from '../components/SectionHeader';
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

  return (
    <>
      <SectionHeader
        title="Domains"
        count={{ n: count, noun: 'record' }}
        action={(
          <button className="btn btn-primary" onClick={onAdd}>
            <IconPlus strokeWidth={2.5} />
            Add Domain
          </button>
        )}
      />
      {domains.length === 0 ? (
        <EmptyState icon={<IconGlobe strokeWidth={1.5} />} title="No domains yet">
          Add your first domain to get started.
        </EmptyState>
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
