/**
 * Coverage for lib/messaging/contact-bookkeeping.ts's RelayMessagingService
 * — previously zero direct unit tests (round-6 audit, LOW finding #8). This
 * is a legacy localStorage-backed bookkeeping layer (see the file's own
 * header: real message traffic goes through relay-websocket.ts +
 * use-relay-messaging.ts instead), so these tests focus on what it actually
 * owns — contact upsert/removal scoped per-userId on a shared storage key,
 * and expired-message cleanup — not on cryptographic correctness, which is
 * mocked out here and covered separately wherever relay-crypto.ts is tested.
 *
 * RelayMessagingService is a singleton (static `instance` field), so each
 * test resets the module registry and re-imports to get a fresh instance —
 * otherwise state would leak across tests via the class's own static cache.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/crypto/relay-crypto', () => ({
  buildDictionary: vi.fn(() => new Uint8Array([1, 2, 3])),
  computeSharedSecret: vi.fn(() => new Uint8Array([9, 9, 9])),
  deriveSessionRole: vi.fn(() => 'initiator'),
  Session: class {
    constructor() {}
  },
}));

let authStoreCurrentUserId: string | null = null;
vi.mock('@/lib/crypto/relay-auth-store-v2', () => ({
  useRelayAuthStoreV2: { getState: () => ({ currentUserId: authStoreCurrentUserId }) },
}));

const OTHER_USER_ID = 'other-user';
const CONTACT_ID = 'contact-1';

function seedUsers(...ids: string[]) {
  localStorage.setItem(
    'relay:users',
    JSON.stringify(
      ids.map((id) => ({
        id,
        name: 'Me',
        publicKey: [1, 2, 3],
        privateKey: [4, 5, 6],
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        isVerified: true,
      }))
    )
  );
}
function seedUser(id: string) {
  seedUsers(id);
}

beforeEach(() => {
  localStorage.clear();
  authStoreCurrentUserId = null;
  vi.resetModules();
});

describe('current user tracking', () => {
  it('persists the current user id to localStorage and survives a fresh instance', async () => {
    const { getMessagingService } = await import('../messaging/contact-bookkeeping');
    getMessagingService().setCurrentUserId('user-1');

    vi.resetModules();
    const { getMessagingService: getFresh } = await import('../messaging/contact-bookkeeping');
    expect(getFresh().getCurrentUserId()).toBe('user-1');
  });
});

describe('addContact / getContacts / removeContact', () => {
  it('adds a contact for the current user and returns it via getContacts/getContactsAsInterface', async () => {
    seedUser('user-1');
    const { getMessagingService } = await import('../messaging/contact-bookkeeping');
    const service = getMessagingService();
    service.setCurrentUserId('user-1');

    const contact = await service.addContact(CONTACT_ID, 'Alice', new Uint8Array([7, 7, 7]));
    expect(contact.name).toBe('Alice');
    expect(contact.relayId).toBe(CONTACT_ID);
    expect(contact.isOnline).toBe(false); // pre-presence default, not random

    expect(service.getContacts()).toHaveLength(1);
    expect(service.getContactsAsInterface()[0].name).toBe('Alice');
  });

  it('throws "Not logged in" when there is no current user and the auth-store fallback is also empty', async () => {
    const { getMessagingService } = await import('../messaging/contact-bookkeeping');
    await expect(getMessagingService().addContact(CONTACT_ID, 'Alice', new Uint8Array([7]))).rejects.toThrow(/Not logged in/);
  });

  it('falls back to the auth store for currentUserId when not already set locally', async () => {
    seedUser('user-1');
    authStoreCurrentUserId = 'user-1';
    const { getMessagingService } = await import('../messaging/contact-bookkeeping');
    const service = getMessagingService();

    const contact = await service.addContact(CONTACT_ID, 'Alice', new Uint8Array([7]));
    expect(contact.relayId).toBe(CONTACT_ID);
    expect(service.getCurrentUserId()).toBe('user-1'); // fallback also persisted it
  });

  it('re-adding the same contact upserts rather than duplicating', async () => {
    seedUser('user-1');
    const { getMessagingService } = await import('../messaging/contact-bookkeeping');
    const service = getMessagingService();
    service.setCurrentUserId('user-1');

    await service.addContact(CONTACT_ID, 'Alice', new Uint8Array([1]));
    await service.addContact(CONTACT_ID, 'Alice Updated', new Uint8Array([2]));

    const contacts = service.getContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].contactName).toBe('Alice Updated');
  });

  it('addContact/removeContact for one userId never touches another userId\'s contacts sharing the same storage', async () => {
    seedUsers('user-1', OTHER_USER_ID);
    const { getMessagingService } = await import('../messaging/contact-bookkeeping');
    const service = getMessagingService();

    service.setCurrentUserId('user-1');
    await service.addContact(CONTACT_ID, 'Alice (user-1)', new Uint8Array([1]));

    service.setCurrentUserId(OTHER_USER_ID);
    await service.addContact(CONTACT_ID, 'Alice (other-user)', new Uint8Array([2]));

    // Removing from other-user's view must not remove user-1's entry.
    await service.removeContact(CONTACT_ID);
    expect(service.getContacts()).toHaveLength(0);

    service.setCurrentUserId('user-1');
    expect(service.getContacts()).toHaveLength(1);
    expect(service.getContacts()[0].contactName).toBe('Alice (user-1)');
  });
});

describe('cleanupExpiredMessages', () => {
  it('removes only messages whose expiresAt is in the past, and reports how many were removed', async () => {
    const now = Date.now();
    localStorage.setItem(
      'relay:messages',
      JSON.stringify([
        {
          id: 'expired-1',
          fromUserId: 'user-1',
          toUserId: 'user-2',
          encryptedContent: [1, 2, 3],
          nonce: [4, 5, 6],
          timestamp: new Date(now - 60_000).toISOString(),
          expiresAt: new Date(now - 1_000).toISOString(),
          read: false,
          delivered: true,
        },
        {
          id: 'still-valid',
          fromUserId: 'user-1',
          toUserId: 'user-2',
          encryptedContent: [7, 8, 9],
          nonce: [1, 1, 1],
          timestamp: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          read: false,
          delivered: true,
        },
      ])
    );

    const { getMessagingService } = await import('../messaging/contact-bookkeeping');
    const service = getMessagingService();
    service.setCurrentUserId('user-1');

    const removedCount = await service.cleanupExpiredMessages();
    expect(removedCount).toBe(1);
    expect(service.getConversation('user-2').map((m) => m.id)).toEqual(['still-valid']);
  });
});
