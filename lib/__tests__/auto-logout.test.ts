/**
 * @vitest-environment jsdom
 *
 * Coverage for lib/auth/auto-logout.ts — the inactivity auto-lock is a real
 * security control (an unattended, unlocked device should re-lock itself),
 * but had zero test coverage before this. Uses @testing-library/react's
 * renderHook (already a devDependency, unused elsewhere in this repo) since
 * useAutoLogout's actual behavior — timers, activity-event listeners,
 * cleanup on unmount — is the point being tested, not just its call
 * signature; a useCallback/useEffect passthrough mock (the technique used
 * for burn.ts/use-group-messaging.ts) would defeat that here.
 *
 * lock() itself is mocked (its own behavior is covered by
 * relay-auth-store-lock-logout.test.ts) — this file only verifies
 * useAutoLogout calls it at the right time, with the right cleanup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

// renderHook doesn't auto-unmount between tests (no global setupFile wires
// this up in this repo) — without it, a previous test's still-mounted hook
// instance keeps its activity-event listeners attached to the shared jsdom
// `window`, so a later test's dispatchEvent() fires them too.
afterEach(cleanup);

const routerPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

const lockSpy = vi.fn();
vi.mock('@/lib/crypto/relay-auth-store-v2', () => ({
  useRelayAuthStoreV2: (selector: (s: { lock: () => void }) => unknown) => selector({ lock: lockSpy }),
}));

const toastInfo = vi.fn();
vi.mock('@/components/ToastNotification', () => ({
  toast: { info: (...args: unknown[]) => toastInfo(...args), warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import {
  useAutoLogout,
  getAutoLogoutSeconds,
  setAutoLogoutSeconds,
  formatAutoLogoutLabel,
  syncInactivityTimeoutToServer,
} from '../auth/auto-logout';

describe('getAutoLogoutSeconds / setAutoLogoutSeconds', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
  });

  it('round-trips a positive duration', () => {
    setAutoLogoutSeconds(900);
    expect(getAutoLogoutSeconds()).toBe(900);
  });

  it('null (or non-positive) is stored/read as "off"', () => {
    setAutoLogoutSeconds(null);
    expect(getAutoLogoutSeconds()).toBeNull();

    setAutoLogoutSeconds(0);
    expect(getAutoLogoutSeconds()).toBeNull();

    setAutoLogoutSeconds(-5);
    expect(getAutoLogoutSeconds()).toBeNull();
  });

  it('defaults to off (null) when nothing has been configured', () => {
    expect(getAutoLogoutSeconds()).toBeNull();
  });

  it('treats corrupted localStorage content as off rather than throwing', () => {
    localStorage.setItem('relay:auto-logout', 'not-a-number');
    expect(() => getAutoLogoutSeconds()).not.toThrow();
    expect(getAutoLogoutSeconds()).toBeNull();
  });

  it('syncs the chosen duration to the server-side session-settings endpoint', async () => {
    setAutoLogoutSeconds(1800);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/session-settings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ inactivityTimeoutSeconds: 1800 }),
      })
    );
  });
});

describe('formatAutoLogoutLabel', () => {
  it('uses the canonical label for a known option', () => {
    expect(formatAutoLogoutLabel(15 * 60)).toBe('15 minutes');
    expect(formatAutoLogoutLabel(null)).toBe('Off');
  });

  it('falls back to a computed label for a non-standard value', () => {
    expect(formatAutoLogoutLabel(120)).toBe('2 min');
    expect(formatAutoLogoutLabel(7200)).toBe('2 h');
    expect(formatAutoLogoutLabel(2 * 86400)).toBe('2 d');
  });
});

describe('syncInactivityTimeoutToServer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
  });

  it('never throws even if the network call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(syncInactivityTimeoutToServer(300)).resolves.toBeUndefined();
  });
});

describe('useAutoLogout', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
    vi.useFakeTimers();
    lockSpy.mockClear();
    routerPush.mockClear();
    toastInfo.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when inactivity auto-logout is turned off', () => {
    setAutoLogoutSeconds(null);
    renderHook(() => useAutoLogout(true));
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it('does nothing when `active` is false, even with a configured timeout', () => {
    setAutoLogoutSeconds(60);
    renderHook(() => useAutoLogout(false));
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it('locks, shows a toast, and redirects to /auth/login once the configured inactivity window elapses', () => {
    setAutoLogoutSeconds(60);
    renderHook(() => useAutoLogout(true));

    vi.advanceTimersByTime(59_000);
    expect(lockSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/auth/login');
  });

  it('user activity resets the timer, so it does not fire on the original schedule', () => {
    setAutoLogoutSeconds(60);
    renderHook(() => useAutoLogout(true));

    // Just before the original deadline, simulate activity.
    vi.advanceTimersByTime(55_000);
    window.dispatchEvent(new Event('mousemove'));

    // The original 60s deadline has now passed, but activity should have
    // pushed it back — must not have fired yet.
    vi.advanceTimersByTime(6_000);
    expect(lockSpy).not.toHaveBeenCalled();

    // The full 60s from the reset point has now elapsed.
    vi.advanceTimersByTime(55_000);
    expect(lockSpy).toHaveBeenCalledTimes(1);
  });

  it('fires only once even if somehow triggered twice', () => {
    setAutoLogoutSeconds(60);
    renderHook(() => useAutoLogout(true));
    vi.advanceTimersByTime(61_000);
    expect(lockSpy).toHaveBeenCalledTimes(1);

    // Any further activity after firing must not re-arm or re-fire.
    window.dispatchEvent(new Event('mousemove'));
    vi.advanceTimersByTime(61_000);
    expect(lockSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up its timer and listeners on unmount — no lock() call after the component is gone', () => {
    setAutoLogoutSeconds(60);
    const { unmount } = renderHook(() => useAutoLogout(true));
    unmount();
    vi.advanceTimersByTime(120_000);
    expect(lockSpy).not.toHaveBeenCalled();
  });
});
