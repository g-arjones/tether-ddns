import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatCard } from './HeartbeatCard';

const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime();
const URL = 'https://hc-ping.com/5b1c7f0a';
const at = (secondsAgo: number) => NOW / 1000 - secondsAgo;

describe('HeartbeatCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reads Off with no ping button when no URL is set', () => {
    render(<HeartbeatCard status={null} url={null} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Set a URL in Settings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ping now' })).toBeNull();
  });

  it('shows a dash and the cadence before the first attempt', () => {
    render(<HeartbeatCard status={null} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('hc-ping.com')).toBeInTheDocument();
    expect(screen.getByText(/every 5 min/)).toBeInTheDocument();
  });

  it('shows the age and OK after a successful ping', () => {
    const status = { at: at(42), ok: true, skipped: false, error: null };
    const { container } = render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('42s ago')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(container.querySelector('.stat')).toHaveClass('hb-ok');
  });

  it('shows Skipped while the link is offline', () => {
    const status = { at: at(5), ok: false, skipped: true, error: null };
    render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('Link offline')).toBeInTheDocument();
  });

  it('shows Failed with the full error in the tooltip', () => {
    const error = "ClientResponseError: 404, message='Not Found'";
    const status = { at: at(12), ok: false, skipped: false, error };
    const { container } = render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(error)).toBeInTheDocument();
    expect(container.querySelector('.hb-sub')).toHaveAttribute('title', error);
    expect(container.querySelector('.stat')).toHaveClass('hb-err');
  });

  it('calls onPing and spins until it settles', async () => {
    let settle: () => void = () => undefined;
    const onPing = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    render(<HeartbeatCard status={null} url={URL} interval={300} onPing={onPing} />);
    const button = screen.getByRole('button', { name: 'Ping now' });
    fireEvent.click(button);
    expect(onPing).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveClass('spin');
    settle();
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).not.toHaveClass('spin');
  });
});
