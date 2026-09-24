import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { HealthBar, type HealthSegment } from './HealthBar';

const segments: HealthSegment[] = [
  { key: 'a', label: 'Alpha', color: 'red', value: 3, title: '3 alpha', legend: 3 },
  { key: 'b', label: 'Beta', color: 'blue', value: 0, title: '0 beta', legend: 0 },
  { key: 'c', label: 'Gamma', color: 'green', value: 1, title: '1 gamma', legend: 'one' },
];

function barSpans(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.health-bar span')];
}

describe('HealthBar', () => {
  test('draws only non-empty segments, weighted by value', () => {
    const { container } = render(<HealthBar segments={segments} />);
    const bar = barSpans(container);
    expect(bar.map((s) => s.style.flexGrow)).toEqual(['3', '1']);
    expect(bar.map((s) => s.style.background)).toEqual(['red', 'green']);
  });

  test('gives every drawn segment its tooltip', () => {
    const { container } = render(<HealthBar segments={segments} />);
    expect(barSpans(container).map((s) => s.title)).toEqual(['3 alpha', '1 gamma']);
  });

  test('lists every segment in the legend, including empty ones, in order', () => {
    const { container } = render(<HealthBar segments={segments} />);
    const legend = [...container.querySelectorAll('.hl-item')].map((el) => [
      el.querySelector('.hl-label')?.textContent,
      el.querySelector('.hl-count')?.textContent,
      (el.querySelector('.hl-dot') as HTMLElement).style.background,
    ]);
    expect(legend).toEqual([
      ['Alpha', '3', 'red'],
      ['Beta', '0', 'blue'],
      ['Gamma', 'one', 'green'],
    ]);
  });

  test('draws an empty track when nothing has a value', () => {
    const empty = segments.map((s) => ({ ...s, value: 0 }));
    const { container } = render(<HealthBar segments={empty} />);
    const bar = barSpans(container);
    expect(bar).toHaveLength(1);
    expect(bar[0].style.background).toBe('var(--surface-2)');
    expect(bar[0].hasAttribute('title')).toBe(false);
  });
});
