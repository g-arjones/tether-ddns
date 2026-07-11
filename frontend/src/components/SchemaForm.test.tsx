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

  it('renders an enum field as a select and emits the chosen value', () => {
    const schema = { properties: { protocol: { type: 'string', title: 'Protocol', enum: ['tcp', 'udp'] } } };
    const onChange = vi.fn();
    render(<SchemaForm schema={schema} value={{ protocol: 'tcp' }} onChange={onChange} />);
    const select = screen.getByLabelText('Protocol') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['tcp', 'udp']);
    fireEvent.change(select, { target: { value: 'udp' } });
    expect(onChange).toHaveBeenCalledWith({ protocol: 'udp' });
  });

  it('renders enum option labels from x-enum-labels', () => {
    const schema = {
      properties: {
        protocol: {
          type: 'string', title: 'Protocol', enum: ['tcp', 'tcp_udp'],
          'x-enum-labels': { tcp: 'TCP', tcp_udp: 'TCP + UDP' },
        },
      },
    };
    render(<SchemaForm schema={schema} value={{ protocol: 'tcp' }} onChange={vi.fn()} />);
    const select = screen.getByLabelText('Protocol') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['TCP', 'TCP + UDP']);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['tcp', 'tcp_udp']);
  });

  it('falls back to humanizeOption when x-enum-labels is absent', () => {
    const schema = { properties: { protocol: { type: 'string', title: 'Protocol', enum: ['tcp_udp'] } } };
    render(<SchemaForm schema={schema} value={{ protocol: 'tcp_udp' }} onChange={vi.fn()} />);
    const select = screen.getByLabelText('Protocol') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('Tcp Udp');
  });

  it('renders field description help text for a text field', () => {
    const schema = {
      properties: {
        token: { title: 'Token', type: 'string', description: 'Your API token' },
      },
    };
    render(<SchemaForm schema={schema} value={{}} onChange={vi.fn()} />);
    expect(screen.getByText('Your API token')).toBeInTheDocument();
  });
});
