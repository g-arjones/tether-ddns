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
