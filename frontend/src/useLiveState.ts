import { useEffect, useState } from 'react';
import type { StateSnapshot, LogEntry } from './types';

export function useLiveState(): { snapshot: StateSnapshot | null; logs: LogEntry[] } {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    ws.onmessage = (e: MessageEvent) => {
      const { kind, payload } = JSON.parse(e.data);
      if (kind === 'state') setSnapshot(payload as StateSnapshot);
      else if (kind === 'log') setLogs((prev) => [...prev.slice(-499), payload as LogEntry]);
    };
    return () => ws.close();
  }, []);

  return { snapshot, logs };
}
