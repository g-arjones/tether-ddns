import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FieldHelp } from './FieldHelp';

describe('FieldHelp', () => {
  it('renders nothing without an error or help text', () => {
    const { container } = render(<FieldHelp id="h" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the help text when there is no error', () => {
    render(<FieldHelp id="h">Your API token</FieldHelp>);
    const help = screen.getByText('Your API token');
    expect(help).toHaveAttribute('id', 'h');
    expect(help).toHaveClass('field-help');
    expect(help).not.toHaveClass('hb-error');
  });

  it('replaces the help text with the error', () => {
    render(<FieldHelp id="h" error="Required">Your API token</FieldHelp>);
    expect(screen.queryByText('Your API token')).toBeNull();
    expect(screen.getByText('Required')).toHaveClass('field-help', 'hb-error');
  });
});
