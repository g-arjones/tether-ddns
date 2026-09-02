import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

let socket: { onopen: (() => void) | null } | null = null;

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
});
