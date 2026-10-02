/**
 * Tests for lib/relay-device-sync.ts — prepareSyncPayload().
 *
 * This codebase has no separate "ghost contacts" module — the closest
 * analogous ephemeral-data concept is ghost-mode *messages*
 * (StoredMessage.ghost / StoredMessage.expiresAt, see lib/relay-store.ts
 * and lib/ghost-mode.ts). Device sync exists to carry durable history to a
 * newly paired device; it must not become a side channel that resurrects
 * self-destructing messages on hardware the user never had them on, nor
 * leak messages that already expired locally but hadn't been swept yet.
 *
 * `getAllContacts`/`getAllConversations`/`getAllMessagesForConversation`
 * are mocked so this test exercises prepareSyncPayload's own filtering
 * logic in isolation, independent of IndexedDB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockContacts: any[] = [];
const mockConversations: any[] = [{ id: 'conv-1', name: 'Conv', members: [], createdAt: 0, lastMessageAt: 0, isGroup: false }];
let mockMessages: any[] = [];

vi.mock('@/lib/db/relay-store', () => ({
  getAllContacts: vi.fn(async () => mockContacts),
  getAllConversations: vi.fn(async () => mockConversations),
  getAllMessagesForConversation: vi.fn(async (conversationId: string) =>
    mockMessages.filter((m) => m.conversationId === conversationId)
  ),
  addContact: vi.fn(async () => {}),
  addConversation: vi.fn(async () => {}),
  addMessage: vi.fn(async () => {}),
}));

describe('prepareSyncPayload — ghost/expired message exclusion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    mockMessages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('excludes messages marked ghost: true from the sync payload', async () => {
    const { prepareSyncPayload } = await import('../vault/relay-device-sync');
    mockMessages = [
      { id: 'm1', conversationId: 'conv-1', senderId: 'a', text: 'normal', timestamp: 1, status: 'delivered' },
      { id: 'm2', conversationId: 'conv-1', senderId: 'a', text: 'secret', timestamp: 2, status: 'delivered', ghost: true },
    ];

    const payload = await prepareSyncPayload('deadbeef');
    const ids = payload.messages['conv-1'].map((m: any) => m.id);
    expect(ids).toContain('m1');
    expect(ids).not.toContain('m2');
  });

  it('excludes messages whose expiresAt has already passed', async () => {
    const { prepareSyncPayload } = await import('../vault/relay-device-sync');
    const now = Date.now();
    mockMessages = [
      { id: 'm1', conversationId: 'conv-1', senderId: 'a', text: 'still-alive', timestamp: 1, status: 'delivered', expiresAt: now + 60_000 },
      { id: 'm2', conversationId: 'conv-1', senderId: 'a', text: 'already-expired', timestamp: 2, status: 'delivered', expiresAt: now - 1 },
    ];

    const payload = await prepareSyncPayload('deadbeef');
    const ids = payload.messages['conv-1'].map((m: any) => m.id);
    expect(ids).toContain('m1');
    expect(ids).not.toContain('m2');
  });

  it('includes ordinary messages with no ghost/expiresAt fields at all', async () => {
    const { prepareSyncPayload } = await import('../vault/relay-device-sync');
    mockMessages = [
      { id: 'm1', conversationId: 'conv-1', senderId: 'a', text: 'hi', timestamp: 1, status: 'delivered' },
    ];

    const payload = await prepareSyncPayload('deadbeef');
    expect(payload.messages['conv-1'].map((m: any) => m.id)).toEqual(['m1']);
  });

  it('still caps at the last 200 durable messages per conversation', async () => {
    const { prepareSyncPayload } = await import('../vault/relay-device-sync');
    mockMessages = Array.from({ length: 250 }, (_, i) => ({
      id: `m${i}`,
      conversationId: 'conv-1',
      senderId: 'a',
      text: `msg ${i}`,
      timestamp: i,
      status: 'delivered',
    }));

    const payload = await prepareSyncPayload('deadbeef');
    expect(payload.messages['conv-1'].length).toBe(200);
    // Keeps the most recent 200 (by array position), i.e. m50..m249.
    expect(payload.messages['conv-1'][0].id).toBe('m50');
    expect(payload.messages['conv-1'][199].id).toBe('m249');
  });
});
