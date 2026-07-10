import { useEffect, useRef, useState } from 'react';
import type { StateSnapshot, LogEntry } from './types';

export function useLiveState(): { snapshot: StateSnapshot | null; logs: LogEntry[] } {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/api/ws`);
    wsRef.current = ws;
    ws.onmessage = (e: MessageEvent) => {
      const { kind, payload } = JSON.parse(e.data);
      if (kind === 'state') setSnapshot(payload as StateSnapshot);
      else if (kind === 'log') setLogs((prev) => [...prev.slice(-499), payload as LogEntry]);
    };
    return () => ws.close();
  }, []);

  return { snapshot, logs };
}
