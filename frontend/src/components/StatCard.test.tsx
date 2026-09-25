import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('renders label, value, sub and tint', () => {
    const { container } = render(
      <StatCard label="Synced" value={4} sub="Records up to date" tint="tint-ok" icon={<svg />} />,
    );
    expect(screen.getByText('Synced')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Records up to date')).toBeInTheDocument();
    expect(container.querySelector('.stat-ico.tint-ok')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders rich sub content with a tooltip and an extra card class', () => {
    const { container } = render(
      <StatCard
        label="Heartbeat" value="Failed" tint="tint-muted" icon={<svg />}
        sub={<span className="hb-mono">TimeoutError</span>} subTitle="TimeoutError" className="hb-err"
      />,
    );
    expect(container.querySelector('.stat')).toHaveClass('hb-err');
    expect(container.querySelector('.stat-ico.tint-muted')).toBeTruthy();
    expect(container.querySelector('.stat-sub')).toHaveAttribute('title', 'TimeoutError');
    expect(screen.getByText('TimeoutError')).toHaveClass('hb-mono');
  });

  it('turns the tinted icon into a labelled button when given an action', () => {
    const onClick = vi.fn();
    const { container } = render(
      <StatCard label="Heartbeat" value="—" sub="x" tint="tint-ok" icon={<svg />} action={{ label: 'Ping now', onClick }} />,
    );
    const button = screen.getByRole('button', { name: 'Ping now' });
    expect(button).toHaveClass('stat-ico', 'tint-ok');
    expect(button).toHaveAttribute('title', 'Ping now');
    expect(container.querySelectorAll('.stat-ico')).toHaveLength(1);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('disables and spins the action while busy', () => {
    render(
      <StatCard label="Heartbeat" value="—" sub="x" tint="tint-ok" icon={<svg />} action={{ label: 'Ping now', onClick: vi.fn(), busy: true }} />,
    );
    const button = screen.getByRole('button', { name: 'Ping now' });
    expect(button).toBeDisabled();
    expect(button).toHaveClass('spin');
  });
});
