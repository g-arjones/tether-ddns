import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { invalidProps, subErrors, useFormErrors } from './formErrors';

describe('useFormErrors', () => {
  it('keeps 422 field errors from a rejected save', async () => {
    const { result } = renderHook(() => useFormErrors('Failed to save domain'));
    await act(() => result.current.submit(async () => {
      throw new ApiError('x', 422, { hostname: 'Required' });
    }));
    expect(result.current.errors).toEqual({ hostname: 'Required' });
    expect(result.current.formError).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it('falls back to the form-level message when no field is named', async () => {
    const { result } = renderHook(() => useFormErrors('Failed to save domain'));
    await act(() => result.current.submit(async () => { throw new Error('boom'); }));
    expect(result.current.errors).toEqual({});
    expect(result.current.formError).toBe('Failed to save domain');
  });

  it('ignores a second submit while one is in flight', async () => {
    const { result } = renderHook(() => useFormErrors('x'));
    let resolve: () => void = () => undefined;
    const save = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    let first: Promise<void> = Promise.resolve();
    act(() => { first = result.current.submit(save); });
    expect(result.current.saving).toBe(true);
    await act(() => result.current.submit(save));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); await first; });
    expect(result.current.saving).toBe(false);
  });

  it('clears only matching keys and the form-level message', async () => {
    const { result } = renderHook(() => useFormErrors('x'));
    await act(() => result.current.submit(async () => {
      throw new ApiError('x', 422, { hostname: 'Required', 'provider_config.token': 'Required' });
    }));
    act(() => result.current.clear((k) => k === 'hostname'));
    expect(result.current.errors).toEqual({ 'provider_config.token': 'Required' });
    act(() => result.current.reset());
    expect(result.current.errors).toEqual({});
  });
});

describe('subErrors', () => {
  it('narrows to one section keyed by its first segment', () => {
    const errors = {
      hostname: 'Required',
      'provider_config.api_token': 'Required',
      'provider_config.ports.0': 'Input should be a valid integer',
      'provider_config.ports.1': 'second',
      provider_config: 'Invalid config',
      provider_configs: 'not mine',
    };
    expect(subErrors(errors, 'provider_config')).toEqual({
      api_token: 'Required',
      ports: 'Input should be a valid integer',
      '': 'Invalid config',
    });
  });
});

describe('invalidProps', () => {
  it('decorates an invalid control and points at its help line', () => {
    expect(invalidProps('Required', 'h')).toEqual({
      className: 'field-invalid', 'aria-invalid': true, 'aria-describedby': 'h',
    });
  });

  it('leaves a valid control undecorated but still describes it when help exists', () => {
    expect(invalidProps(undefined, 'h')).toEqual({
      className: undefined, 'aria-invalid': undefined, 'aria-describedby': undefined,
    });
    expect(invalidProps(undefined, 'h', true)['aria-describedby']).toBe('h');
  });
});
