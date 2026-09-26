import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CheckStatus, HealthcheckRef, HealthchecksProject, ProjectRuntime } from '../types';
import { HealthchecksPanel } from './HealthchecksPanel';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const st = (name: string, s: CheckStatus['status']): CheckStatus => ({
  name, slug: name, status: s, last_ping: NOW_MS / 1000 - 60, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60,
});
const project = (over: Partial<HealthchecksProject> = {}): HealthchecksProject => ({
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 300,
  show_on_overview: true, fetched_at: 1,
  checks: [
    { key: 'a', name: 'Backup', slug: 'backup', visible: true },
    { key: 'b', name: 'SSL', slug: 'ssl', visible: true },
    { key: 'c', name: 'Hidden', slug: 'hidden', visible: false },
    { key: 'd', name: 'Old job', slug: 'old', visible: true },
  ],
  ...over,
});
const runtime: Record<string, ProjectRuntime> = {
  p1: { polled_at: 1, ok: true, error: null, offline: false, checks: { a: st('Backup', 'up'), b: st('SSL', 'down'), c: st('Hidden', 'up') } },
};
const draw = (projects: HealthchecksProject[], rt: Record<string, ProjectRuntime> | undefined = runtime) =>
  render(<HealthchecksPanel projects={projects} runtime={rt} nowMs={NOW_MS} />).container;

describe('HealthchecksPanel', () => {
  it('renders a chip per visible check with its state and last-ping age', () => {
    const container = draw([project()]);
    const chips = [...container.querySelectorAll('.hcp-chip')];
    expect(chips.map((c) => c.className)).toEqual(['hcp-chip hc-up', 'hcp-chip hc-down', 'hcp-chip hc-gone']);
    expect(chips.map((c) => c.querySelector('.hcp-name')?.textContent)).toEqual(['up: Backup', 'down: SSL', 'gone: Old job']);
    expect(chips.map((c) => c.querySelector('.hcp-time')?.textContent)).toEqual(['1m', '1m', 'gone']);
    expect(chips[0].querySelector('.hcp-time')).not.toHaveClass('hcp-state');
    expect(chips[2].querySelector('.hcp-time')).toHaveClass('hcp-state');
    expect(chips[1]).toHaveAttribute('title', 'SSL — down · last ping 1 minute ago');
    expect(screen.queryByText('Hidden')).toBeNull();
    expect(container.querySelector('.hcp-head .hc-sum')?.textContent).toBe('1 up · 1 down · 1 gone');
  });

  it('draws one hidden-from-AT bar segment per visible check, worst first', () => {
    const bar = draw([project()]).querySelector('.hcp-bar')!;
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect([...bar.children].map((s) => s.className)).toEqual(['hc-down', 'hc-up', 'hc-gone']);
    expect(bar.classList.contains('dense')).toBe(false);
  });

  it('headlines the worst state and counts the shown checks', () => {
    const container = draw([project()]);
    expect(screen.getByRole('heading', { name: 'Healthchecks' })).toBeInTheDocument();
    const pill = container.querySelector('.panel-head .hc-pill')!;
    expect(pill.className).toBe('hc-pill hc-down');
    expect(pill.textContent).toBe('1 down');
    expect(container.querySelector('.panel-head .sub')?.textContent).toBe('1 project · 3 checks');
    expect(container.querySelector('.hcp-note')).toBeNull();
  });

  it.each([
    ['offline', { ...runtime.p1, offline: true }, 'System is offline — polling paused.', false],
    ['failed', { ...runtime.p1, ok: false, error: 'HTTP 503' }, 'Last poll failed: HTTP 503', true],
    ['failed without error', { ...runtime.p1, ok: false, error: null }, 'Last poll failed.', true],
    ['never polled', undefined, 'Waiting for first poll.', false],
  ] as const)('renders an unknown project stateless with the reason (%s)', (_, rt, text, err) => {
    const container = draw([project()], rt ? { p1: rt } : {});
    const bar = container.querySelector('.hcp-bar')!;
    expect(bar.className).toBe('hcp-bar hc-unknown');
    expect(bar.children).toHaveLength(0);
    const chips = [...container.querySelectorAll('.hcp-chip')];
    expect(chips.map((c) => c.className)).toEqual(Array(3).fill('hcp-chip hc-unknown'));
    expect(chips.map((c) => c.querySelector('.hcp-time')?.textContent)).toEqual(Array(3).fill('unknown'));
    const note = container.querySelector('.hcp-note')!;
    expect(note.textContent).toBe(text);
    expect(note.classList.contains('hcp-note-err')).toBe(err);
    expect(note).not.toHaveAttribute('role');
    expect(screen.getByText('status unknown')).toBeInTheDocument();
    expect(container.querySelector('.panel-head .hc-pill')?.textContent).toBe('unknown');
  });

  it('treats an absent runtime snapshot as unknown for every visible check', () => {
    const container = render(<HealthchecksPanel projects={[project()]} runtime={undefined} nowMs={NOW_MS} />).container;
    expect(container.querySelectorAll('.hcp-chip.hc-unknown')).toHaveLength(3);
    expect(container.querySelector('.hcp-note')).toHaveTextContent('Waiting for first poll.');
  });

  it('packs the bar without gaps only above 40 checks', () => {
    const many = (n: number): HealthchecksProject => {
      const refs: HealthcheckRef[] = Array.from({ length: n }, (_, i) => ({ key: `k${i}`, name: `Job ${i}`, slug: `k${i}`, visible: true }));
      return project({ checks: refs });
    };
    const allUp = (n: number) => ({
      p1: { ...runtime.p1, checks: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, st(`Job ${i}`, 'up')])) },
    });
    expect(draw([many(40)], allUp(40)).querySelector('.hcp-bar')?.classList.contains('dense')).toBe(false);
    expect(draw([many(41)], allUp(41)).querySelector('.hcp-bar')?.classList.contains('dense')).toBe(true);
  });

  it('renders one block per shown project and pluralises the header', () => {
    const second = project({ id: 'p2', name: 'VPS', checks: [{ key: 'x', name: 'Uptime', slug: 'up', visible: true }] });
    const rt = { ...runtime, p2: { ...runtime.p1, checks: { x: st('Uptime', 'up') } } };
    const container = draw([project(), second], rt);
    expect([...container.querySelectorAll('.hcp-proj .hcp-head strong')].map((s) => s.textContent)).toEqual(['Homelab', 'VPS']);
    expect(container.querySelector('.panel-head .sub')?.textContent).toBe('2 projects · 4 checks');
  });

  it('is omitted when no project has visible checks on the Overview', () => {
    const container = draw([project({ show_on_overview: false }), project({ id: 'p2', checks: [] })]);
    expect(container.firstChild).toBeNull();
  });

  it('prefers the live upstream name over the fetched one', () => {
    const renamed = { p1: { ...runtime.p1, checks: { ...runtime.p1.checks, a: st('Nightly backup', 'up') } } };
    draw([project()], renamed);
    expect(screen.getByText('Nightly backup')).toBeInTheDocument();
  });
});
