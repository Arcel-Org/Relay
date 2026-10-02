/**
 * Regression coverage for UserAvatar's online/offline status indicator.
 * It used to convey status by color alone (green vs gray dot) — invisible
 * to screen readers and indistinguishable for colorblind users. Fix:
 * an sr-only "Online"/"Offline" label, plus a shape difference (solid
 * filled dot vs a hollow border-only ring) so the distinction survives
 * grayscale/colorblind rendering too.
 *
 * No .tsx test files exist elsewhere in this repo (vitest.config.ts only
 * includes *.test.ts), so this uses React.createElement instead of JSX to
 * stay a plain .ts file rather than widening the shared test glob.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { UserAvatar } from '../../components/UserAvatar';

describe('UserAvatar — status indicator is not color-only', () => {
  it('THE REGRESSION: exposes an sr-only "Online" label, and renders the indicator dot as solid-filled', () => {
    render(createElement(UserAvatar, { emoji: '🦊', color: '#336699', online: true }));
    expect(screen.getByText('Online')).toBeTruthy();

    const dot = screen.getByText('Online').previousElementSibling as HTMLElement;
    expect(dot.style.backgroundColor).not.toBe('transparent');
    expect(dot.style.border).toBeFalsy();
  });

  it('exposes an sr-only "Offline" label, and renders the indicator dot as a hollow ring (border, transparent center)', () => {
    render(createElement(UserAvatar, { emoji: '🦊', color: '#336699', online: false }));
    expect(screen.getByText('Offline')).toBeTruthy();

    const dot = screen.getByText('Offline').previousElementSibling as HTMLElement;
    expect(dot.style.backgroundColor).toBe('transparent');
    expect(dot.style.border).toBeTruthy();
  });
});
