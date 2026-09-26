import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { domainDeleteCopy, hookDeleteCopy, projectDeleteCopy } from './deleteCopy';
import type { DomainConfig, HealthchecksProject, HookConfig } from './types';

const text = (body: ReactNode) => render(<p>{body}</p>).container.textContent;

const domain: DomainConfig = {
  id: 'd1', hostname: 'home.example.com', provider: 'cloudflare', record_type: 'A', enabled: true,
};
const hook: HookConfig = { id: 'h1', hook: 'log', events: ['ip_changed', 'update_failed'] };
const project: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://hc.example.net/', api_key: '****',
  poll_interval: 60, show_on_overview: true, fetched_at: null, checks: [],
};

describe('domainDeleteCopy', () => {
  it('names the hostname and the provider it leaves untouched', () => {
    const copy = domainDeleteCopy(domain, [{ key: 'cloudflare', display_name: 'Cloudflare', schema: {} }]);
    expect(copy.title).toBe('Delete domain');
    expect(copy.confirmLabel).toBe('Delete domain');
    expect(text(copy.body)).toBe(
      'home.example.com will stop being updated. Its settings, including credentials, are ' +
      'removed and must be re-entered to add it again. The DNS record at Cloudflare is not changed.',
    );
  });

  it('falls back to the raw provider key', () => {
    expect(text(domainDeleteCopy(domain, []).body)).toContain('The DNS record at cloudflare is not changed.');
  });
});

describe('hookDeleteCopy', () => {
  it('names the hook and lists its events as code', () => {
    const copy = hookDeleteCopy(hook, [{ key: 'log', display_name: 'Log Event', events: [], schema: {} }]);
    expect(copy.title).toBe('Delete hook');
    expect(copy.confirmLabel).toBe('Delete hook');
    expect(text(copy.body)).toBe(
      'Log Event (ip_changed, update_failed) will no longer run. Its settings, including any ' +
      'secrets, are removed and must be re-entered to add it again.',
    );
    const { container } = render(<p>{copy.body}</p>);
    expect([...container.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['ip_changed', 'update_failed']);
  });

  it('falls back to the raw hook key and says when there are no events', () => {
    expect(text(hookDeleteCopy({ ...hook, events: [] }, []).body)).toMatch(/^log \(no events\) will no longer run\./);
  });
});

describe('projectDeleteCopy', () => {
  it('names the project and the host whose checks it leaves untouched', () => {
    const copy = projectDeleteCopy(project);
    expect(copy.title).toBe('Delete project');
    expect(copy.confirmLabel).toBe('Delete project');
    expect(text(copy.body)).toBe(
      'Homelab will no longer be polled or shown. Its API key is removed and must be re-entered ' +
      'to add it again. Checks on hc.example.net are not changed.',
    );
  });
});
