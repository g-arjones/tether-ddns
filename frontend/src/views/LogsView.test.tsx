import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogsView } from './LogsView';
import type { LogEntry } from '../types';

const logs: LogEntry[] = [
  { time: 1, level: 'INFO', logger: 'x', message: 'started up' },
  { time: 2, level: 'ERROR', logger: 'x', message: 'boom failed' },
];

describe('LogsView', () => {
  it('renders all lines then filters by level', () => {
    render(<LogsView logs={logs} />);
    expect(screen.getByText('started up')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Error' }));
    expect(screen.queryByText('started up')).not.toBeInTheDocument();
    expect(screen.getByText('boom failed')).toBeInTheDocument();
  });
  it('filters by search text', () => {
    render(<LogsView logs={logs} />);
    fireEvent.change(screen.getByPlaceholderText(/Filter log messages/i), { target: { value: 'boom' } });
    expect(screen.queryByText('started up')).not.toBeInTheDocument();
    expect(screen.getByText('boom failed')).toBeInTheDocument();
  });
});
