/**
 * Coverage for lib/features/block.ts and archive.ts — both had zero test
 * coverage. block.ts in particular governs a real access-control decision
 * (receive.ts, key-exchange.ts, connection.ts, burn.ts, etc. all gate
 * incoming traffic on isBlockedContact/the `blocked` flag), so a bug in the
 * flag being set/read/merged incorrectly would silently let a blocked
 * contact's traffic back through.
 *
 * relay-store.ts is mocked (in-memory Map) rather than exercised for real —
 * IndexedDB isn't available in this project's jsdom test environment (see
 * relay-vault.test.ts for the same mocking pattern), and these two modules'
 * own logic (the merge-preserving upsert, not-found handling, boolean
 * flip/read) is what's under test here, not relay-store's storage layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/relay-store', () => {
  const contacts = new Map<string, any>();
  return {
    getContact: vi.fn(async (relayId: string) => contacts.get(relayId) ?? null),
    upsertContact: vi.fn(async (relayId: string, updates: any) => {
      const existing = contacts.get(relayId) ?? { relayId };
      const merged = { ...existing, ...updates };
      contacts.set(relayId, merged);
      return merged;
    }),
    __contacts: contacts,
  };
});

import * as relayStore from '../db/relay-store';
import { blockContact, unblockContact, isBlockedContact } from '../features/block';
import { archiveContact, unarchiveContact, autoUnarchive } from '../features/archive';

const contacts: Map<string, any> = (relayStore as any).__contacts;

beforeEach(() => {
  contacts.clear();
  vi.clearAllMocks();
});

describe('block.ts', () => {
  it('blockContact sets blocked=true, preserving other contact fields', async () => {
    contacts.set('relay:alice', { relayId: 'relay:alice', name: 'Alice', publicKeyHex: 'aa' });
    await blockContact('relay:alice');
    expect(contacts.get('relay:alice')).toMatchObject({ name: 'Alice', publicKeyHex: 'aa', blocked: true });
  });

  it('isBlockedContact reflects the current flag', async () => {
    contacts.set('relay:alice', { relayId: 'relay:alice' });
    expect(await isBlockedContact('relay:alice')).toBe(false);
    await blockContact('relay:alice');
    expect(await isBlockedContact('relay:alice')).toBe(true);
    await unblockContact('relay:alice');
    expect(await isBlockedContact('relay:alice')).toBe(false);
  });

  it('isBlockedContact returns false (not a throw) for an unknown contact', async () => {
    await expect(isBlockedContact('relay:nobody')).resolves.toBe(false);
  });

  it('blockContact on an unknown contact is a safe no-op — does not fabricate a new contact record', async () => {
    await blockContact('relay:ghost');
    expect(contacts.has('relay:ghost')).toBe(false);
  });

  it('blocking one contact does not affect another', async () => {
    contacts.set('relay:alice', { relayId: 'relay:alice' });
    contacts.set('relay:bob', { relayId: 'relay:bob' });
    await blockContact('relay:alice');
    expect(await isBlockedContact('relay:alice')).toBe(true);
    expect(await isBlockedContact('relay:bob')).toBe(false);
  });
});

describe('archive.ts', () => {
  it('archiveContact sets archived=true, preserving other contact fields', async () => {
    contacts.set('relay:alice', { relayId: 'relay:alice', name: 'Alice', publicKeyHex: 'aa' });
    await archiveContact('relay:alice');
    expect(contacts.get('relay:alice')).toMatchObject({ name: 'Alice', publicKeyHex: 'aa', archived: true });
  });

  it('unarchiveContact clears the flag', async () => {
    contacts.set('relay:alice', { relayId: 'relay:alice', archived: true });
    await unarchiveContact('relay:alice');
    expect(contacts.get('relay:alice').archived).toBe(false);
  });

  it('autoUnarchive clears the flag when a contact is archived', async () => {
    contacts.set('relay:alice', { relayId: 'relay:alice', archived: true });
    await autoUnarchive('relay:alice');
    expect(contacts.get('relay:alice').archived).toBe(false);
  });

  it('autoUnarchive is a no-op when the contact is not archived', async () => {
    contacts.set('relay:alice', { relayId: 'relay:alice', archived: false });
    await autoUnarchive('relay:alice');
    expect((relayStore.upsertContact as any)).not.toHaveBeenCalled();
  });

  it('autoUnarchive never throws for an unknown contact', async () => {
    await expect(autoUnarchive('relay:nobody')).resolves.toBeUndefined();
  });

  it('archived and blocked flags are independent — archiving does not block, blocking does not archive', async () => {
    contacts.set('relay:alice', { relayId: 'relay:alice' });
    await archiveContact('relay:alice');
    expect(await isBlockedContact('relay:alice')).toBe(false);

    contacts.set('relay:bob', { relayId: 'relay:bob' });
    await blockContact('relay:bob');
    expect(contacts.get('relay:bob').archived).toBeUndefined();
  });
});
