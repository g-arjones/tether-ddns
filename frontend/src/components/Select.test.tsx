import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
];

describe('Select', () => {
  it('exposes a labelable native select with all options', () => {
    render(<Select id="s1" ariaLabel="Choice" value="a" options={options} onChange={vi.fn()} />);
    const native = screen.getByLabelText('Choice') as HTMLSelectElement;
    expect(native.tagName).toBe('SELECT');
    expect(Array.from(native.options).map((o) => o.value)).toEqual(['a', 'b']);
    expect(native.value).toBe('a');
  });

  it('shows the selected label in the trigger', () => {
    const { container } = render(<Select value="b" options={options} onChange={vi.fn()} />);
    expect(container.querySelector('.cs-label')?.textContent).toBe('Option B');
  });

  it('opens the menu and fires onChange when an option is clicked', () => {
    const onChange = vi.fn();
    const { container } = render(<Select value="a" options={options} onChange={onChange} />);
    fireEvent.click(container.querySelector('.cs-trigger') as HTMLElement);
    expect(container.querySelector('.cs')).toHaveClass('open');
    const menu = container.querySelector('.cs-menu') as HTMLElement;
    fireEvent.click(within(menu).getByText('Option B'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('fires onChange from the native select', () => {
    const onChange = vi.fn();
    render(<Select id="s2" ariaLabel="Choice" value="a" options={options} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Choice'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
