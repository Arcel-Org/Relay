/**
 * Direct coverage for lib/db/relay-store.ts — the encrypted IndexedDB
 * storage layer. Previously only exercised indirectly, as a dependency of
 * other tests (backup-export-kdf, relay-device-sync, relay-vault,
 * receive-signature-verification) — none of them targeted relay-store's
 * own storage/encryption/indexing logic in isolation.
 *
 * Uses fake-indexeddb (a real IndexedDB implementation, not a mock of
 * relay-store's own functions) so the actual encrypt/decrypt round-trip,
 * indexing, and locking logic all run for real — this project's jsdom test
 * environment has no native `indexedDB` global otherwise.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { set as idbSet, get as idbGet } from 'idb-keyval';
import {
  initStorage,
  addContact,
  getContact,
  getAllContacts,
  upsertContact,
  addMessage,
  getMessage,
  getAllMessagesForConversation,
  deleteMessage,
  addConversation,
  getAllConversations,
  clearAllStorage,
  type StoredContact,
  type StoredMessage,
} from '../db/relay-store';

const PRIVATE_KEY = new Uint8Array(32).fill(9);

beforeEach(async () => {
  await initStorage(PRIVATE_KEY);
  await clearAllStorage();
  // clearAllStorage() also wipes localStorage, which initStorage doesn't
  // depend on — re-init is not required, storageKey is a separate
  // in-memory module var untouched by clearAllStorage().
});

function makeContact(relayId: string, overrides: Partial<StoredContact> = {}): StoredContact {
  return {
    relayId,
    name: relayId.slice(0, 8),
    publicKeyHex: 'ab'.repeat(32),
    addedAt: Date.now(),
    ...overrides,
  };
}

function makeMessage(id: string, conversationId: string, overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id,
    conversationId,
    senderId: 'relay:someone',
    text: `message ${id}`,
    timestamp: Date.now(),
    status: 'delivered',
    ...overrides,
  };
}

describe('contacts: CRUD round-trip', () => {
  it('addContact + getContact round-trips exactly', async () => {
    const c = makeContact('relay:alice');
    await addContact(c);
    expect(await getContact('relay:alice')).toEqual(c);
  });

  it('getContact returns null for an unknown relayId', async () => {
    expect(await getContact('relay:nobody')).toBeNull();
  });

  it('upsertContact merges fields onto an existing contact', async () => {
    await addContact(makeContact('relay:alice', { name: 'Alice' }));
    const updated = await upsertContact('relay:alice', { lastSeenAt: 12345 });
    expect(updated.name).toBe('Alice');
    expect(updated.lastSeenAt).toBe(12345);
    expect((await getContact('relay:alice'))?.lastSeenAt).toBe(12345);
  });

  it('getAllContacts returns every stored contact', async () => {
    await addContact(makeContact('relay:alice'));
    await addContact(makeContact('relay:bob'));
    const all = await getAllContacts();
    expect(all.map((c) => c.relayId).sort()).toEqual(['relay:alice', 'relay:bob']);
  });
});

describe('contacts: encrypted at rest', () => {
  it('the raw stored value is not the plaintext JSON', async () => {
    await addContact(makeContact('relay:alice', { name: 'Alice Secret Name' }));
    const raw = await idbGet('contact:relay:alice');
    // Not `toBeInstanceOf(Uint8Array)` — fake-indexeddb's structured-clone
    // path can return a typed array from a different realm than this
    // test's own `Uint8Array` global (same class of issue noted in
    // receive-signature-verification.test.ts); check it's array-like
    // instead of asserting same-realm identity.
    expect(raw).toBeTruthy();
    expect(typeof (raw as any).length).toBe('number');
    expect((raw as any).length).toBeGreaterThan(0);
    const asText = new TextDecoder().decode(new Uint8Array(raw as any));
    expect(asText).not.toContain('Alice Secret Name');
    expect(asText).not.toContain('relay:alice');
  });
});

describe('contacts: one corrupted record does not blank out the others (regression)', () => {
  it('getAllContacts skips an undecryptable record instead of losing every other contact', async () => {
    await addContact(makeContact('relay:alice'));
    await addContact(makeContact('relay:bob'));
    // Simulate a foreign-account/corrupted record: garbage bytes that will
    // fail AEAD authentication when relay-store tries to decrypt it.
    await idbSet('contact:relay:corrupted', new Uint8Array(40).fill(0xff));

    const all = await getAllContacts();
    expect(all.map((c) => c.relayId).sort()).toEqual(['relay:alice', 'relay:bob']);
  });
});

describe('messages: CRUD + conversation index', () => {
  it('addMessage + getMessage round-trips exactly', async () => {
    const m = makeMessage('m1', 'conv1');
    await addMessage(m);
    expect(await getMessage('m1')).toEqual(m);
  });

  it('getAllMessagesForConversation returns only that conversation\'s messages, sorted by timestamp', async () => {
    await addMessage(makeMessage('m2', 'conv1', { timestamp: 200 }));
    await addMessage(makeMessage('m1', 'conv1', { timestamp: 100 }));
    await addMessage(makeMessage('other', 'conv2', { timestamp: 50 }));

    const msgs = await getAllMessagesForConversation('conv1');
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('deleteMessage removes it from both storage and the conversation index', async () => {
    await addMessage(makeMessage('m1', 'conv1'));
    await addMessage(makeMessage('m2', 'conv1'));
    await deleteMessage('m1');

    expect(await getMessage('m1')).toBeNull();
    const remaining = await getAllMessagesForConversation('conv1');
    expect(remaining.map((m) => m.id)).toEqual(['m2']);
  });

  it('concurrent addMessage calls for the SAME conversation are all indexed — none dropped by the read-modify-write race (withIndexLock regression)', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    await Promise.all(ids.map((id) => addMessage(makeMessage(id, 'conv-concurrent'))));

    const msgs = await getAllMessagesForConversation('conv-concurrent');
    expect(msgs.map((m) => m.id).sort()).toEqual([...ids].sort());
  });

  it('one corrupted message in the indexed lookup path does not blank out the rest of the conversation (regression)', async () => {
    await addMessage(makeMessage('good1', 'conv1'));
    await addMessage(makeMessage('good2', 'conv1'));
    // Corrupt one of the two — still referenced by the conversation index,
    // but its stored bytes fail to decrypt.
    await idbSet('msg:good2', new Uint8Array(40).fill(0xff));

    const msgs = await getAllMessagesForConversation('conv1');
    expect(msgs.map((m) => m.id)).toEqual(['good1']);
  });
});

describe('conversations', () => {
  it('addConversation + getAllConversations round-trips', async () => {
    await addConversation({ id: 'conv1', name: 'Conv 1', members: ['relay:alice'], createdAt: 1, lastMessageAt: 1, isGroup: false });
    const all = await getAllConversations();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('conv1');
  });
});

describe('clearAllStorage', () => {
  it('wipes contacts from IndexedDB', async () => {
    await addContact(makeContact('relay:alice'));
    await clearAllStorage();
    expect(await getContact('relay:alice')).toBeNull();
  });

  it('does not leave a stale value servable from the in-memory read cache (regression)', async () => {
    // getContact() itself isn't cached — getAllContacts() is (under the
    // 'all-contacts' key, 30s TTL), so that's what exercises the bug this
    // guards against.
    await addContact(makeContact('relay:alice'));
    expect(await getAllContacts()).toHaveLength(1); // populates the cache

    await clearAllStorage();

    // Without clearing the cache too, this could still return the
    // pre-wipe list for up to 30s even though IndexedDB is now empty —
    // exactly the gap this test guards against.
    expect(await getAllContacts()).toHaveLength(0);
  });
});
