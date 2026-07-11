import { describe, it, expect } from 'vitest';
import { formatInterval } from './App';

describe('formatInterval', () => {
  it('formats seconds as minutes', () => {
    expect(formatInterval(300)).toBe('5m');
    expect(formatInterval(1800)).toBe('30m');
  });

  it('formats whole hours as hours', () => {
    expect(formatInterval(3600)).toBe('1h');
  });
});
