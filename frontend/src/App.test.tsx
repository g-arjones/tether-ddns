import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { StateSnapshot } from './types';

let socket: {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
} | null = null;

const stateFrame: StateSnapshot = {
  public_ipv4: '203.0.113.5', public_ipv6: null,
  ipv4_changed_at: 0, ipv6_changed_at: null,
  online: true, next_check_at: null,
  reachability: { since: 0, rev: 0, ongoing: null, history: [], latest: [] },
  domains: [],
};

beforeEach(() => {
  socket = null;
  vi.stubGlobal('WebSocket', class {
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    // oxlint-disable-next-line no-this-alias -- test fake needs to expose the instance
    constructor() { socket = this; }
    send(_data: string) {}
    close() {}
  } as unknown as typeof WebSocket);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('App shell', () => {
  it('starts on Overview and switches views via the rail', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Overview', level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Domains/ }));
    expect(await screen.findByRole('heading', { name: 'Domains', level: 2 })).toBeInTheDocument();
  });

  it('keeps the theme-color meta in sync with the active theme', () => {
    // index.html ships this meta; jsdom does not load it.
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#000000');
    document.head.appendChild(meta);
    document.documentElement.style.setProperty('--bg', '#0b0f1a');

    render(<App />);
    expect(meta.getAttribute('content')).toBe('#0b0f1a');

    document.documentElement.style.setProperty('--bg', '#f4f6fb');
    fireEvent.click(screen.getByRole('button', { name: /Toggle theme/i }));
    expect(meta.getAttribute('content')).toBe('#f4f6fb');

    meta.remove();
    document.documentElement.style.removeProperty('--bg');
  });

  it('refetches configuration after a websocket reconnect', async () => {
    render(<App />);
    await act(async () => { socket?.onopen?.(); });
    const afterFirst = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await act(async () => { socket?.onopen?.(); });
    const afterSecond = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  // F1: aria-modal="true" on Modal claims the rest of the app is inert to
  // assistive tech, so .shell must actually go inert whenever a modal is open.
  it('makes the shell inert while a modal is open and un-inert once it closes', async () => {
    render(<App />);
    const shell = document.querySelector('.shell');
    expect(shell).not.toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: /Domains/ }));
    await screen.findByRole('heading', { name: 'Domains', level: 2 });

    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Add Domain' }));
    expect(shell).toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(shell).not.toHaveAttribute('inert');
  });

  // The modal's timeline and uptime are derived from `now`, so a bucket captured at
  // click time freezes the day's observed span for as long as the modal stays open.
  it('keeps the open incident modal in step with the observed day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const noon = new Date(2026, 7, 29, 12, 0, 0).getTime();
    vi.setSystemTime(noon);
    try {
      render(<App />);
      await act(async () => { socket?.onopen?.(); });

      const bars = document.querySelectorAll('.day-strip button');
      fireEvent.click(bars[bars.length - 1]);
      const tail = () => document.querySelector<HTMLElement>('.inc-track b.future');
      expect(tail()?.style.width).toBe('50%');

      vi.setSystemTime(noon + 6 * 3600 * 1000);
      await act(async () => {
        socket?.onmessage?.({ data: JSON.stringify({ kind: 'state', payload: stateFrame }) });
      });

      expect(tail()?.style.width).toBe('25%');
    } finally {
      vi.useRealTimers();
    }
  });
});
