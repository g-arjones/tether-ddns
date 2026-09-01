import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveConnection, type ConnectionStatus, type Envelope } from './liveConnection';

class FakeWS {
  static instances: FakeWS[] = [];
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }

  // Test helpers
  fireOpen(): void { this.readyState = 1; this.onopen?.(); }
  fireMessage(kind: string, payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ kind, payload }) });
  }
  fireClose(): void { this.readyState = 3; this.onclose?.(); }
}

const last = (): FakeWS => {
  const ws = FakeWS.instances[FakeWS.instances.length - 1];
  if (!ws) throw new Error('no socket was created');
  return ws;
};

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LiveConnection lifecycle', () => {
  it('connects to /api/ws on start', () => {
    const conn = new LiveConnection();
    conn.start();
    expect(FakeWS.instances).toHaveLength(1);
    expect(last().url).toContain('/api/ws');
    conn.stop();
  });

  it('uses an explicitly provided url', () => {
    const conn = new LiveConnection({ url: 'wss://example.com/api/ws' });
    conn.start();
    expect(last().url).toBe('wss://example.com/api/ws');
    conn.stop();
  });

  it('reports connecting before the first open and open afterwards', () => {
    const seen: ConnectionStatus[] = [];
    const conn = new LiveConnection();
    conn.on('status', (s) => seen.push(s));
    conn.start();
    expect(conn.status).toBe('connecting');
    last().fireOpen();
    expect(conn.status).toBe('open');
    expect(seen).toContain('open');
    conn.stop();
  });

  it('emits connected with generation 0 on the first open', () => {
    const seen: number[] = [];
    const conn = new LiveConnection();
    conn.on('connected', (g) => seen.push(g));
    conn.start();
    last().fireOpen();
    expect(seen).toEqual([0]);
    expect(conn.generation).toBe(0);
    conn.stop();
  });

  it('emits parsed envelopes for inbound messages', () => {
    const seen: Envelope[] = [];
    const conn = new LiveConnection();
    conn.on('message', (e) => seen.push(e));
    conn.start();
    last().fireOpen();
    last().fireMessage('state', { online: true });
    expect(seen).toEqual([{ kind: 'state', payload: { online: true } }]);
    conn.stop();
  });

  it('ignores malformed frames instead of throwing', () => {
    const seen: Envelope[] = [];
    const conn = new LiveConnection();
    conn.on('message', (e) => seen.push(e));
    conn.start();
    last().fireOpen();
    expect(() => last().onmessage?.({ data: 'not json' })).not.toThrow();
    expect(seen).toHaveLength(0);
    conn.stop();
  });

  it('stops delivering to a listener after it unsubscribes', () => {
    const seen: Envelope[] = [];
    const conn = new LiveConnection();
    const off = conn.on('message', (e) => seen.push(e));
    conn.start();
    last().fireOpen();
    off();
    last().fireMessage('state', {});
    expect(seen).toHaveLength(0);
    conn.stop();
  });

  it('stop() closes the socket and never reconnects', () => {
    const conn = new LiveConnection();
    conn.start();
    const ws = last();
    ws.fireOpen();
    conn.stop();
    expect(ws.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});

describe('LiveConnection backoff', () => {
  it('reconnects after a close, at the minimum delay first', () => {
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.start();
    last().fireOpen();
    last().fireClose();
    vi.advanceTimersByTime(499);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(2);
    conn.stop();
  });

  it('grows the delay by the backoff factor on repeated failures', () => {
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.start();
    last().fireOpen();

    last().fireClose();
    vi.advanceTimersByTime(500);
    expect(FakeWS.instances).toHaveLength(2);

    last().fireClose();
    vi.advanceTimersByTime(849);
    expect(FakeWS.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(3);
    conn.stop();
  });

  it('caps the delay at the maximum', () => {
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.start();
    last().fireOpen();
    for (let i = 0; i < 20; i++) {
      last().fireClose();
      vi.advanceTimersByTime(15_000);
    }
    const before = FakeWS.instances.length;
    last().fireClose();
    vi.advanceTimersByTime(15_000);
    expect(FakeWS.instances).toHaveLength(before + 1);
    conn.stop();
  });

  it('applies jitter within the configured ratio', () => {
    const low = new LiveConnection({ random: () => 0 });
    low.start();
    last().fireOpen();
    last().fireClose();
    vi.advanceTimersByTime(399);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(2);
    low.stop();

    FakeWS.instances = [];
    const high = new LiveConnection({ random: () => 1 });
    high.start();
    last().fireOpen();
    last().fireClose();
    vi.advanceTimersByTime(599);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(2);
    high.stop();
  });

  it('resets the delay after a successful open', () => {
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.start();
    last().fireOpen();
    last().fireClose();
    vi.advanceTimersByTime(500);
    last().fireClose();
    vi.advanceTimersByTime(850);
    expect(FakeWS.instances).toHaveLength(3);

    last().fireOpen();
    last().fireClose();
    vi.advanceTimersByTime(500);
    expect(FakeWS.instances).toHaveLength(4);
    conn.stop();
  });

  it('stays in connecting status until the first open, then reconnecting', () => {
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.start();
    last().fireClose();
    expect(conn.status).toBe('connecting');
    vi.advanceTimersByTime(500);
    last().fireOpen();
    last().fireClose();
    expect(conn.status).toBe('reconnecting');
    conn.stop();
  });

  it('increments generation on every reopen after the first', () => {
    const seen: number[] = [];
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.on('connected', (g) => seen.push(g));
    conn.start();
    last().fireOpen();
    last().fireClose();
    vi.advanceTimersByTime(500);
    last().fireOpen();
    expect(seen).toEqual([0, 1]);
    expect(conn.generation).toBe(1);
    conn.stop();
  });
});

describe('LiveConnection heartbeat', () => {
  it('does not ping before the socket opens', () => {
    const conn = new LiveConnection();
    conn.start();
    vi.advanceTimersByTime(30_000);
    expect(last().sent).toHaveLength(0);
    conn.stop();
  });

  it('sends a ping every 10s while open', () => {
    const conn = new LiveConnection();
    conn.start();
    last().fireOpen();
    vi.advanceTimersByTime(10_000);
    expect(last().sent).toEqual(['ping']);
    vi.advanceTimersByTime(10_000);
    expect(last().sent).toEqual(['ping', 'ping']);
    conn.stop();
  });

  it('force-reconnects after 25s of silence even while readyState is OPEN', () => {
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.start();
    const zombie = last();
    zombie.fireOpen();
    expect(zombie.readyState).toBe(1);

    vi.advanceTimersByTime(30_000);
    expect(zombie.closed).toBe(true);

    vi.advanceTimersByTime(500);
    expect(FakeWS.instances.length).toBeGreaterThan(1);
    conn.stop();
  });

  it('treats any inbound frame as proof of life', () => {
    const conn = new LiveConnection();
    conn.start();
    const ws = last();
    ws.fireOpen();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20_000);
      ws.fireMessage('pong', null);
    }
    expect(ws.closed).toBe(false);
    conn.stop();
  });

  it('stops pinging once the socket has closed', () => {
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.start();
    const first = last();
    first.fireOpen();
    first.fireClose();
    const sentAtClose = first.sent.length;
    vi.advanceTimersByTime(30_000);
    expect(first.sent).toHaveLength(sentAtClose);
    conn.stop();
  });
});

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state, writable: true, configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('LiveConnection resume', () => {
  it('reconnects immediately when the page becomes visible and the socket is down', () => {
    const conn = new LiveConnection({ random: () => 0.5, maxBackoffMs: 60_000 });
    conn.start();
    last().fireOpen();
    last().fireClose();
    expect(FakeWS.instances).toHaveLength(1);

    setVisibility('visible');
    expect(FakeWS.instances).toHaveLength(2);
    conn.stop();
  });

  it('force-reconnects on resume when readyState still claims OPEN but the socket is stale', () => {
    const conn = new LiveConnection({ random: () => 0.5 });
    conn.start();
    const zombie = last();
    zombie.fireOpen();

    // Simulate a suspended tab: time passes while timers are frozen.
    vi.setSystemTime(Date.now() + 600_000);
    expect(zombie.readyState).toBe(1);

    setVisibility('visible');
    expect(zombie.closed).toBe(true);
    conn.stop();
  });

  it('does nothing on resume while the socket is healthy', () => {
    const conn = new LiveConnection();
    conn.start();
    const ws = last();
    ws.fireOpen();
    setVisibility('visible');
    expect(ws.closed).toBe(false);
    expect(FakeWS.instances).toHaveLength(1);
    conn.stop();
  });

  it('ignores visibilitychange when the page went hidden', () => {
    const conn = new LiveConnection();
    conn.start();
    last().fireOpen();
    last().fireClose();
    setVisibility('hidden');
    expect(FakeWS.instances).toHaveLength(1);
    conn.stop();
  });

  it('reconnects on the window online event', () => {
    const conn = new LiveConnection({ random: () => 0.5, maxBackoffMs: 60_000 });
    conn.start();
    last().fireOpen();
    last().fireClose();
    window.dispatchEvent(new Event('online'));
    expect(FakeWS.instances).toHaveLength(2);
    conn.stop();
  });

  it('removes its listeners on stop', () => {
    const conn = new LiveConnection();
    conn.start();
    last().fireOpen();
    conn.stop();
    const count = FakeWS.instances.length;
    setVisibility('visible');
    window.dispatchEvent(new Event('online'));
    expect(FakeWS.instances).toHaveLength(count);
  });

  it('cancels a pending retry timer and reconnects immediately on resume', () => {
    const conn = new LiveConnection({ random: () => 0.5, maxBackoffMs: 60_000 });
    conn.start();
    last().fireOpen();
    last().fireClose();
    expect(FakeWS.instances).toHaveLength(1);

    // A retry is now scheduled at ~500ms, but has not fired yet.
    vi.advanceTimersByTime(300);
    expect(FakeWS.instances).toHaveLength(1);

    // Resume before the retry fires.
    setVisibility('visible');
    expect(FakeWS.instances).toHaveLength(2);

    // Advance past the original delay and confirm no extra socket was created.
    vi.advanceTimersByTime(300);
    expect(FakeWS.instances).toHaveLength(2);
    conn.stop();
  });
});
