import { describe, it, expect } from 'vitest';
import { formatInterval } from './utils';

describe('formatInterval', () => {
  it('formats seconds as minutes', () => {
    expect(formatInterval(300)).toBe('5 min');
    expect(formatInterval(1800)).toBe('30 min');
  });

  it('formats whole hours as hours', () => {
    expect(formatInterval(3600)).toBe('1 hr');
  });
});
