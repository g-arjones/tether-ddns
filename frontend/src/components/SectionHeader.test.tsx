import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SectionHeader } from './SectionHeader';

describe('SectionHeader', () => {
  it('renders just a title when nothing else is given', () => {
    const { container } = render(<SectionHeader title="Settings" />);
    expect(screen.getByRole('heading', { name: 'Settings', level: 3 })).toBeInTheDocument();
    expect(container.querySelector('.count-badge')).toBeNull();
    expect(container.querySelector('.spacer')).toBeNull();
  });

  it('pluralises the count noun, keeping the singular at one', () => {
    const { rerender } = render(<SectionHeader title="Domains" count={{ n: 1, noun: 'record' }} />);
    expect(screen.getByText('1 record')).toBeInTheDocument();

    rerender(<SectionHeader title="Domains" count={{ n: 3, noun: 'record' }} />);
    expect(screen.getByText('3 records')).toBeInTheDocument();

    rerender(<SectionHeader title="Hooks" count={{ n: 0, noun: 'hook' }} />);
    expect(screen.getByText('0 hooks')).toBeInTheDocument();
  });

  it('renders the action behind a spacer', () => {
    const { container } = render(
      <SectionHeader title="Domains" action={<button>Add Domain</button>} />,
    );
    expect(container.querySelector('.spacer')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Add Domain' })).toBeInTheDocument();
  });
});
