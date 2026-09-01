import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDelayedFlag } from './useDelayedFlag';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useDelayedFlag', () => {
  it('stays false while the delay has not elapsed', () => {
    const { result } = renderHook(({ active }) => useDelayedFlag(active, 1500), {
      initialProps: { active: true },
    });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1499); });
    expect(result.current).toBe(false);
  });

  it('becomes true once the delay elapses', () => {
    const { result } = renderHook(({ active }) => useDelayedFlag(active, 1500), {
      initialProps: { active: true },
    });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(result.current).toBe(true);
  });

  it('never fires when active clears inside the delay', () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 1500), {
      initialProps: { active: true },
    });
    act(() => { vi.advanceTimersByTime(1000); });
    rerender({ active: false });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current).toBe(false);
  });

  it('clears immediately when active goes false', () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 1500), {
      initialProps: { active: true },
    });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
