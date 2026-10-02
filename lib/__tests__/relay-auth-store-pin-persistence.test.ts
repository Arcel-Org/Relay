/**
 * Regression coverage for the PIN-attempt wipe counter's durability.
 *
 * Before this fix, `pinAttempts` lived only in Zustand's in-memory state
 * (this store has no `persist()` middleware) — a page reload reset it to 0,
 * so an attacker with the device could guess indefinitely at one PIN per
 * reload, and the "wipe after 5 wrong attempts" feature never actually
 * fired. The fix persists the count to the user's IndexedDB record
 * (`failedPinAttempts`) and reads FROM there, not from Zustand, when
 * deciding whether to wipe.
 *
 * A reload is simulated directly: IndexedDB (mocked here) already holds a
 * failedPinAttempts count from a "previous session," while the Zustand
 * store's pinAttempts is forced back to 0 — exactly what happens on a real
 * page reload — before calling attemptLogin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUsers = new Map<string, any>();

vi.mock('@/lib/db/relay-db', () => ({
  getUserByRelayId: vi.fn(async (relayId: string) => mockUsers.get(relayId) ?? null),
  saveUser: vi.fn(async (user: any) => { mockUsers.set(user.relayId, user); }),
  getAllUsers: vi.fn(async () => Array.from(mockUsers.values())),
  deleteUser: vi.fn(async (id: string) => {
    for (const [relayId, u] of mockUsers) if (u.id === id) mockUsers.delete(relayId);
  }),
  initDB: vi.fn(async () => {}),
}));

vi.mock('@/lib/crypto/relay-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/relay-auth')>();
  return { ...actual, recoverIdentity: vi.fn(), verifyDuressPin: vi.fn(async () => false) };
});

vi.mock('@/lib/db/relay-store', () => ({ clearAllStorage: vi.fn(async () => {}) }));
vi.mock('@/lib/messaging/ephemeral-contacts', () => ({ clearEphemeralContacts: vi.fn() }));

import { useRelayAuthStoreV2 } from '../crypto/relay-auth-store-v2';
import { recoverIdentity } from '../crypto/relay-auth';
import { saveUser, deleteUser } from '../db/relay-db';

const RELAY_ID = 'relay:testuser1';

function seedUser(overrides: Record<string, unknown> = {}) {
  const user = {
    id: 'user-1',
    relayId: RELAY_ID,
    publicKeyHex: 'cc'.repeat(32),
    encryptedPrivateKey: 'aa'.repeat(32),
    encryptedTOTPSecret: 'dd'.repeat(16),
    encryptedTOTPSecretForRecovery: 'ee'.repeat(16),
    deviceFingerprint: 'fp-1',
    createdAt: Date.now(),
    failedPinAttempts: 0,
    ...overrides,
  };
  mockUsers.set(RELAY_ID, user);
  return user;
}

beforeEach(() => {
  mockUsers.clear();
  vi.mocked(saveUser).mockClear();
  vi.mocked(deleteUser).mockClear();
  vi.mocked(recoverIdentity).mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) } as Response)));
  useRelayAuthStoreV2.setState({ currentRelayId: RELAY_ID, pinAttempts: 0 });
});

describe('attemptLogin — persisted PIN-attempt counter', () => {
  it('persists the failed-attempt count to IndexedDB on a wrong PIN, not just Zustand state', async () => {
    seedUser({ failedPinAttempts: 0 });
    vi.mocked(recoverIdentity).mockRejectedValue(new Error('wrong pin'));

    const ok = await useRelayAuthStoreV2.getState().attemptLogin('0000');

    expect(ok).toBe(false);
    expect(saveUser).toHaveBeenCalledWith(expect.objectContaining({ failedPinAttempts: 1 }));
  });

  it('wipes on the persisted 5th attempt even when Zustand pinAttempts was reset to 0 (simulated reload)', async () => {
    // Simulates: 4 wrong guesses already happened in a prior session and
    // were persisted; the page was then reloaded, so Zustand's pinAttempts
    // — read fresh here — is back at 0, same as any real reload.
    seedUser({ failedPinAttempts: 4 });
    useRelayAuthStoreV2.setState({ pinAttempts: 0 });
    vi.mocked(recoverIdentity).mockRejectedValue(new Error('wrong pin'));

    await expect(useRelayAuthStoreV2.getState().attemptLogin('0000')).rejects.toThrow(
      /too many failed pin attempts/i
    );

    // The wipe fired off the PERSISTED count (4 -> 5), not the reset-to-0
    // in-memory value — that's the entire point of the fix.
    expect(deleteUser).toHaveBeenCalledWith('user-1');
  });

  it('does NOT wipe on a 4th persisted attempt (below threshold)', async () => {
    seedUser({ failedPinAttempts: 3 });
    useRelayAuthStoreV2.setState({ pinAttempts: 0 });
    vi.mocked(recoverIdentity).mockRejectedValue(new Error('wrong pin'));

    const ok = await useRelayAuthStoreV2.getState().attemptLogin('0000');

    expect(ok).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(saveUser).toHaveBeenCalledWith(expect.objectContaining({ failedPinAttempts: 4 }));
  });

  it('resets the persisted count to 0 on a successful login', async () => {
    seedUser({ failedPinAttempts: 3 });
    vi.mocked(recoverIdentity).mockResolvedValue({
      privateKey: new Uint8Array(32).fill(1),
      publicKey: new Uint8Array(32).fill(2),
      relayId: RELAY_ID,
      mnemonicWords: [],
      pqPrivateKey: new Uint8Array(32).fill(3),
    });

    const ok = await useRelayAuthStoreV2.getState().attemptLogin('1234');

    expect(ok).toBe(true);
    expect(saveUser).toHaveBeenCalledWith(expect.objectContaining({ failedPinAttempts: 0 }));
  });
});
