import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectionOverlay } from './ConnectionOverlay';

describe('ConnectionOverlay', () => {
  it('renders nothing visible while not yet due', () => {
    const { container } = render(<ConnectionOverlay status="reconnecting" visible={false} />);
    expect(container.querySelector('.conn-overlay.conn-open')).toBeNull();
  });

  it('says Connecting before any socket has opened', () => {
    render(<ConnectionOverlay status="connecting" visible />);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
  });

  it('says Reconnecting once a socket has opened before', () => {
    render(<ConnectionOverlay status="reconnecting" visible />);
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  });

  it('exposes the message as a live status region', () => {
    render(<ConnectionOverlay status="reconnecting" visible />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('uses only conn-prefixed class names', () => {
    const { container } = render(<ConnectionOverlay status="reconnecting" visible />);
    const classes = Array.from(container.querySelectorAll('*'))
      .flatMap((el) => Array.from(el.classList));
    expect(classes.every((c) => c.startsWith('conn-'))).toBe(true);
  });
});
