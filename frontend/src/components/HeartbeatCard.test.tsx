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

  it('reads Off with a gray icon and no ping button when no URL is set', () => {
    const { container } = render(<HeartbeatCard status={null} url={null} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Set a URL in Settings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ping now' })).toBeNull();
    expect(container.querySelector('.stat-ico.tint-muted')).toBeTruthy();
  });

  it('shows a dash and the cadence before the first attempt', () => {
    render(<HeartbeatCard status={null} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('hc-ping.com')).toBeInTheDocument();
    expect(screen.getByText(/every 5 min/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ping now' })).toHaveClass('tint-muted');
  });

  it('shows the age and OK with a green icon after a successful ping', () => {
    const status = { at: at(42), ok: true, skipped: false, error: null };
    render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('42s ago')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ping now' })).toHaveClass('tint-ok');
  });

  it('shows Skipped with a yellow icon while the link is offline', () => {
    const status = { at: at(5), ok: false, skipped: true, error: null };
    render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('Link offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ping now' })).toHaveClass('tint-warn');
  });

  it('shows Failed with a red icon and the full error in the tooltip', () => {
    const error = "ClientResponseError: 404, message='Not Found'";
    const status = { at: at(12), ok: false, skipped: false, error };
    const { container } = render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(error)).toBeInTheDocument();
    expect(container.querySelector('.stat-sub')).toHaveAttribute('title', error);
    expect(container.querySelector('.stat')).toHaveClass('hb-err');
    expect(screen.getByRole('button', { name: 'Ping now' })).toHaveClass('tint-err');
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
