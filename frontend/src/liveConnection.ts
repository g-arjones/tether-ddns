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
