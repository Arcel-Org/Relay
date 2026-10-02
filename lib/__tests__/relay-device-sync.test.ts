import { describe, it, expect, vi, beforeEach } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';

// Mock the IndexedDB-backed storage layer used by prepareSyncPayload /
// importSyncPayload so this test can run without a real IndexedDB (jsdom
// doesn't provide one, and the repo has no fake-indexeddb polyfill wired
// up). We keep an in-memory store instead.
vi.mock('../db/relay-store', () => {
  const contacts: any[] = [];
  const conversations: any[] = [];
  const messages: Record<string, any[]> = {};

  return {
    getAllContacts: vi.fn(async () => contacts),
    getAllConversations: vi.fn(async () => conversations),
    getAllMessagesForConversation: vi.fn(async (id: string) => messages[id] || []),
    addContact: vi.fn(async (c: any) => { contacts.push(c); }),
    getContact: vi.fn(async (relayId: string) => contacts.find((c) => c.relayId === relayId) ?? null),
    addConversation: vi.fn(async (c: any) => { conversations.push(c); }),
    addMessage: vi.fn(async (m: any) => {
      messages[m.conversationId] = messages[m.conversationId] || [];
      messages[m.conversationId].push(m);
    }),
    __seed: { contacts, conversations, messages },
  };
});

import * as relayStore from '../db/relay-store';
import {
  prepareSyncPayload,
  encryptSyncPayload,
  decryptSyncPayload,
  chunkSyncPayload,
  reassembleChunks,
  buildSyncQRFrames,
  parseSyncQRFrame,
  importSyncPayload,
  QR_SYNC_CHUNK_SIZE,
  type SyncPayload,
} from '../vault/relay-device-sync';

const seed = (relayStore as any).__seed as {
  contacts: any[];
  conversations: any[];
  messages: Record<string, any[]>;
};

function makeSharedSecretPair() {
  const alice = x25519.utils.randomSecretKey();
  const bob = x25519.utils.randomSecretKey();
  const alicePub = x25519.getPublicKey(alice);
  const bobPub = x25519.getPublicKey(bob);
  return {
    aliceShared: x25519.getSharedSecret(alice, bobPub),
    bobShared: x25519.getSharedSecret(bob, alicePub),
  };
}

describe('relay-device-sync — sync payload round trip', () => {
  beforeEach(() => {
    seed.contacts.length = 0;
    seed.conversations.length = 0;
    for (const key of Object.keys(seed.messages)) delete seed.messages[key];
    vi.clearAllMocks();
  });

  it('encrypts and decrypts a sync payload with a shared secret from ECDH', async () => {
    seed.contacts.push({
      relayId: 'alice-relay-id',
      name: 'Alice',
      publicKeyHex: 'aa'.repeat(32),
      addedAt: Date.now(),
    });
    seed.conversations.push({
      id: 'conv-1',
      name: 'Alice',
      members: ['alice-relay-id', 'me'],
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      isGroup: false,
    });
    seed.messages['conv-1'] = [
      { id: 'm1', conversationId: 'conv-1', senderId: 'alice-relay-id', text: 'hi', timestamp: 1, status: 'delivered' },
      { id: 'm2', conversationId: 'conv-1', senderId: 'me', text: 'hello back', timestamp: 2, status: 'delivered' },
    ];

    const payload = await prepareSyncPayload('deadbeef'.repeat(8));
    expect(payload.contacts).toHaveLength(1);
    expect(payload.conversations).toHaveLength(1);
    expect(payload.messages['conv-1']).toHaveLength(2);

    const { aliceShared, bobShared } = makeSharedSecretPair();

    const encrypted = await encryptSyncPayload(payload, aliceShared);
    const decrypted = await decryptSyncPayload(encrypted, bobShared);

    expect(decrypted).toEqual(payload);
  });

  it('rejects decryption with the wrong shared secret', async () => {
    const payload: SyncPayload = {
      version: 1,
      timestamp: Date.now(),
      privateKeyHex: 'ab'.repeat(32),
      contacts: [],
      conversations: [],
      messages: {},
    };
    const { aliceShared } = makeSharedSecretPair();
    const wrongSecret = x25519.utils.randomSecretKey();

    const encrypted = await encryptSyncPayload(payload, aliceShared);
    await expect(decryptSyncPayload(encrypted, wrongSecret)).rejects.toThrow();
  });

  it('chunks and reassembles an encrypted payload losslessly', async () => {
    const payload: SyncPayload = {
      version: 1,
      timestamp: Date.now(),
      privateKeyHex: 'cd'.repeat(32),
      contacts: Array.from({ length: 20 }, (_, i) => ({
        relayId: `contact-${i}`,
        name: `Contact ${i}`,
        publicKeyHex: 'bb'.repeat(32),
        addedAt: Date.now(),
      })),
      conversations: [],
      messages: {},
    };
    const { aliceShared, bobShared } = makeSharedSecretPair();
    const encrypted = await encryptSyncPayload(payload, aliceShared);

    // Force a small chunk size so this payload actually spans many chunks.
    const chunks = chunkSyncPayload(encrypted, 64);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].totalChunks).toBe(chunks.length);

    const map = new Map(chunks.map((c) => [c.chunkIndex, c.data]));
    const reassembled = reassembleChunks(map, chunks.length);
    expect(reassembled).toEqual(encrypted);

    const decrypted = await decryptSyncPayload(reassembled, bobShared);
    expect(decrypted).toEqual(payload);
  });

  it('reassembleChunks throws if a chunk is missing', () => {
    const map = new Map<number, Uint8Array>([[0, new Uint8Array([1])]]);
    expect(() => reassembleChunks(map, 2)).toThrow(/Missing chunk/);
  });

  it('round-trips a payload through the QR-frame carousel encoding', async () => {
    const payload: SyncPayload = {
      version: 1,
      timestamp: Date.now(),
      privateKeyHex: 'ef'.repeat(32),
      contacts: Array.from({ length: 30 }, (_, i) => ({
        relayId: `qr-contact-${i}`,
        name: `QR Contact ${i}`,
        publicKeyHex: 'cc'.repeat(32),
        addedAt: Date.now(),
      })),
      conversations: [],
      messages: {},
    };
    const { aliceShared, bobShared } = makeSharedSecretPair();
    const encrypted = await encryptSyncPayload(payload, aliceShared);

    const frames = buildSyncQRFrames(encrypted, QR_SYNC_CHUNK_SIZE);
    expect(frames.length).toBeGreaterThan(0);
    // Every frame must be small enough to be a realistically scannable QR.
    for (const frame of frames) {
      expect(frame.length).toBeLessThan(2000);
    }

    // Parse frames out of order to simulate camera scanning arbitrary frames.
    const shuffled = [...frames].reverse();
    const collected = new Map<number, Uint8Array>();
    let total = 0;
    for (const raw of shuffled) {
      const parsed = parseSyncQRFrame(raw);
      expect(parsed).not.toBeNull();
      collected.set(parsed!.chunkIndex, parsed!.data);
      total = parsed!.totalChunks;
    }
    expect(collected.size).toBe(total);

    const reassembled = reassembleChunks(collected, total);
    const decrypted = await decryptSyncPayload(reassembled, bobShared);
    expect(decrypted).toEqual(payload);
  });

  it('parseSyncQRFrame returns null for unrelated QR content (e.g. the identity QR2 frame)', () => {
    const identityFrame = JSON.stringify({ v: 'rs1r', spk: 'aa', enc: 'bb' });
    expect(parseSyncQRFrame(identityFrame)).toBeNull();
    expect(parseSyncQRFrame('not json')).toBeNull();
  });

  it('importSyncPayload writes contacts, conversations, and messages via the store', async () => {
    const payload: SyncPayload = {
      version: 1,
      timestamp: Date.now(),
      privateKeyHex: '11'.repeat(32),
      contacts: [{ relayId: 'c1', name: 'C1', publicKeyHex: 'dd'.repeat(32), addedAt: 1 }],
      conversations: [{ id: 'conv-x', name: 'C1', members: ['c1', 'me'], createdAt: 1, lastMessageAt: 1, isGroup: false }],
      messages: {
        'conv-x': [{ id: 'mx', conversationId: 'conv-x', senderId: 'c1', text: 'hey', timestamp: 1, status: 'delivered' }],
      },
    };

    await importSyncPayload(payload);

    expect(relayStore.addContact).toHaveBeenCalledWith(payload.contacts[0]);
    expect(relayStore.addConversation).toHaveBeenCalledWith(payload.conversations[0]);
    expect(relayStore.addMessage).toHaveBeenCalledWith(payload.messages['conv-x'][0]);
  });

  it('imports a contact that does not exist locally', async () => {
    const payload: SyncPayload = {
      version: 1, timestamp: Date.now(), privateKeyHex: 'aa'.repeat(32),
      contacts: [{ relayId: 'relay:newcontact', name: 'New Contact', publicKeyHex: 'bb'.repeat(32), addedAt: 1 }],
      conversations: [], messages: {},
    };

    await importSyncPayload(payload);

    expect(relayStore.addContact).toHaveBeenCalledTimes(1);
    expect(relayStore.addContact).toHaveBeenCalledWith(
      expect.objectContaining({ relayId: 'relay:newcontact' })
    );
  });

  it('does NOT overwrite a contact that already exists locally with a stale synced copy', async () => {
    // Simulate: this device already has its own (possibly newer/edited) copy
    // of this contact from local use, independent of the sync snapshot.
    seed.contacts.push({ relayId: 'relay:existing', name: 'Locally Renamed', publicKeyHex: 'cc'.repeat(32), addedAt: 5 });

    const payload: SyncPayload = {
      version: 1, timestamp: Date.now(), privateKeyHex: 'aa'.repeat(32),
      contacts: [{ relayId: 'relay:existing', name: 'Stale Synced Name', publicKeyHex: 'dd'.repeat(32), addedAt: 1 }],
      conversations: [], messages: {},
    };

    await importSyncPayload(payload);

    // The stale synced copy must never be written over the local one.
    expect(relayStore.addContact).not.toHaveBeenCalled();
  });

  it('imports new contacts while skipping existing ones in the same payload', async () => {
    seed.contacts.push({ relayId: 'relay:existing', name: 'X', publicKeyHex: 'ee'.repeat(32), addedAt: 1 });

    const payload: SyncPayload = {
      version: 1, timestamp: Date.now(), privateKeyHex: 'aa'.repeat(32),
      contacts: [
        { relayId: 'relay:existing', name: 'Stale', publicKeyHex: 'ff'.repeat(32), addedAt: 1 },
        { relayId: 'relay:brandnew', name: 'Brand New', publicKeyHex: 'aa'.repeat(32), addedAt: 2 },
      ],
      conversations: [], messages: {},
    };

    await importSyncPayload(payload);

    expect(relayStore.addContact).toHaveBeenCalledTimes(1);
    expect(relayStore.addContact).toHaveBeenCalledWith(
      expect.objectContaining({ relayId: 'relay:brandnew' })
    );
  });
});
