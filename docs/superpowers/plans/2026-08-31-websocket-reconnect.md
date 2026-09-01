# WebSocket Reconnection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's WebSocket reconnect automatically after background suspension or network loss, block the UI while disconnected, and fully resync on reconnect.

**Architecture:** A plain-TypeScript `LiveConnection` class owns socket lifecycle, exponential backoff, a client-driven heartbeat, and a staleness watchdog; `useLiveState` becomes a thin React adapter over it. Each successful open increments a `generation` counter that drives a full config/incident refetch. A blocking `ConnectionOverlay` appears after a 1.5s grace period whenever the connection is not open.

**Tech Stack:** React 19, TypeScript, Vite, Vitest + @testing-library/react, Playwright 1.61, FastAPI/Starlette WebSockets, pytest.

**Spec:** `docs/superpowers/specs/2026-08-31-websocket-reconnect-design.md`

## Global Constraints

- Heartbeat ping interval: **10s**. Watchdog tick: **5s**. Staleness threshold: **25s**.
- Backoff: min **500ms**, factor **1.7**, cap **15s**, jitter **±20%**, retries **forever**.
- Overlay grace period: **1.5s**.
- Overlay label copy: exactly `Connecting…` (never opened) / `Reconnecting…` (opened before). Note the single-character ellipsis `…`, not three periods.
- All new CSS class names MUST be prefixed `conn-`. Generic names collide with global utility classes in `styles.css` (`.empty` carries `padding: 60px 20px`) and jsdom cannot detect it.
- Python: every test function needs a one-line docstring ending with a period (flake8 D103). Imports strictly alphabetical (I101). Single quotes. Max line length 99.
- Python gates run over BOTH `tether_ddns/` and `test/`: `flake8 test/ tether_ddns/`, `mypy .`, `pyright`, `ruff check`.
- Backend coverage gate: `pytest test/ --cov=tether_ddns --cov-fail-under=90`.
- Frontend coverage thresholds (from `vite.config.ts`): lines 70, statements 70, functions 50, branches 60. `src/App.tsx` is **excluded** from coverage; `src/liveConnection.ts` will **not** be.
- Frontend lint is oxlint and runs automatically as `pretest`.
- **Type-check gate:** `npm test` runs Vitest and oxlint, NEITHER of which type-checks. Any task that changes a prop, signature, or exported type MUST also run `npx tsc --noEmit -p tsconfig.app.json` from `frontend/` and it must exit 0. A type break otherwise rides through every gate undetected until `npm run build`.
- Never introduce a new runtime dependency.

---

### Task 1: Server answers the heartbeat

**Files:**
- Modify: `tether_ddns/api.py:293-297`
- Test: `test/unit/test_api.py`

**Interfaces:**
- Consumes: nothing.
- Produces: the WebSocket at `/api/ws` replies to the client text frame `ping` with the JSON envelope `{'kind': 'pong', 'payload': None}`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/test_api.py`, immediately after `test_refresh_and_websocket`:

```python
def test_websocket_answers_ping_with_pong(tmp_path: Path) -> None:
    """The websocket replies to a client ping with a pong envelope."""
    kinds: list[str] = []
    with _client(tmp_path) as client:
        with client.websocket_connect('/api/ws') as ws:
            ws.send_text('ping')
            while len(kinds) < 200:
                message: dict[str, object] = ws.receive_json()
                kinds.append(str(message['kind']))
                if message['kind'] == 'pong':
                    assert message['payload'] is None
                    break
    assert 'pong' in kinds
```

The drain loop is required: on connect the server sends a `state` envelope followed by one `log` envelope per buffered record, so the pong is not the first message.

- [ ] **Step 2: Run test to verify it fails**

Run: `source .venv/bin/activate && pytest test/unit/test_api.py::test_websocket_answers_ping_with_pong -v`
Expected: FAIL — the loop drains 200 messages without a pong, or blocks and is killed. If it hangs, that also counts as red; proceed.

- [ ] **Step 3: Write minimal implementation**

In `tether_ddns/api.py`, replace the body of the `try` block in `ws_endpoint`:

```python
        app.state.manager.register(ws)
        try:
            while True:
                if await ws.receive_text() == 'ping':
                    await ws.send_json({'kind': 'pong', 'payload': None})
        except WebSocketDisconnect:
            app.state.manager.disconnect(ws)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_api.py -v -k 'websocket'`
Expected: PASS, both `test_refresh_and_websocket` and `test_websocket_answers_ping_with_pong`.

- [ ] **Step 5: Run the Python gates**

Run: `flake8 test/ tether_ddns/ && mypy . && pyright && ruff check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/api.py test/unit/test_api.py
git commit -m "feat(api): reply to websocket ping with pong"
```

---

### Task 2: `LiveConnection` core lifecycle

**Files:**
- Create: `frontend/src/liveConnection.ts`
- Test: `frontend/src/liveConnection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';
export interface Envelope { kind: string; payload: unknown }
export interface LiveConnectionOptions {
  url?: string;
  pingIntervalMs?: number;
  watchdogTickMs?: number;
  staleAfterMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  backoffFactor?: number;
  jitterRatio?: number;
  random?: () => number;
}
export class LiveConnection {
  constructor(options?: LiveConnectionOptions);
  get status(): ConnectionStatus;
  get generation(): number;
  on(event: 'status', listener: (status: ConnectionStatus) => void): () => void;
  on(event: 'message', listener: (envelope: Envelope) => void): () => void;
  on(event: 'connected', listener: (generation: number) => void): () => void;
  start(): void;
  stop(): void;
}
```

`on()` returns an unsubscribe function. `generation` is `0` before any connection and the **first** successful open leaves it at `0`; each subsequent open increments it.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/liveConnection.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/liveConnection.test.ts`
Expected: FAIL — cannot resolve `./liveConnection`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/liveConnection.ts`:

```ts
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

export interface Envelope {
  kind: string;
  payload: unknown;
}

export interface LiveConnectionOptions {
  url?: string;
  pingIntervalMs?: number;
  watchdogTickMs?: number;
  staleAfterMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  backoffFactor?: number;
  jitterRatio?: number;
  random?: () => number;
}

type StatusListener = (status: ConnectionStatus) => void;
type MessageListener = (envelope: Envelope) => void;
type ConnectedListener = (generation: number) => void;

const SOCKET_OPEN = 1;

function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/ws`;
}

export class LiveConnection {
  private readonly options: Required<Omit<LiveConnectionOptions, 'url'>> & { url?: string };
  private socket: WebSocket | null = null;
  private statusValue: ConnectionStatus = 'connecting';
  private generationValue = 0;
  private hasConnected = false;
  private stopped = true;

  private statusListeners = new Set<StatusListener>();
  private messageListeners = new Set<MessageListener>();
  private connectedListeners = new Set<ConnectedListener>();

  constructor(options: LiveConnectionOptions = {}) {
    this.options = {
      url: options.url,
      pingIntervalMs: options.pingIntervalMs ?? 10_000,
      watchdogTickMs: options.watchdogTickMs ?? 5_000,
      staleAfterMs: options.staleAfterMs ?? 25_000,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 15_000,
      backoffFactor: options.backoffFactor ?? 1.7,
      jitterRatio: options.jitterRatio ?? 0.2,
      random: options.random ?? Math.random,
    };
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  on(event: 'status', listener: StatusListener): () => void;
  on(event: 'message', listener: MessageListener): () => void;
  on(event: 'connected', listener: ConnectedListener): () => void;
  on(
    event: 'status' | 'message' | 'connected',
    listener: StatusListener | MessageListener | ConnectedListener,
  ): () => void {
    if (event === 'status') {
      const fn = listener as StatusListener;
      this.statusListeners.add(fn);
      return () => { this.statusListeners.delete(fn); };
    }
    if (event === 'message') {
      const fn = listener as MessageListener;
      this.messageListeners.add(fn);
      return () => { this.messageListeners.delete(fn); };
    }
    const fn = listener as ConnectedListener;
    this.connectedListeners.add(fn);
    return () => { this.connectedListeners.delete(fn); };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardownSocket();
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.statusValue === next) return;
    this.statusValue = next;
    for (const listener of this.statusListeners) listener(next);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.options.url ?? defaultUrl());
    this.socket = ws;
    ws.onopen = () => { this.handleOpen(); };
    ws.onmessage = (event: MessageEvent) => { this.handleMessage(event); };
    ws.onclose = () => { this.handleDrop(); };
    ws.onerror = () => { this.handleDrop(); };
  }

  private handleOpen(): void {
    if (this.hasConnected) this.generationValue += 1;
    this.hasConnected = true;
    this.setStatus('open');
    for (const listener of this.connectedListeners) listener(this.generationValue);
  }

  private handleMessage(event: MessageEvent): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(String(event.data)) as Envelope;
    } catch {
      return;
    }
    for (const listener of this.messageListeners) listener(envelope);
  }

  private handleDrop(): void {
    if (this.stopped) return;
    this.setStatus(this.hasConnected ? 'reconnecting' : 'connecting');
  }

  /** Detaches handlers before closing so the old socket cannot schedule work. */
  private teardownSocket(): void {
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState !== 3) ws.close();
  }
}
```

Note: `handleDrop` does not yet reconnect — Task 3 adds that. Every test in this task's suite is passable without reconnection.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/liveConnection.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/liveConnection.ts frontend/src/liveConnection.test.ts
git commit -m "feat(frontend): add LiveConnection socket lifecycle core"
```

---

### Task 3: Reconnect with exponential backoff and jitter

**Files:**
- Modify: `frontend/src/liveConnection.ts`
- Test: `frontend/src/liveConnection.test.ts`

**Interfaces:**
- Consumes: `LiveConnection` from Task 2.
- Produces: automatic reconnection. Delay for attempt `n` is `round(min(maxBackoffMs, minBackoffMs * backoffFactor ** n) * (1 + (random() * 2 - 1) * jitterRatio))`. Attempt counter resets to `0` on every successful open.

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `frontend/src/liveConnection.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/liveConnection.test.ts`
Expected: FAIL — every backoff test, because no reconnect is scheduled.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/liveConnection.ts`, add two fields alongside the existing ones:

```ts
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
```

Reset the attempt counter in `handleOpen`, as its first statement:

```ts
  private handleOpen(): void {
    this.attempt = 0;
    if (this.hasConnected) this.generationValue += 1;
```

Replace `handleDrop` and add the two helpers below it:

```ts
  private handleDrop(): void {
    if (this.stopped) return;
    this.teardownSocket();
    this.setStatus(this.hasConnected ? 'reconnecting' : 'connecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = this.nextDelay();
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private nextDelay(): number {
    const { minBackoffMs, maxBackoffMs, backoffFactor, jitterRatio, random } = this.options;
    const base = Math.min(maxBackoffMs, minBackoffMs * backoffFactor ** this.attempt);
    return Math.round(base * (1 + (random() * 2 - 1) * jitterRatio));
  }
```

Cancel the pending retry in `stop`:

```ts
  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardownSocket();
  }
```

The `retryTimer !== null` guard in `scheduleReconnect` matters because `onerror` and `onclose` both route to `handleDrop` and browsers fire both for a failed connection.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/liveConnection.test.ts`
Expected: PASS, including the generation-increment test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/liveConnection.ts frontend/src/liveConnection.test.ts
git commit -m "feat(frontend): reconnect LiveConnection with jittered exponential backoff"
```

---

### Task 4: Heartbeat and staleness watchdog

**Files:**
- Modify: `frontend/src/liveConnection.ts`
- Test: `frontend/src/liveConnection.test.ts`

**Interfaces:**
- Consumes: `LiveConnection` from Task 3.
- Produces: while the socket is open, a `ping` text frame every `pingIntervalMs`, and a watchdog ticking every `watchdogTickMs` that force-reconnects when no inbound frame has arrived for `staleAfterMs`.

This is the task that fixes the reported bug. The watchdog must fire **regardless of `readyState`**, because iOS leaves suspended sockets reporting `OPEN` forever.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/liveConnection.test.ts`:

```ts
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
```

Vitest's fake timers also fake `Date`, so `Date.now()` advances with `vi.advanceTimersByTime`. The watchdog depends on this.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/liveConnection.test.ts -t heartbeat`
Expected: FAIL — no pings sent, zombie socket never closed.

- [ ] **Step 3: Write minimal implementation**

Add fields to `frontend/src/liveConnection.ts`:

```ts
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
```

Start the timers at the end of `handleOpen`:

```ts
    for (const listener of this.connectedListeners) listener(this.generationValue);
    this.startTimers();
```

Stamp liveness as the first statement of `handleMessage`:

```ts
  private handleMessage(event: MessageEvent): void {
    this.lastMessageAt = Date.now();
    let envelope: Envelope;
```

Add the timer helpers:

```ts
  private startTimers(): void {
    this.stopTimers();
    this.lastMessageAt = Date.now();
    this.pingTimer = setInterval(() => { this.sendPing(); }, this.options.pingIntervalMs);
    this.watchdogTimer = setInterval(() => { this.checkStale(); }, this.options.watchdogTickMs);
  }

  private stopTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer);
    this.pingTimer = null;
    this.watchdogTimer = null;
  }

  private sendPing(): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== SOCKET_OPEN) return;
    try {
      ws.send('ping');
    } catch {
      this.handleDrop();
    }
  }

  /** readyState is untrustworthy on suspended iOS sockets, so age decides. */
  private checkStale(): void {
    if (!this.socket) return;
    if (Date.now() - this.lastMessageAt <= this.options.staleAfterMs) return;
    this.handleDrop();
  }
```

Stop the timers in `teardownSocket`, as its first statement:

```ts
  private teardownSocket(): void {
    this.stopTimers();
    const ws = this.socket;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/liveConnection.test.ts`
Expected: PASS, all describe blocks.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/liveConnection.ts frontend/src/liveConnection.test.ts
git commit -m "feat(frontend): detect dead sockets with heartbeat and staleness watchdog"
```

---

### Task 5: Resume triggers

**Files:**
- Modify: `frontend/src/liveConnection.ts`
- Test: `frontend/src/liveConnection.test.ts`

**Interfaces:**
- Consumes: `LiveConnection` from Task 4.
- Produces: `document` `visibilitychange`, `window` `pageshow`, and `window` `online` all reset backoff and re-evaluate the connection immediately. `stop()` removes all three listeners.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/liveConnection.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/liveConnection.test.ts -t resume`
Expected: FAIL — no listeners registered, so nothing reconnects.

- [ ] **Step 3: Write minimal implementation**

Add a bound handler field to `frontend/src/liveConnection.ts`:

```ts
  private readonly onResume = (): void => { this.resume(); };
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.resume();
  };
```

Register in `start`, after `this.stopped = false;`:

```ts
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pageshow', this.onResume);
    window.addEventListener('online', this.onResume);
    this.connect();
```

Unregister in `stop`, before the teardown:

```ts
  stop(): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pageshow', this.onResume);
    window.removeEventListener('online', this.onResume);
    if (this.retryTimer !== null) {
```

Add the `resume` method:

```ts
  /** Frozen background timers mean lastMessageAt is stale on wake, so this fires. */
  private resume(): void {
    if (this.stopped) return;
    this.attempt = 0;
    if (this.socket && this.socket.readyState === SOCKET_OPEN) {
      this.checkStale();
      return;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.connect();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/liveConnection.test.ts`
Expected: PASS, all four describe blocks.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/liveConnection.ts frontend/src/liveConnection.test.ts
git commit -m "feat(frontend): reconnect LiveConnection on resume from background"
```

---

### Task 6: `useLiveState` becomes an adapter

**Files:**
- Modify: `frontend/src/useLiveState.ts`
- Test: `frontend/src/useLiveState.test.tsx`

**Interfaces:**
- Consumes: `LiveConnection`, `ConnectionStatus` from Task 5.
- Produces: `useLiveState(): { snapshot: StateSnapshot | null; logs: LogEntry[]; status: ConnectionStatus; generation: number }`. Logs are cleared on every socket open so the server's replay cannot double them.

- [ ] **Step 1: Update the existing fake and add failing tests**

In `frontend/src/useLiveState.test.tsx`, extend `FakeWS` so it satisfies the new consumer — add these members to the class:

```ts
  readyState = 0;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  fireOpen(): void { this.readyState = 1; this.onopen?.(); }
```

Change `send(): void {}` to `send(_data: string): void {}` and update `close()`:

```ts
  close(): void { this.closed = true; this.readyState = 3; }
```

Then append these tests inside the existing `describe('useLiveState')`:

```ts
  it('reports connecting before the socket opens and open afterwards', () => {
    const { result } = renderHook(() => useLiveState());
    expect(result.current.status).toBe('connecting');
    act(() => { instance?.fireOpen(); });
    expect(result.current.status).toBe('open');
  });

  it('clears logs on every open so the server replay is not duplicated', () => {
    const { result } = renderHook(() => useLiveState());
    act(() => { instance?.fireOpen(); });
    act(() => {
      instance?.onmessage?.({ data: JSON.stringify({ kind: 'log', payload: logEntry }) });
    });
    expect(result.current.logs).toHaveLength(1);

    act(() => { instance?.fireOpen(); });
    expect(result.current.logs).toHaveLength(0);

    act(() => {
      instance?.onmessage?.({ data: JSON.stringify({ kind: 'log', payload: logEntry }) });
    });
    expect(result.current.logs).toHaveLength(1);
  });

  it('exposes a generation that increments on each reopen', () => {
    const { result } = renderHook(() => useLiveState());
    act(() => { instance?.fireOpen(); });
    expect(result.current.generation).toBe(0);
    act(() => { instance?.fireOpen(); });
    expect(result.current.generation).toBe(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/useLiveState.test.tsx`
Expected: FAIL — `result.current.status` and `.generation` are `undefined`.

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `frontend/src/useLiveState.ts`:

```ts
import { useEffect, useState } from 'react';
import { LiveConnection, type ConnectionStatus } from './liveConnection';
import type { StateSnapshot, LogEntry } from './types';

export interface LiveState {
  snapshot: StateSnapshot | null;
  logs: LogEntry[];
  status: ConnectionStatus;
  generation: number;
}

export function useLiveState(): LiveState {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const conn = new LiveConnection();
    const offStatus = conn.on('status', setStatus);
    const offConnected = conn.on('connected', (g) => {
      setLogs([]);
      setGeneration(g);
    });
    const offMessage = conn.on('message', ({ kind, payload }) => {
      if (kind === 'state') setSnapshot(payload as StateSnapshot);
      else if (kind === 'log') setLogs((prev) => [...prev.slice(-499), payload as LogEntry]);
    });
    conn.start();
    return () => {
      offStatus();
      offConnected();
      offMessage();
      conn.stop();
    };
  }, []);

  return { snapshot, logs, status, generation };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/useLiveState.test.tsx`
Expected: PASS, including the six pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/useLiveState.ts frontend/src/useLiveState.test.tsx
git commit -m "refactor(frontend): back useLiveState with LiveConnection"
```

---

### Task 7: Incidents refetch on reconnect

**Files:**
- Modify: `frontend/src/useIncidents.ts`
- Modify: `frontend/src/views/OverviewView.tsx:10-19`
- Test: `frontend/src/useIncidents.test.tsx`

**Interfaces:**
- Consumes: the `generation` value produced by Task 6.
- Produces: `useIncidents(rev: number, generation: number): IncidentWindow | null` and `OverviewViewProps` gains a required `generation: number`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/useIncidents.test.tsx`, update every existing `renderHook` call to pass both arguments — for example the first becomes:

```ts
    const { result } = renderHook(
      ({ rev, generation }) => useIncidents(rev, generation),
      { initialProps: { rev: 1, generation: 0 } },
    );
```

Apply the same shape to the other three existing tests (`initialProps: { rev: 2, generation: 0 }` etc., and `rerender({ rev: 2, generation: 0 })`). Then append:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/useIncidents.test.tsx`
Expected: FAIL — the new test refetches zero extra times; TypeScript also reports an arity error.

- [ ] **Step 3: Write minimal implementation**

Replace `frontend/src/useIncidents.ts`:

```ts
import { useEffect, useState } from 'react';
import { getIncidents } from './api';
import type { IncidentWindow } from './types';

// Refetches whenever `rev` or `generation` changes. The effect dependency uses
// Object.is, so a server restart that resets rev to a lower number still refetches.
// `generation` advances on every websocket reopen, making a reconnect a full resync.
export function useIncidents(rev: number, generation: number): IncidentWindow | null {
  const [data, setData] = useState<IncidentWindow | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIncidents()
      .then((w) => { if (!cancelled) setData(w); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [rev, generation]);

  return data;
}
```

In `frontend/src/views/OverviewView.tsx`, add the prop and forward it:

```ts
export interface OverviewViewProps {
  snapshot: StateSnapshot | null;
  domains: DomainConfig[];
  settings: Settings | null;
  generation: number;
}

export function OverviewView({
  snapshot, domains, settings, generation,
}: OverviewViewProps): JSX.Element {
  // Null-safe defaults
  const reachability = snapshot?.reachability ?? { since: 0, rev: 0, ongoing: null, history: [], latest: [] };
  const incidentWindow = useIncidents(reachability.rev, generation);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/useIncidents.test.tsx src/views/OverviewView.test.tsx`
Expected: PASS. If `OverviewView.test.tsx` fails to compile, add `generation={0}` to its render call.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/useIncidents.ts frontend/src/useIncidents.test.tsx frontend/src/views/OverviewView.tsx frontend/src/views/OverviewView.test.tsx
git commit -m "feat(frontend): refetch incidents after a websocket reconnect"
```

---

### Task 8: Config resync on reconnect

**Files:**
- Modify: `frontend/src/App.tsx:45`, `frontend/src/App.tsx:133-139`, `frontend/src/App.tsx:302`
- Test: `frontend/src/App.test.tsx`

**Interfaces:**
- Consumes: `generation` from Task 6, `OverviewViewProps.generation` from Task 7.
- Produces: nothing consumed by later tasks.

The `WebSocket` stub in `App.test.tsx` is currently `class { close() {} }`. `LiveConnection` calls `send()` and reads `readyState`, so the stub must be widened or the suite breaks.

- [ ] **Step 1: Write the failing test**

Replace the `beforeEach` block at the top of `frontend/src/App.test.tsx`:

```ts
let socket: { onopen: (() => void) | null } | null = null;

beforeEach(() => {
  socket = null;
  vi.stubGlobal('WebSocket', class {
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor() { socket = this; }
    send(_data: string) {}
    close() {}
  } as unknown as typeof WebSocket);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch);
});
```

Then append a new test inside `describe('App shell')`:

```ts
  it('refetches configuration after a websocket reconnect', async () => {
    render(<App />);
    await act(async () => { socket?.onopen?.(); });
    const afterFirst = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await act(async () => { socket?.onopen?.(); });
    const afterSecond = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
```

Add `act` to the import from `@testing-library/react`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: FAIL — the second open triggers no additional fetches.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/App.tsx`, destructure the new value. Do **not** destructure `status` in this task — Task 9 adds it when the overlay needs it, so no unused variable exists at any point:

```ts
  const { snapshot, logs, generation } = useLiveState();
```

Add `generation` to the config effect's dependency array:

```ts
  useEffect(() => {
    void Promise.all([
      api.getProviders().then(setProviders).catch(() => undefined),
      api.getHooks().then(setHookDefs).catch(() => undefined),
      api.getIpSources().then(setIpSources).catch(() => undefined),
    ]);
    void loadConfig();
  }, [loadConfig, generation]);
```

Pass `generation` to the Overview view:

```tsx
            {activeView === 'overview' && (
              <OverviewView
                snapshot={snapshot}
                domains={domains}
                settings={settings}
                generation={generation}
              />
            )}
```

`status` is deliberately NOT destructured in this task — Task 9 adds it together with its first consumer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS, whole suite, and oxlint clean via the `pretest` hook.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx
git commit -m "feat(frontend): resync configuration after a websocket reconnect"
```

---

### Task 9: Blocking `ConnectionOverlay`

**Files:**
- Create: `frontend/src/useDelayedFlag.ts`
- Create: `frontend/src/useDelayedFlag.test.tsx`
- Create: `frontend/src/components/ConnectionOverlay.tsx`
- Create: `frontend/src/components/ConnectionOverlay.test.tsx`
- Modify: `frontend/src/styles.css:34-38` and end of file
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `ConnectionStatus` from Task 5, `status` from Task 6.
- Produces: `useDelayedFlag(active: boolean, delayMs: number): boolean` and `ConnectionOverlay({ status, visible }: { status: ConnectionStatus; visible: boolean })`.

**Deliberate refinement of the spec.** The spec placed the 1.5s grace timer inside `ConnectionOverlay`. It is extracted into `useDelayedFlag` instead, because `App` needs the *same* delayed boolean to drive `inert` on `.shell`. Two independent timers would let the overlay and the inert state disagree. One hook, two consumers.

- [ ] **Step 1: Write the failing test for the hook**

Create `frontend/src/useDelayedFlag.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/useDelayedFlag.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `frontend/src/useDelayedFlag.ts`:

```ts
import { useEffect, useState } from 'react';

// True only after `active` has stayed true continuously for `delayMs`.
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [flag, setFlag] = useState(false);

  useEffect(() => {
    if (!active) {
      setFlag(false);
      return;
    }
    const timer = setTimeout(() => { setFlag(true); }, delayMs);
    return () => { clearTimeout(timer); };
  }, [active, delayMs]);

  return flag;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/useDelayedFlag.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the overlay**

Create `frontend/src/components/ConnectionOverlay.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectionOverlay } from './ConnectionOverlay';

describe('ConnectionOverlay', () => {
  it('renders nothing visible while not yet due', () => {
    const { container } = render(<ConnectionOverlay status="reconnecting" visible={false} />);
    expect(container.querySelector('.conn-overlay.conn-open')).toBeNull();
  });

  it('says Connecting before any socket has opened', () => {
    render(<ConnectionOverlay status="connecting" visible />);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
  });

  it('says Reconnecting once a socket has opened before', () => {
    render(<ConnectionOverlay status="reconnecting" visible />);
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  });

  it('exposes the message as a live status region', () => {
    render(<ConnectionOverlay status="reconnecting" visible />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('uses only conn-prefixed class names', () => {
    const { container } = render(<ConnectionOverlay status="reconnecting" visible />);
    const classes = Array.from(container.querySelectorAll('*'))
      .flatMap((el) => Array.from(el.classList));
    expect(classes.every((c) => c.startsWith('conn-'))).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ConnectionOverlay.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the overlay**

Create `frontend/src/components/ConnectionOverlay.tsx`:

```tsx
import type { JSX } from 'react';
import type { ConnectionStatus } from '../liveConnection';

export interface ConnectionOverlayProps {
  status: ConnectionStatus;
  visible: boolean;
}

export function ConnectionOverlay({ status, visible }: ConnectionOverlayProps): JSX.Element {
  const label = status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <div className={`conn-overlay${visible ? ' conn-open' : ''}`} aria-hidden={!visible}>
      <div className="conn-card">
        <span className="conn-spinner" />
        <span className="conn-label" role="status" aria-live="polite">
          {visible ? label : ''}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Add the styles**

In `frontend/src/styles.css`, add the token between `--z-modal` and `--z-toast`:

```css
  --z-modal: 100;
  --z-conn: 150;
  --z-toast: 200;
```

Append at the end of the file:

```css
/* ---------- Connection overlay ---------- */
.conn-overlay {
  position: fixed; inset: 0; background: rgba(5, 8, 16, .6); backdrop-filter: blur(4px);
  display: grid; place-items: center; z-index: var(--z-conn);
  padding: calc(20px + var(--sa-top)) calc(20px + var(--sa-right))
           calc(20px + var(--sa-bottom)) calc(20px + var(--sa-left));
  opacity: 0; pointer-events: none; transition: opacity var(--transition);
}
.conn-overlay.conn-open { opacity: 1; pointer-events: auto; }
.conn-card {
  display: flex; align-items: center; gap: 14px; padding: 20px 24px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow);
}
.conn-spinner {
  width: 18px; height: 18px; flex: none; border-radius: 50%;
  border: 2px solid var(--border-strong); border-top-color: var(--accent);
  animation: conn-spin .8s linear infinite;
}
.conn-label { font-size: 14px; font-weight: 600; color: var(--text); }
@keyframes conn-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .conn-spinner { animation: none; } }
```

- [ ] **Step 9: Wire it into `App`**

In `frontend/src/App.tsx`, add the imports:

```ts
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { useDelayedFlag } from './useDelayedFlag';
```

Add `status` to the destructure Task 8 left without it:

```ts
  const { snapshot, logs, status, generation } = useLiveState();
```

Immediately after the `useLiveState` call:

```ts
  const disconnected = useDelayedFlag(status !== 'open', 1500);
```

Make the shell inert while blocked:

```tsx
      <div className="shell" inert={disconnected}>
```

And render the overlay as the last child, after `<Toasts toasts={toasts} />`:

```tsx
      <Toasts toasts={toasts} />
      <ConnectionOverlay status={status} visible={disconnected} />
```

- [ ] **Step 10: Run the full frontend suite, lint and type-check**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS, with coverage above the configured thresholds, and `tsc` exiting 0 with no output.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/useDelayedFlag.ts frontend/src/useDelayedFlag.test.tsx frontend/src/components/ConnectionOverlay.tsx frontend/src/components/ConnectionOverlay.test.tsx frontend/src/styles.css frontend/src/App.tsx
git commit -m "feat(frontend): block the UI with a reconnect overlay while disconnected"
```

---

### Task 10: Real-browser reconnect test

**Files:**
- Modify: `frontend/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

This is the only test that exercises a real WebSocket; jsdom cannot. It also guards the log-duplication regression, which unit tests can only approximate.

- [ ] **Step 1: Write the test**

Append to `frontend/e2e/dashboard.spec.ts`:

```ts
test('recovers from a dropped connection and does not duplicate logs', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: /Logs/ }).click();
  const lines = page.locator('.log-line');
  await expect.poll(async () => lines.count()).toBeGreaterThan(0);
  const before = await lines.count();

  await context.setOffline(true);
  await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 40_000 });

  await context.setOffline(false);
  await expect(page.getByText('Reconnecting…')).toBeHidden({ timeout: 40_000 });

  await expect(page.getByRole('heading', { name: 'Logs', level: 2 })).toBeVisible();
  await expect.poll(async () => lines.count()).toBeLessThanOrEqual(before * 2 - 1);
});
```

The final assertion is the duplication guard: without the log-clearing fix the count would be at least `before * 2`. Using `before * 2 - 1` tolerates new log records genuinely arriving during the outage.

- [ ] **Step 2: Run the e2e suite**

Run: `cd frontend && npm run test:e2e`
Expected: PASS. The e2e server binds port 8123 and isolates state via `TETHER_DDNS_HOME_PATH`, so a dev instance on :8000 does not interfere.

- [ ] **Step 3: If `setOffline` does not drop the socket, use the documented fallback**

Chromium sometimes leaves an established WebSocket alive under offline emulation. If `Reconnecting…` never appears, replace the offline/online pair with `page.routeWebSocket()`, which is available in the pinned Playwright 1.61:

```ts
  let live = true;
  await page.routeWebSocket('**/api/ws', (route) => {
    if (!live) { route.close({ code: 1006 }); return; }
    route.connectToServer();
  });
```

Set `live = false`, force a drop, assert the overlay, then set `live = true` and assert recovery. Do not add `page.waitForTimeout` sleeps to paper over flakiness — poll on assertions instead.

- [ ] **Step 4: Run every gate**

```bash
cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json && npm run test:e2e
cd .. && source .venv/bin/activate
flake8 test/ tether_ddns/ && mypy . && pyright && ruff check
pytest test/ --cov=tether_ddns --cov-fail-under=90
```

Expected: all green. `pytest` emits one pre-existing `StarletteDeprecationWarning` from FastAPI's TestClient — known, out of scope, do not chase it.

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/dashboard.spec.ts
git commit -m "test(e2e): verify websocket recovery and log deduplication"
```

---

## Manual verification

Automated tests cannot cover the actual reported scenario. After Task 10:

1. Build and run the daemon, open the dashboard on an iPhone, and add it to the home screen.
2. Close the standalone app, wait five minutes, and reopen it.
3. Expect: live data within about a second, no overlay flash on a fast network, and no page reload needed.
4. On desktop, disable Wi-Fi with the tab focused. Expect the overlay within roughly 30s (25s staleness plus one 5s watchdog tick). Re-enable Wi-Fi and expect recovery.
