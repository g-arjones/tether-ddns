import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLiveState } from './useLiveState';
import type { StateSnapshot, LogEntry } from './types';

let instance: FakeWS | null = null;

class FakeWS {
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    // oxlint-disable-next-line no-this-alias -- test fake needs to expose the instance
    instance = this;
  }

  send(): void {}

  close(): void {
    this.closed = true;
  }
}

const snapshot: StateSnapshot = {
  public_ipv4: '203.0.113.5',
  public_ipv6: '2001:db8::5',
  ipv4_changed_at: null,
  ipv6_changed_at: null,
  online: true,
  next_check_at: null,
  reachability: {
    since: 0,
    checks: 0,
    online: 0,
    history: [],
    latest: [],
  },
  domains: [],
  settings: {
    check_interval: 300,
    ip_source: 'http',
    update_on_startup: true,
    retry_on_failure: true,
    notify: false,
  },
  logs: [],
};

const logEntry: LogEntry = {
  time: 1_700_000_000,
  level: 'INFO',
  logger: 'tether',
  message: 'hello world',
};

describe('useLiveState', () => {
  beforeEach(() => {
    instance = null;
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a websocket to /api/ws', () => {
    renderHook(() => useLiveState());
    expect(instance).not.toBeNull();
    expect(instance?.url).toContain('/api/ws');
  });

  it('uses ws:// on http pages and wss:// on https pages', () => {
    renderHook(() => useLiveState());
    expect(instance?.url.startsWith('ws://')).toBe(true);

    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, protocol: 'https:', host: 'example.com' },
      writable: true,
      configurable: true,
    });
    try {
      renderHook(() => useLiveState());
      expect(instance?.url).toBe('wss://example.com/api/ws');
    } finally {
      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  it('applies state messages to snapshot', () => {
    const { result } = renderHook(() => useLiveState());
    expect(result.current.snapshot).toBeNull();

    act(() => {
      instance?.onmessage?.({ data: JSON.stringify({ kind: 'state', payload: snapshot }) });
    });

    expect(result.current.snapshot).toEqual(snapshot);
  });

  it('appends log messages to logs', () => {
    const { result } = renderHook(() => useLiveState());
    expect(result.current.logs).toHaveLength(0);

    act(() => {
      instance?.onmessage?.({ data: JSON.stringify({ kind: 'log', payload: logEntry }) });
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0]).toEqual(logEntry);
  });

  it('caps logs at 500 entries', () => {
    const { result } = renderHook(() => useLiveState());

    act(() => {
      for (let i = 0; i < 520; i++) {
        instance?.onmessage?.({
          data: JSON.stringify({ kind: 'log', payload: { ...logEntry, time: i } }),
        });
      }
    });

    expect(result.current.logs).toHaveLength(500);
    expect(result.current.logs[result.current.logs.length - 1].time).toBe(519);
  });

  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() => useLiveState());
    const ws = instance;
    expect(ws?.closed).toBe(false);
    unmount();
    expect(ws?.closed).toBe(true);
  });
});
