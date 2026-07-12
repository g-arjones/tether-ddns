import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';

const settings = { check_interval: 300, ip_source: 'ipify', update_on_startup: true, retry_on_failure: true, notify: true };

describe('SettingsView', () => {
  it('marks the active interval chip and saves on change', () => {
    const onSave = vi.fn();
    render(<SettingsView settings={settings} ipSources={[{ key: 'ipify', display_name: 'ipify' }]} onSave={onSave} />);
    expect(screen.getByRole('button', { name: '5 min' })).toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: '10 min' }));
    expect(onSave).toHaveBeenCalledWith({ check_interval: 600 });
  });
  it('populates ip-source options from props', () => {
    render(<SettingsView settings={settings} ipSources={[{ key: 'ipify', display_name: 'ipify' }, { key: 'icanhazip', display_name: 'icanhazip' }]} onSave={vi.fn()} />);
    expect(screen.getByRole('option', { name: /icanhazip/ })).toBeInTheDocument();
  });
});
