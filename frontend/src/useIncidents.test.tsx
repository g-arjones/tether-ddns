import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useIncidents } from './useIncidents';
import type { IncidentWindow } from './types';

const EMPTY: IncidentWindow = { monitoring_since: 0, rev: 1, incidents: [], ongoing: null };

afterEach(() => { vi.restoreAllMocks(); });

describe('useIncidents', () => {
  test('fetches the window on mount', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { result } = renderHook(
      ({ rev, generation }) => useIncidents(rev, generation),
      { initialProps: { rev: 1, generation: 0 } },
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('refetches when rev changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { rerender } = renderHook(
      ({ rev, generation }) => useIncidents(rev, generation),
      { initialProps: { rev: 1, generation: 0 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ rev: 2, generation: 0 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('refetches when rev resets after a server restart', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { rerender } = renderHook(
      ({ rev, generation }) => useIncidents(rev, generation),
      { initialProps: { rev: 9, generation: 0 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ rev: 0, generation: 0 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('does not refetch when rev is unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { rerender } = renderHook(
      ({ rev, generation }) => useIncidents(rev, generation),
      { initialProps: { rev: 3, generation: 0 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ rev: 3, generation: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('refetches after a reconnect even when rev is unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { rerender } = renderHook(
      ({ rev, generation }) => useIncidents(rev, generation),
      { initialProps: { rev: 3, generation: 0 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ rev: 3, generation: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
