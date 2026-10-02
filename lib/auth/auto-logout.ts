/**
 * Auto-logout on inactivity.
 *
 * User-configurable inactivity timeout. When the timer fires, the auth store
 * is locked and the user is redirected to /auth/login.
 */

'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { toast } from '@/components/ToastNotification';
import { log } from '@/lib/platform/logger';

const STORAGE_KEY = 'relay:auto-logout';

export const AUTO_LOGOUT_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: 5 * 60, label: '5 minutes' },
  { value: 15 * 60, label: '15 minutes' },
  { value: 30 * 60, label: '30 minutes' },
  { value: 60 * 60, label: '1 hour' },
  { value: 4 * 60 * 60, label: '4 hours' },
  { value: 24 * 60 * 60, label: '24 hours' },
];

export function getAutoLogoutSeconds(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw === 'off') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

export function setAutoLogoutSeconds(seconds: number | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (seconds === null || seconds <= 0) {
      localStorage.setItem(STORAGE_KEY, 'off');
    } else {
      localStorage.setItem(STORAGE_KEY, String(Math.floor(seconds)));
    }
  } catch (err) {
    log.warn('[auto-logout] failed to persist', err);
  }
  // Best-effort sync so the server can independently enforce this
  // threshold (see app/api/auth/session-settings/route.ts and
  // lib/db/session-store.ts's isIdleExpired) even if the client-side timer
  // above never runs — e.g. a tampered/compromised client that just never
  // fires it. The client-side lock stays too, purely for faster/nicer UX.
  void syncInactivityTimeoutToServer(seconds);
}

/**
 * Push the current (or explicitly given) auto-logout duration to the
 * session-settings endpoint. Safe to call opportunistically — failures are
 * logged, not thrown, since this must never block the caller.
 */
export function syncInactivityTimeoutToServer(seconds: number | null = getAutoLogoutSeconds()): Promise<void> {
  return fetch('/api/auth/session-settings', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inactivityTimeoutSeconds: seconds }),
  })
    .then(() => undefined)
    .catch((err) => {
      log.warn('[auto-logout] failed to sync inactivity timeout to server', err);
    });
}

export function formatAutoLogoutLabel(seconds: number | null): string {
  const match = AUTO_LOGOUT_OPTIONS.find((o) => o.value === seconds);
  if (match) return match.label;
  if (seconds === null) return 'Off';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

/**
 * Hook that tracks user activity and locks the session after the configured
 * inactivity interval.
 */
export function useAutoLogout(active: boolean): void {
  const router = useRouter();
  // Select only the stable `lock` function, not the whole store. The store
  // updates every second while unlocked (TOTP refresh), and subscribing to
  // the full store here would re-run this effect — and its unconditional
  // reset() call — every second, so the inactivity timer would never reach
  // its deadline and auto-logout would effectively never fire.
  const lock = useRelayAuthStoreV2((s) => s.lock);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const lastResetRef = useRef(0);

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;

    // Re-arm for a fresh session (e.g. re-login after a previous auto-logout
    // fired in the same mounted component instance).
    firedRef.current = false;

    // A brand-new server session (fresh login) starts with no configured
    // inactivity timeout until this runs — sync the client's already-chosen
    // value (from a previous session, if any) so server-side enforcement
    // (app/api/auth/session-settings/route.ts) is in effect from the start
    // of this session too, not just after the user next visits Settings.
    void syncInactivityTimeoutToServer();

    const getTimeoutMs = (): number | null => {
      const s = getAutoLogoutSeconds();
      return s ? s * 1000 : null;
    };

    const fire = () => {
      if (firedRef.current) return;
      const ms = getTimeoutMs();
      if (!ms) return;
      firedRef.current = true;
      try {
        lock();
      } catch (err) { log.warn('[auto-logout] lock failed', err); }
      try { toast.info('Signed out due to inactivity.'); } catch { /* toast optional */ }
      router.push('/auth/login');
    };

    const reset = () => {
      if (firedRef.current) return;
      // Activity events (mousemove especially) can fire dozens of times per
      // second; throttle so we're not hitting localStorage + clearTimeout/
      // setTimeout on every single one.
      const now = Date.now();
      if (now - lastResetRef.current < 1000) return;
      lastResetRef.current = now;
      if (timerRef.current) clearTimeout(timerRef.current);
      const ms = getTimeoutMs();
      if (!ms) return;
      timerRef.current = setTimeout(fire, ms);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) reset();
    };

    const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'touchstart'];
    for (const ev of events) window.addEventListener(ev, reset, { passive: true });
    window.addEventListener('storage', onStorage);

    reset();

    return () => {
      for (const ev of events) window.removeEventListener(ev, reset);
      window.removeEventListener('storage', onStorage);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, lock, router]);
}
