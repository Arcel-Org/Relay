import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveSession,
  loadSession,
  clearSession,
  isSessionValid,
  shouldShowPINAgain,
  updateSessionActivity,
  getSessionDuration,
  formatGracePeriod,
  type SessionData,
} from '../auth/session-persistence';

// This is the foundation of the entire lock/logout security model — every
// unlock check ultimately rests on isSessionValid()/loadSession() reading
// back exactly what saveSession()/clearSession() wrote. No test file
// exercised any of this directly before (only indirectly, through the auth
// store and e2e flows), so a bug here (e.g. a session surviving clearSession,
// or expiring too early/late) had no regression coverage at all.

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  return {
    userId: 'user-1',
    relayId: 'abcd-1234',
    publicKeyHex: 'ab'.repeat(32),
    sessionToken: 'tok-1',
    loginTime: now,
    lastActivityTime: now,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('saveSession / loadSession round-trip', () => {
  it('loads back exactly what was saved', () => {
    const session = makeSession({ username: 'alice', privateKeyHex: 'deadbeef' });
    saveSession(session);

    const loaded = loadSession();
    expect(loaded).toEqual(session);
  });

  it('returns null when nothing has been saved', () => {
    expect(loadSession()).toBeNull();
  });

  it('returns null (not a throw) for corrupted sessionStorage content', () => {
    sessionStorage.setItem('relay:session', 'not-a-valid-obfuscated-blob');
    expect(() => loadSession()).not.toThrow();
    expect(loadSession()).toBeNull();
  });
});

describe('clearSession', () => {
  it('removes the session so a subsequent load returns null', () => {
    saveSession(makeSession());
    expect(loadSession()).not.toBeNull();

    clearSession();
    expect(loadSession()).toBeNull();
  });
});

describe('isSessionValid', () => {
  it('is false for null', () => {
    expect(isSessionValid(null)).toBe(false);
  });

  it('is true for a session within the grace period', () => {
    expect(isSessionValid(makeSession())).toBe(true);
  });

  it('is false once the grace period (24h) has elapsed since last activity', () => {
    const stale = makeSession({ lastActivityTime: Date.now() - 25 * 60 * 60 * 1000 });
    expect(isSessionValid(stale)).toBe(false);
  });

  it('falls back to loginTime for sessions predating lastActivityTime', () => {
    const now = Date.now();
    const legacyShapeSession = { ...makeSession({ loginTime: now }), lastActivityTime: undefined } as unknown as SessionData;
    expect(isSessionValid(legacyShapeSession)).toBe(true);

    const legacyStale = { ...makeSession({ loginTime: now - 25 * 60 * 60 * 1000 }), lastActivityTime: undefined } as unknown as SessionData;
    expect(isSessionValid(legacyStale)).toBe(false);
  });

  it('shouldShowPINAgain is the exact negation of isSessionValid', () => {
    const valid = makeSession();
    const stale = makeSession({ lastActivityTime: Date.now() - 25 * 60 * 60 * 1000 });
    expect(shouldShowPINAgain(valid)).toBe(!isSessionValid(valid));
    expect(shouldShowPINAgain(stale)).toBe(!isSessionValid(stale));
  });
});

describe('updateSessionActivity', () => {
  it('bumps lastActivityTime without mutating other fields', () => {
    vi.useFakeTimers();
    try {
      const original = makeSession({ lastActivityTime: 1000 });
      vi.setSystemTime(5000);
      const updated = updateSessionActivity(original);
      expect(updated.lastActivityTime).toBe(5000);
      expect(updated.userId).toBe(original.userId);
      expect(updated.relayId).toBe(original.relayId);
      // Original object must not be mutated in place.
      expect(original.lastActivityTime).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends validity when re-saved after being refreshed', () => {
    const almostStale = makeSession({ lastActivityTime: Date.now() - 23.9 * 60 * 60 * 1000 });
    expect(isSessionValid(almostStale)).toBe(true);
    const refreshed = updateSessionActivity(almostStale);
    saveSession(refreshed);
    expect(isSessionValid(loadSession())).toBe(true);
  });
});

describe('getSessionDuration / formatGracePeriod', () => {
  it('getSessionDuration reflects elapsed time since loginTime', () => {
    const session = makeSession({ loginTime: Date.now() - 10_000 });
    expect(getSessionDuration(session)).toBeGreaterThanOrEqual(10_000);
  });

  it('formatGracePeriod reports "Expired" once the grace period has passed', () => {
    const stale = makeSession({ lastActivityTime: Date.now() - 25 * 60 * 60 * 1000 });
    expect(formatGracePeriod(stale)).toBe('Expired');
  });

  it('formatGracePeriod reports remaining time for a live session', () => {
    const fresh = makeSession();
    expect(formatGracePeriod(fresh)).toMatch(/remaining$/);
  });
});
