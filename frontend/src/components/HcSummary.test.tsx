import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CheckStatus, HealthcheckRef, ProjectRuntime } from '../types';
import { HcSummary } from './HcSummary';

const st = (s: CheckStatus['status']): CheckStatus => ({
  name: 'x', slug: 'x', status: s, last_ping: null, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60,
});
const refs: HealthcheckRef[] = ['a', 'b', 'c'].map((key) => ({ key, name: key, slug: key, visible: true }));
const good: ProjectRuntime = { polled_at: 1, ok: true, error: null, offline: false, checks: { a: st('up'), b: st('down') } };

describe('HcSummary', () => {
  it('lists counts and highlights down', () => {
    const { container } = render(<HcSummary refs={refs} runtime={good} />);
    expect(container.textContent).toBe('1 up · 1 down · 1 gone');
    expect(container.querySelector('b.hc-s-down')).toHaveTextContent('1 down');
  });

  it('appends the total when asked', () => {
    const { container } = render(<HcSummary refs={refs} runtime={good} withTotal />);
    expect(container.textContent).toBe('1 up · 1 down · 1 gone · 3 checks');
  });

  it('reads status unknown when the poll is not good', () => {
    const { container } = render(<HcSummary refs={refs} runtime={{ ...good, offline: true }} withTotal />);
    expect(container.textContent).toBe('3 checks · status unknown');
  });
});
