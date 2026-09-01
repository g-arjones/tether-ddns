import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';
import { IconGlobe } from './icons';

describe('EmptyState', () => {
  it('renders the icon, heading and body inside the empty block', () => {
    const { container } = render(
      <EmptyState icon={<IconGlobe strokeWidth={1.5} />} title="No domains yet">
        Add your first domain to get started.
      </EmptyState>,
    );
    const block = container.querySelector('.empty');
    expect(block).not.toBeNull();
    expect(block!.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'No domains yet', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('Add your first domain to get started.')).toBeInTheDocument();
  });

  it('omits the paragraph when there is no body', () => {
    const { container } = render(<EmptyState icon={<IconGlobe />} title="No hooks configured" />);
    expect(container.querySelector('.empty p')).toBeNull();
  });
});
