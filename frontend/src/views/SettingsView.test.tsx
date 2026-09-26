import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';
import { ApiError } from '../api';
import type { Settings } from '../types';

const settings: Settings = {
  check_interval: 300, ip_source: 'ipify', update_on_startup: true, retry_on_failure: true, notify: true,
  heartbeat_url: null, heartbeat_interval: 300,
};
const URL = 'https://hc-ping.com/5b1c7f0a';
const sources = [{ key: 'ipify', display_name: 'ipify' }];
const ok = (result: Settings = settings) => vi.fn().mockResolvedValue(result);

function view(s: Settings, onSave = ok()) {
  const utils = render(<SettingsView settings={s} ipSources={sources} onSave={onSave} />);
  return { ...utils, onSave, input: screen.getByLabelText(/Ping URL/) as HTMLInputElement, save: screen.getByRole('button', { name: 'Save' }) };
}

describe('SettingsView', () => {
  it('marks the active interval chip and saves on change', () => {
    const { onSave } = view(settings);
    const group = screen.getByRole('group', { name: 'Check interval' });
    expect(within(group).getByRole('button', { name: '5 min' })).toHaveClass('active');
    fireEvent.click(within(group).getByRole('button', { name: '10 min' }));
    expect(onSave).toHaveBeenCalledWith({ check_interval: 600 });
  });

  it('populates ip-source options from props', () => {
    render(<SettingsView settings={settings} ipSources={[...sources, { key: 'icanhazip', display_name: 'icanhazip' }]} onSave={ok()} />);
    expect(screen.getByRole('option', { name: /icanhazip/ })).toBeInTheDocument();
  });

  it('enables Save only once the URL differs from the saved value', () => {
    const { input, save } = view(settings);
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: URL } });
    expect(save).toBeEnabled();
    fireEvent.change(input, { target: { value: '  ' } });
    expect(save).toBeDisabled();
  });

  it('saves the trimmed URL on Enter', async () => {
    const { input, onSave } = view(settings);
    fireEvent.change(input, { target: { value: `  ${URL} ` } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSave).toHaveBeenCalledWith({ heartbeat_url: URL });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('sends null when the URL is cleared', async () => {
    const { input, save, onSave } = view({ ...settings, heartbeat_url: URL });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ heartbeat_url: null });
    await waitFor(() => expect(save).toBeEnabled());
  });

  it('shows the field error inline until the draft changes', async () => {
    const onSave = vi.fn().mockRejectedValue(
      new ApiError('/api/settings -> 422', 422, { heartbeat_url: 'Input should be a valid URL' }));
    const { input, save } = view(settings, onSave);
    fireEvent.change(input, { target: { value: 'hc-ping.com/x' } });
    fireEvent.click(save);
    expect(await screen.findByText('Input should be a valid URL')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: 'https://hc-ping.com/x' } });
    expect(screen.queryByText('Input should be a valid URL')).toBeNull();
    expect(screen.getByText('Leave empty to disable.')).toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('resets the draft to the saved (normalised) value', () => {
    const { rerender } = view(settings);
    rerender(<SettingsView settings={{ ...settings, heartbeat_url: 'https://hc-ping.com/' }} ipSources={sources} onSave={ok()} />);
    expect((screen.getByLabelText(/Ping URL/) as HTMLInputElement).value).toBe('https://hc-ping.com/');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('dims the heartbeat chips without a URL but still saves the interval', async () => {
    const { onSave } = view(settings);
    const group = screen.getByRole('group', { name: 'Heartbeat interval' });
    expect(group).toHaveClass('hb-dim');
    expect(within(group).getByRole('button', { name: '5 min' })).toHaveClass('active');
    fireEvent.click(within(group).getByRole('button', { name: '30 s' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ heartbeat_interval: 30 }));
  });

  it('does not dim the heartbeat chips once a URL is saved', () => {
    view({ ...settings, heartbeat_url: URL });
    expect(screen.getByRole('group', { name: 'Heartbeat interval' })).not.toHaveClass('hb-dim');
  });

  it('resets the draft when a save normalises back to the already-stored URL', async () => {
    const stored = 'https://hc-ping.com/x';
    const resolved: Settings = { ...settings, heartbeat_url: stored };
    const { input, save } = view({ ...settings, heartbeat_url: stored }, ok(resolved));
    fireEvent.change(input, { target: { value: 'https://hc-ping.com:443/x' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(input.value).toBe(stored));
    expect(save).toBeDisabled();
  });

  it('guards Save against a second submit while onSave is in flight', async () => {
    let resolve!: (value: Settings) => void;
    const pending = new Promise<Settings>((res) => { resolve = res; });
    const onSave = vi.fn().mockReturnValue(pending);
    const { input, save } = view(settings, onSave);
    fireEvent.change(input, { target: { value: URL } });
    fireEvent.click(save);
    expect(save).toBeDisabled();
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSave).toHaveBeenCalledTimes(1);
    resolve({ ...settings, heartbeat_url: URL });
    await waitFor(() => expect(save).toBeEnabled());
  });
});
