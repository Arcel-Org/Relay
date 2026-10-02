/**
 * Regression coverage for ResizableSidebar's collapse/resize handle. It has
 * role="separator" but was pointer-only (no tabIndex, no key handler) —
 * unreachable by keyboard despite advertising an ARIA widget role that
 * implies keyboard operability (APG separator pattern). Fix: tabIndex={0},
 * Enter/Space toggles collapsed <-> default width, and ArrowLeft/ArrowRight
 * step-resize the same way dragging does.
 *
 * No .tsx test files exist elsewhere in this repo (vitest.config.ts only
 * includes *.test.ts), so this uses React.createElement instead of JSX to
 * stay a plain .ts file rather than widening the shared test glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ResizableSidebar } from '../../components/ResizableSidebar';

beforeEach(() => {
  localStorage.clear();
});

// render() doesn't auto-unmount between tests in this repo (no global
// setupFile wires it — same gotcha noted in auto-logout.test.ts), and this
// suite calls renderSidebar() more than once per test file, so the next
// test's screen.getByRole('separator') would otherwise match leftover DOM
// from a previous test.
afterEach(cleanup);

function renderSidebar() {
  render(
    // ResizableSidebar's `children` is a render-prop function, not a
    // ReactNode — createElement's rest-args overload types children as
    // ReactNode[], so passing it that way type-checks as `any`-ish but
    // fails properly; it has to go through the props object instead, which
    // is exactly what react/no-children-prop normally warns against for
    // JSX's children-as-prop anti-pattern. That rule doesn't apply here.
    // eslint-disable-next-line react/no-children-prop
    createElement(ResizableSidebar, {
      children: ({ collapsed, width }: { collapsed: boolean; width: number }) =>
        createElement('div', { 'data-testid': 'body' }, `${collapsed}:${width}`),
    })
  );
  return screen.getByRole('separator') as HTMLElement;
}

describe('ResizableSidebar — keyboard-operable separator', () => {
  it('THE REGRESSION: the separator is focusable (tabIndex=0)', () => {
    const handle = renderSidebar();
    expect(handle.tabIndex).toBe(0);
  });

  it('ArrowLeft steps the width down, ArrowRight steps it back up', () => {
    const handle = renderSidebar();
    const widthBefore = Number(screen.getByTestId('body').textContent!.split(':')[1]);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    const widthAfterLeft = Number(screen.getByTestId('body').textContent!.split(':')[1]);
    expect(widthAfterLeft).toBeLessThan(widthBefore);

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    const widthAfterRight = Number(screen.getByTestId('body').textContent!.split(':')[1]);
    expect(widthAfterRight).toBe(widthBefore);
  });

  it('Enter collapses an expanded sidebar, Enter again expands it', () => {
    const handle = renderSidebar();
    expect(screen.getByTestId('body').textContent!.split(':')[0]).toBe('false');

    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(screen.getByTestId('body').textContent!.split(':')[0]).toBe('true');

    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(screen.getByTestId('body').textContent!.split(':')[0]).toBe('false');
  });

  it('repeated ArrowLeft eventually collapses the sidebar, matching drag-past-threshold behavior', () => {
    const handle = renderSidebar();
    for (let i = 0; i < 20; i++) {
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    }
    expect(screen.getByTestId('body').textContent!.split(':')[0]).toBe('true');
  });
});
