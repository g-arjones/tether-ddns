import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { IconClose, IconPlus, IconPlay, IconGlobe, IconLogo } from './icons';

describe('icons', () => {
  it('emits the shared svg preamble', () => {
    const { container } = render(<IconClose />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('stroke-width', '2');
    expect(svg).toHaveAttribute('stroke-linecap', 'round');
    expect(svg).toHaveAttribute('stroke-linejoin', 'round');
  });

  it('honours a stroke width override', () => {
    const { container } = render(<IconPlus strokeWidth={2.5} />);
    expect(container.querySelector('svg')).toHaveAttribute('stroke-width', '2.5');
  });

  it('renders the solid play glyph filled rather than stroked', () => {
    const { container } = render(<IconPlay />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).toHaveAttribute('stroke', 'none');
  });

  it('draws the globe as a circle plus meridians', () => {
    const { container } = render(<IconGlobe />);
    expect(container.querySelector('circle')).toHaveAttribute('r', '10');
    expect(container.querySelectorAll('path')).toHaveLength(1);
  });

  it('cuts the orbit gap with a per-instance mask on an unrotated wrapper', () => {
    const { container } = render(<><IconLogo /><IconLogo /></>);
    const masks = [...container.querySelectorAll('mask')];
    expect(masks).toHaveLength(2);
    expect(masks[0].id).not.toBe(masks[1].id);
    masks.forEach((m) => expect(m).toHaveAttribute('stroke', 'none'));
    const wrappers = [...container.querySelectorAll('g[mask]')];
    expect(wrappers).toHaveLength(2);
    wrappers.forEach((g, i) => expect(g).toHaveAttribute('mask', `url(#${masks[i].id})`));
    expect(container.querySelector('ellipse[mask]')).toBeNull();
  });
});
