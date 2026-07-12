import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IpReadoutPanel } from './IpReadoutPanel';

describe('IpReadoutPanel', () => {
  it('renders both addresses and the source subtitle', () => {
    render(
      <IpReadoutPanel
        ipv4="203.0.113.5" ipv6="2606:4700::1111"
        ipv4ChangedAt={0} ipv6ChangedAt={null} ipSource="ipify"
      />,
    );
    expect(screen.getByText('203.0.113.5')).toBeInTheDocument();
    expect(screen.getByText('2606:4700::1111')).toBeInTheDocument();
    expect(screen.getByText(/ipify/)).toBeInTheDocument();
  });
  it('shows a dash for a missing address', () => {
    render(
      <IpReadoutPanel ipv4={null} ipv6={null} ipv4ChangedAt={null} ipv6ChangedAt={null} ipSource="ipify" />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });
});
