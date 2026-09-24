import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordHealthPanel } from './RecordHealthPanel';
import type { DomainState } from '../types';

const domains: DomainState[] = [
  { id: 'a', status: 'synced', ip: '1.2.3.4', updated: 1, message: '' },
  { id: 'b', status: 'error', ip: null, updated: 1, message: '' },
];

describe('RecordHealthPanel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders the domain count and legend counts', () => {
    render(<RecordHealthPanel domains={domains} enabledById={{ a: true, b: true }} nextCheckAt={null} checkInterval={300} />);
    expect(screen.getByText('2 domains')).toBeInTheDocument();
  });

  it('shows a dash countdown when nextCheckAt is null', () => {
    render(<RecordHealthPanel domains={domains} enabledById={{}} nextCheckAt={null} checkInterval={300} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('counts down from nextCheckAt', () => {
    const now = 1_000_000;
    vi.setSystemTime(now);
    render(<RecordHealthPanel domains={domains} enabledById={{}} nextCheckAt={now / 1000 + 65} checkInterval={300} />);
    expect(screen.getByText('1:05')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('1:04')).toBeInTheDocument();
  });

  it('renders one bar segment per non-empty status and every legend entry', () => {
    const { container } = render(
      <RecordHealthPanel domains={domains} enabledById={{ a: true, b: true }} nextCheckAt={null} checkInterval={300} />,
    );
    const bar = [...container.querySelectorAll<HTMLElement>('.health-bar span')];
    expect(bar.map((s) => s.title)).toEqual(['1 synced', '1 error']);
    expect(bar.map((s) => s.style.background)).toEqual(['var(--ok)', 'var(--err)']);
    const legend = [...container.querySelectorAll('.hl-item')].map((el) => [
      el.querySelector('.hl-label')?.textContent,
      el.querySelector('.hl-count')?.textContent,
    ]);
    expect(legend).toEqual([['Synced', '1'], ['Pending', '0'], ['Error', '1'], ['Paused', '0']]);
  });
});
