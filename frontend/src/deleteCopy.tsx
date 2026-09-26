import { Fragment, type ReactNode } from 'react';
import type { DomainConfig, HealthchecksProject, HookConfig, HookDef, Provider } from './types';
import { hostOf } from './utils';

export interface DeleteCopy {
  title: string;
  confirmLabel: string;
  body: ReactNode;
}

export function domainDeleteCopy(domain: DomainConfig, providers: Provider[]): DeleteCopy {
  const provider = providers.find((p) => p.key === domain.provider)?.display_name ?? domain.provider;
  return {
    title: 'Delete domain',
    confirmLabel: 'Delete domain',
    body: (
      <>
        <strong>{domain.hostname}</strong> will stop being updated. Its settings, including
        credentials, are removed and must be re-entered to add it again. The DNS record at{' '}
        <strong>{provider}</strong> is not changed.
      </>
    ),
  };
}

export function hookDeleteCopy(hook: HookConfig, hookDefs: HookDef[]): DeleteCopy {
  const name = hookDefs.find((d) => d.key === hook.hook)?.display_name ?? hook.hook;
  const events = hook.events.length === 0
    ? 'no events'
    : hook.events.map((e, i) => (
      <Fragment key={e}>{i > 0 ? ', ' : ''}<code>{e}</code></Fragment>
    ));
  return {
    title: 'Delete hook',
    confirmLabel: 'Delete hook',
    body: (
      <>
        <strong>{name}</strong> ({events}) will no longer run. Its settings, including any
        secrets, are removed and must be re-entered to add it again.
      </>
    ),
  };
}

export function projectDeleteCopy(project: HealthchecksProject): DeleteCopy {
  return {
    title: 'Delete project',
    confirmLabel: 'Delete project',
    body: (
      <>
        <strong>{project.name}</strong> will no longer be polled or shown. Its API key is removed
        and must be re-entered to add it again. Checks on{' '}
        <strong>{hostOf(project.base_url)}</strong> are not changed.
      </>
    ),
  };
}
