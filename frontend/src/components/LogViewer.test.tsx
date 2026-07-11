import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LogViewer } from './LogViewer';
import type { LogEntry } from '../types';

function makeLogs(n: number): LogEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    time: 1700000000 + i, level: 'INFO', logger: 'tether_ddns', message: `line ${i}`,
  }));
}

describe('LogViewer', () => {
  it('follows to the bottom when at the bottom', () => {
    const { rerender } = render(<LogViewer logs={makeLogs(3)} />);
    const el = screen.getByTestId('log-viewer');
    // jsdom has no layout; simulate a scrolled-to-bottom element.
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    el.scrollTop = 800; // at bottom (1000 - 800 - 200 = 0)
    rerender(<LogViewer logs={makeLogs(6)} />);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it('does not follow when scrolled up', () => {
    const { rerender } = render(<LogViewer logs={makeLogs(3)} />);
    const el = screen.getByTestId('log-viewer');
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    el.scrollTop = 100; // scrolled up (gap 700 > 40)
    el.dispatchEvent(new Event('scroll'));
    rerender(<LogViewer logs={makeLogs(6)} />);
    expect(el.scrollTop).toBe(100);
  });
});
