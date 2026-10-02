import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRelayAuthStoreV2 } from '../crypto/relay-auth-store-v2';
import { loadSession } from '../auth/session-persistence';

// lock()/logout() are the core of the app's security boundary — the private
// key, PQ key, and TOTP secret all live in module-level refs (not the
// zustand-visible state), so a bug here would only ever show up as "the app
// still has key material after the user believes they locked/logged out."
// No test file exercised this before; e2e coverage only clicks the UI logout
// button and checks the session cookie/redirect, not the key material or
// the lock-only (session-preserved-but-relocked) path.
//
// completeApiLogin() is used to seed an "unlocked" state because it's the
// only entry point that sets the module-level key refs without depending on
// network/IndexedDB (attemptLogin/completeSignupStep3 both do).

const PRIVATE_KEY_HEX = 'aa'.repeat(32);
const PQ_PRIVATE_KEY_HEX = 'bb'.repeat(64);
const PUBLIC_KEY_HEX = 'cc'.repeat(32);

function seedUnlockedSession() {
  useRelayAuthStoreV2.getState().completeApiLogin(
    PRIVATE_KEY_HEX,
    PUBLIC_KEY_HEX,
    'user-1',
    'relay:testuser1',
    'alice',
    PQ_PRIVATE_KEY_HEX,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
  seedUnlockedSession();
});

describe('completeApiLogin (test seam sanity check)', () => {
  it('actually establishes an unlocked session with real key material', () => {
    const state = useRelayAuthStoreV2.getState();
    expect(state.isUnlocked).toBe(true);
    expect(state.flow).toBe('authenticated');
    expect(state.getPrivateKey()).not.toBeNull();
    expect(state.getPqPrivateKey()).not.toBeNull();
    expect(state.getTOTPSecret()).not.toBeNull();
    expect(loadSession()?.privateKeyHex).toBe(PRIVATE_KEY_HEX);
  });
});

describe('lock()', () => {
  it('clears all in-memory key material', () => {
    useRelayAuthStoreV2.getState().lock();
    const state = useRelayAuthStoreV2.getState();
    expect(state.getPrivateKey()).toBeNull();
    expect(state.getPqPrivateKey()).toBeNull();
    expect(state.getTOTPSecret()).toBeNull();
  });

  it('flips isUnlocked to false and flow to login', () => {
    useRelayAuthStoreV2.getState().lock();
    const state = useRelayAuthStoreV2.getState();
    expect(state.isUnlocked).toBe(false);
    expect(state.flow).toBe('login');
  });

  it('strips the private/PQ key hex from the persisted session but keeps the rest, so the user re-enters a PIN, not their whole identity', () => {
    useRelayAuthStoreV2.getState().lock();
    const session = loadSession();
    expect(session).not.toBeNull();
    expect(session!.privateKeyHex).toBeUndefined();
    expect(session!.pqPrivateKeyHex).toBeUndefined();
    // Identity fields must survive — this is a re-lock, not a logout.
    expect(session!.userId).toBe('user-1');
    expect(session!.relayId).toBe('relay:testuser1');
  });

  it('does NOT clear currentRelayId/currentUserId — only logout() does that', () => {
    useRelayAuthStoreV2.getState().lock();
    const state = useRelayAuthStoreV2.getState();
    expect(state.currentRelayId).toBe('relay:testuser1');
    expect(state.currentUserId).toBe('user-1');
  });

  it('is idempotent — locking an already-locked store does not throw', () => {
    useRelayAuthStoreV2.getState().lock();
    expect(() => useRelayAuthStoreV2.getState().lock()).not.toThrow();
    expect(useRelayAuthStoreV2.getState().isUnlocked).toBe(false);
  });
});

describe('logout()', () => {
  it('clears all in-memory key material', () => {
    useRelayAuthStoreV2.getState().logout();
    const state = useRelayAuthStoreV2.getState();
    expect(state.getPrivateKey()).toBeNull();
    expect(state.getPqPrivateKey()).toBeNull();
    expect(state.getTOTPSecret()).toBeNull();
  });

  it('fully clears the persisted session (unlike lock, not just the key hex)', () => {
    useRelayAuthStoreV2.getState().logout();
    expect(loadSession()).toBeNull();
  });

  it('clears identity from state — currentUserId/currentRelayId/currentUsername all null', () => {
    useRelayAuthStoreV2.getState().logout();
    const state = useRelayAuthStoreV2.getState();
    expect(state.currentUserId).toBeNull();
    expect(state.currentRelayId).toBeNull();
    expect(state.currentUsername).toBeNull();
    expect(state.isUnlocked).toBe(false);
    expect(state.flow).toBe('login');
    expect(state.pinAttempts).toBe(0);
  });

  it('revokes the session cookie server-side (calls /api/auth/logout)', async () => {
    useRelayAuthStoreV2.getState().logout();
    // The revoke call is fire-and-forget (chained after the push-token
    // unregister, itself a no-op here since Capacitor isn't present) —
    // flush microtasks so it has a chance to fire before asserting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
  });
});
