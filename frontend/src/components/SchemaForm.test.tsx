import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SchemaForm } from './SchemaForm';

describe('SchemaForm', () => {
  it('renders a password input for password-format fields', () => {
    const schema = { properties: { token: { format: 'password', title: 'Token' }, domain: { title: 'Domain' } } };
    const onChange = vi.fn();
    render(<SchemaForm schema={schema} value={{}} onChange={onChange} />);
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'host' } });
    expect(onChange).toHaveBeenCalledWith({ domain: 'host' });
  });
});
