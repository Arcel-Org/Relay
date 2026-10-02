/**
 * Direct coverage for lib/db/relay-db.ts — the client-side IndexedDB
 * identity store (raw, not the encrypted-at-rest relay-store.ts wrapper).
 * Previously zero test coverage despite holding encryptedPrivateKey,
 * encryptedTOTPSecret, duressPinHash, and failedPinAttempts.
 *
 * Uses fake-indexeddb (a real IndexedDB implementation) — this project's
 * jsdom test environment has no native `indexedDB` global otherwise.
 *
 * Deliberately does NOT delete the main database between tests —
 * relay-db.ts keeps a module-level `db` connection open with no exported
 * close(), and a previous test's (now-stale, but still-open) module
 * instance holding that connection makes indexedDB.deleteDatabase() hang
 * waiting on onblocked forever (confirmed empirically: every test after the
 * first timed out). Instead, CRUD tests below explicitly clearAllUsers()
 * first for a clean slate, and every test uses relayIds/ids unique to
 * itself so leftover rows from unrelated tests/files sharing the same
 * simulated storage can never collide with or be mistaken for its own.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(async () => {
  localStorage.clear();
});

function makeUser(overrides: Partial<import('../db/relay-db').RelayUser> = {}) {
  return {
    id: overrides.id || 'user-1',
    relayId: overrides.relayId || 'abcd-1234',
    publicKeyHex: 'ab'.repeat(32),
    encryptedPrivateKey: 'encrypted-private-key-hex',
    encryptedTOTPSecret: 'encrypted-totp-hex',
    encryptedTOTPSecretForRecovery: '',
    deviceFingerprint: 'fp-1',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('saveUser / getUserByRelayId', () => {
  it('round-trips a saved user', async () => {
    const { saveUser, getUserByRelayId, clearAllUsers } = await import('../db/relay-db');
    await clearAllUsers();
    const user = makeUser({ id: 'rt-1', relayId: 'abcd-1234' });
    await saveUser(user);

    const found = await getUserByRelayId('abcd-1234');
    expect(found).toEqual(user);
  });

  it('returns null for an unknown relayId', async () => {
    const { getUserByRelayId, clearAllUsers } = await import('../db/relay-db');
    await clearAllUsers();
    expect(await getUserByRelayId('ffff-0000')).toBeNull();
  });
});

describe('getAllUsers / hasUsers / deleteUser / clearAllUsers', () => {
  it('getAllUsers returns every stored user', async () => {
    const { saveUser, getAllUsers, clearAllUsers } = await import('../db/relay-db');
    await clearAllUsers();
    await saveUser(makeUser({ id: 'u1', relayId: 'aaaa-1111' }));
    await saveUser(makeUser({ id: 'u2', relayId: 'bbbb-2222' }));

    const all = await getAllUsers();
    expect(all.map((u) => u.relayId).sort()).toEqual(['aaaa-1111', 'bbbb-2222']);
  });

  it('hasUsers reflects whether any user is stored', async () => {
    const { saveUser, hasUsers, clearAllUsers } = await import('../db/relay-db');
    await clearAllUsers();
    expect(await hasUsers()).toBe(false);
    await saveUser(makeUser());
    expect(await hasUsers()).toBe(true);
  });

  it('deleteUser removes only the targeted user by id', async () => {
    const { saveUser, deleteUser, getAllUsers, clearAllUsers } = await import('../db/relay-db');
    await clearAllUsers();
    await saveUser(makeUser({ id: 'u1', relayId: 'aaaa-1111' }));
    await saveUser(makeUser({ id: 'u2', relayId: 'bbbb-2222' }));

    await deleteUser('u1');
    const all = await getAllUsers();
    expect(all.map((u) => u.id)).toEqual(['u2']);
  });

  it('clearAllUsers wipes every stored user', async () => {
    const { saveUser, clearAllUsers, getAllUsers } = await import('../db/relay-db');
    await clearAllUsers();
    await saveUser(makeUser({ id: 'u1', relayId: 'aaaa-1111' }));
    await saveUser(makeUser({ id: 'u2', relayId: 'bbbb-2222' }));

    await clearAllUsers();
    expect(await getAllUsers()).toEqual([]);
  });
});

describe('security-relevant fields survive the round-trip untouched', () => {
  it('duressPinHash and failedPinAttempts persist exactly', async () => {
    const { saveUser, getUserByRelayId, clearAllUsers } = await import('../db/relay-db');
    await clearAllUsers();
    await saveUser(makeUser({ id: 'duress-1', relayId: 'dddd-4321', duressPinHash: 'duress-hash-abc', failedPinAttempts: 3 }));

    const found = await getUserByRelayId('dddd-4321');
    expect(found?.duressPinHash).toBe('duress-hash-abc');
    expect(found?.failedPinAttempts).toBe(3);
  });
});
