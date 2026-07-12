import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

const base = {
  title: 'Overview', subtitle: 'Live status', ipv4: '203.0.113.5', ipv6: null,
  online: true, refreshing: false, theme: 'dark' as const,
  onRefresh: vi.fn(), onToggleTheme: vi.fn(), onToggleRail: vi.fn(),
};

describe('TopBar', () => {
  it('renders title, subtitle and IPv4 value', () => {
    render(<TopBar {...base} />);
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Live status')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.5')).toBeInTheDocument();
  });
  it('shows a dash for a missing IPv6', () => {
    render(<TopBar {...base} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
  it('fires refresh and theme handlers', () => {
    const onRefresh = vi.fn(); const onToggleTheme = vi.fn();
    render(<TopBar {...base} onRefresh={onRefresh} onToggleTheme={onToggleTheme} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/i }));
    fireEvent.click(screen.getByRole('button', { name: /Toggle theme/i }));
    expect(onRefresh).toHaveBeenCalled();
    expect(onToggleTheme).toHaveBeenCalled();
  });
});
