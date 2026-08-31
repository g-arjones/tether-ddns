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
