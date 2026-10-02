/**
 * Regression coverage for persistMessage's `read` field. IndexedDB-stored
 * messages previously had no `read` field at all — contacts.ts's rehydrate
 * path hardcoded `read: true` for every restored message regardless of
 * whether the user had actually viewed it, so any unread messages received
 * shortly before a reload/refresh silently lost their unread badge
 * (ContactSidebar.tsx's unread counts are `!m.isOwn && !m.read`) and, for a
 * sent message, could show an incorrect "seen" checkmark (MessageBubble.tsx)
 * before the recipient ever read it.
 *
 * Fix: persistMessage derives `read` from `status` (every call site uses
 * 'received' exclusively for incoming messages and something else
 * exclusively for the sender's own), and a new markMessagePersistedRead
 * actually flips it in the same IndexedDB store loadConversationMessages
 * reads from — replacing contact-bookkeeping.ts's markAsRead, which wrote
 * to an entirely different (and never-read-back) legacy localStorage
 * schema.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, any>();
const storeMessage = vi.fn(async (msg: any) => { store.set(msg.id, msg); });
const getMessageMock = vi.fn(async (id: string) => store.get(id) ?? null);
const checkStorageQuota = vi.fn(async () => ({ ok: true, usedMB: 1, totalMB: 100, percentUsed: 1 }));
vi.mock('@/lib/db/relay-store', () => ({
  addMessage: (msg: unknown) => storeMessage(msg),
  getMessage: (id: string) => getMessageMock(id),
  checkStorageQuota: () => checkStorageQuota(),
}));

vi.mock('@/components/ToastNotification', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import { persistMessage, markMessagePersistedRead } from '../messaging/message-persistence';

beforeEach(() => {
  store.clear();
  storeMessage.mockClear();
  getMessageMock.mockClear();
});

describe('persistMessage — read field derived from status', () => {
  it("THE REGRESSION: an incoming ('received') message persists as unread", async () => {
    await persistMessage({
      id: 'incoming-1',
      conversationId: 'contact-1',
      senderId: 'contact-1',
      text: 'hi',
      status: 'received',
    });
    expect(store.get('incoming-1').read).toBe(false);
  });

  it("an outgoing ('sending') message persists as already-read", async () => {
    await persistMessage({
      id: 'outgoing-1',
      conversationId: 'contact-1',
      senderId: 'relay:me',
      text: 'hey',
      status: 'sending',
    });
    expect(store.get('outgoing-1').read).toBe(true);
  });
});

describe('markMessagePersistedRead — actually flips the stored flag', () => {
  it('flips a previously-unread stored message to read', async () => {
    await persistMessage({
      id: 'incoming-2',
      conversationId: 'contact-1',
      senderId: 'contact-1',
      text: 'hi again',
      status: 'received',
    });
    expect(store.get('incoming-2').read).toBe(false);

    await markMessagePersistedRead('incoming-2');

    expect(store.get('incoming-2').read).toBe(true);
    // Re-persisted via the same addMessage upsert used by persistMessage —
    // the whole point is that THIS is what loadConversationMessages/
    // getAllMessagesForConversation reads back from, unlike the old
    // contact-bookkeeping.ts localStorage write.
    expect(storeMessage).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for a message that does not exist in storage', async () => {
    await markMessagePersistedRead('never-persisted');
    expect(storeMessage).not.toHaveBeenCalled();
  });
});
