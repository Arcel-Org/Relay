/**
 * Regression coverage for the QR device-pairing PQ-public-key gap
 * (lib/messaging/identity.ts). A QR-paired device never gets a local
 * `users` IndexedDB row (getUserByRelayId returns nothing for it), so
 * before this fix its own PQ public key had no source at all and every
 * session it opened silently downgraded to classical-only key exchange
 * (see lib/messaging/key-exchange.ts's bothPqCapable check). The fix:
 * fall back to the session record's pqPublicKeyHex, populated at pairing
 * time by components/DeviceSyncQR.tsx.
 *
 * useCallback is mocked to a passthrough (same technique as
 * dictionary-fallback-caching.test.ts) so the hook can be called directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useCallback: (fn: unknown) => fn };
});

const getUserByRelayId = vi.fn();
vi.mock('@/lib/db/relay-db', () => ({
  getUserByRelayId: (relayId: string) => getUserByRelayId(relayId),
}));

const loadSession = vi.fn();
vi.mock('@/lib/auth/session-persistence', () => ({
  loadSession: () => loadSession(),
}));

vi.mock('@/components/ToastNotification', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { useIdentity } from '../messaging/identity';
import { toHex } from '@/lib/crypto/hex-utils';

function makeShared() {
  return { identityRef: { current: null } } as any;
}

const PRIVATE_KEY_HEX = '11'.repeat(32);
const PQ_PUBLIC_KEY_HEX = 'ab'.repeat(64);

beforeEach(() => {
  getUserByRelayId.mockReset();
  loadSession.mockReset();
});

describe('useIdentity — PQ public key session fallback for QR-paired devices', () => {
  it('uses the IndexedDB users-row PQ public key when a local row exists (unchanged behavior)', async () => {
    getUserByRelayId.mockResolvedValue({ pqPublicKeyHex: PQ_PUBLIC_KEY_HEX });
    const authStore = {
      getPrivateKey: () => Uint8Array.from(Buffer.from(PRIVATE_KEY_HEX, 'hex')),
      currentRelayId: 'relay-1',
      getPqPrivateKey: () => null,
    };
    const loadIdentity = useIdentity({
      shared: makeShared(),
      authStore,
      router: { push: vi.fn() } as any,
      setError: vi.fn(),
    });

    const result = await loadIdentity();

    expect(result?.pqPublicKey && toHex(result.pqPublicKey)).toBe(PQ_PUBLIC_KEY_HEX);
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('THE REGRESSION: falls back to session.pqPublicKeyHex when no local users row exists (QR-paired device)', async () => {
    getUserByRelayId.mockResolvedValue(undefined);
    loadSession.mockReturnValue({ pqPublicKeyHex: PQ_PUBLIC_KEY_HEX });
    const authStore = {
      getPrivateKey: () => Uint8Array.from(Buffer.from(PRIVATE_KEY_HEX, 'hex')),
      currentRelayId: 'relay-1',
      getPqPrivateKey: () => null,
    };
    const loadIdentity = useIdentity({
      shared: makeShared(),
      authStore,
      router: { push: vi.fn() } as any,
      setError: vi.fn(),
    });

    const result = await loadIdentity();

    expect(result?.pqPublicKey && toHex(result.pqPublicKey)).toBe(PQ_PUBLIC_KEY_HEX);
  });

  it('leaves pqPublicKey undefined when neither the users row nor the session has one', async () => {
    getUserByRelayId.mockResolvedValue(undefined);
    loadSession.mockReturnValue({});
    const authStore = {
      getPrivateKey: () => Uint8Array.from(Buffer.from(PRIVATE_KEY_HEX, 'hex')),
      currentRelayId: 'relay-1',
      getPqPrivateKey: () => null,
    };
    const loadIdentity = useIdentity({
      shared: makeShared(),
      authStore,
      router: { push: vi.fn() } as any,
      setError: vi.fn(),
    });

    const result = await loadIdentity();

    expect(result?.pqPublicKey).toBeUndefined();
  });
});
