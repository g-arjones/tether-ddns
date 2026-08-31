import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

beforeEach(() => {
  vi.stubGlobal('WebSocket', class { close() {} } as unknown as typeof WebSocket);
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
});
