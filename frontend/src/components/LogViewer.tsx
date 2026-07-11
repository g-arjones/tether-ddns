import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../types';

const FOLLOW_THRESHOLD = 40;

export function LogViewer({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [logs, stick]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStick(gap <= FOLLOW_THRESHOLD);
  };

  return (
    <div className="log-viewer" data-testid="log-viewer" ref={ref} onScroll={onScroll}>
      {logs.length === 0 ? (
        <div className="log-empty">Waiting for log records…</div>
      ) : (
        logs.map((log, i) => (
          <div className="log-line" key={i}>
            <span className="log-time">{new Date(log.time * 1000).toLocaleTimeString()}</span>
            <span className={`log-level log-level-${log.level}`}>{log.level}</span>
            <span className="log-msg">{log.message}</span>
          </div>
        ))
      )}
    </div>
  );
}
