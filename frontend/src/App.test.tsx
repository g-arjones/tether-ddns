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
});
