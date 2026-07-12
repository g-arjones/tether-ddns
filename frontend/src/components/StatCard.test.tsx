import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  });
});
