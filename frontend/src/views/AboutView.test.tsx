import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AboutView } from './AboutView';
import * as api from '../api';

const about = {
  app: { name: 'Tether', version: '0.0.1', description: 'Self-hosted DDNS test blurb.' },
  backend: {
    python: '3.12.7', apscheduler: '3.11.3', fastapi: '0.139.0', pydantic: '2.13.4',
    aiodns: '4.0.4', aiohttp: '3.14.1', uvicorn: '0.51.0', websockets: '16.1',
  },
};

describe('AboutView', () => {
  it('renders app header, description, and both panels', async () => {
    vi.spyOn(api, 'getAbout').mockResolvedValue(about);
    render(<AboutView />);
    expect(await screen.findByText('Self-hosted DDNS test blurb.')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(await screen.findByText('0.139.0')).toBeInTheDocument(); // fastapi
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('shows an error note but still renders the Frontend panel on fetch failure', async () => {
    vi.spyOn(api, 'getAbout').mockRejectedValue(new Error('boom'));
    render(<AboutView />);
    expect(await screen.findByText(/Couldn't load version info/i)).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
  });
});
