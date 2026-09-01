import { useState } from 'react';
import type { LogEntry } from '../types';
import { LogViewer } from '../components/LogViewer';
import { IconSearch } from '../components/icons';

export interface LogsViewProps {
  logs: LogEntry[];
}

type LogLevel = 'ALL' | 'INFO' | 'WARNING' | 'ERROR';

const LEVEL_LABELS: Record<LogLevel, string> = {
  ALL: 'All',
  INFO: 'Info',
  WARNING: 'Warn',
  ERROR: 'Error',
};

export function LogsView({ logs }: LogsViewProps) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<LogLevel>('ALL');

  const filtered = logs.filter((log) => {
    if (level !== 'ALL' && log.level !== level) return false;
    if (query && !log.message.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="view-logs">
      <div className="section-head">
        <h3>Logs</h3>
        <span className="count-badge">{filtered.length}</span>
      </div>
      <div className="log-toolbar">
        <div className="log-search">
          <IconSearch />
          <input
            type="text"
            placeholder="Filter log messages…"
            aria-label="Filter logs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="filter-group">
          {(['ALL', 'INFO', 'WARNING', 'ERROR'] as LogLevel[]).map((lvl) => (
            <button
              type="button"
              key={lvl}
              className={`filter-chip${level === lvl ? ' active' : ''}`}
              onClick={() => setLevel(lvl)}
            >
              {LEVEL_LABELS[lvl]}
            </button>
          ))}
        </div>
      </div>
      <LogViewer logs={filtered} />
    </div>
  );
}
