import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AboutView } from './AboutView';
import * as api from '../api';

const about = {
  app: { name: 'Tether', version: '0.0.1', description: 'Self-hosted DDNS test blurb.' },
  backend: [
    { name: 'Python', version: '3.12.7' },
    { name: 'APScheduler', version: '3.11.3' },
    { name: 'FastAPI', version: '0.139.0' },
    { name: 'Pydantic', version: '2.13.4' },
    { name: 'aiodns', version: '4.0.4' },
    { name: 'aiohttp', version: '3.14.1' },
    { name: 'Uvicorn', version: '0.51.0' },
    { name: 'websockets', version: '16.1' },
  ],
};

describe('AboutView', () => {
  it('renders app header, description, and both panels', async () => {
    vi.spyOn(api, 'getAbout').mockResolvedValue(about);
    render(<AboutView />);
    expect(await screen.findByText('Self-hosted DDNS test blurb.')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(await screen.findByText('0.139.0')).toBeInTheDocument(); // FastAPI
    expect(screen.getByText('FastAPI')).toBeInTheDocument();
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('shows an error note but still renders the Frontend panel on fetch failure', async () => {
    vi.spyOn(api, 'getAbout').mockRejectedValue(new Error('boom'));
    render(<AboutView />);
    expect(await screen.findByText(/Couldn't load version info/i)).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
  });
});
