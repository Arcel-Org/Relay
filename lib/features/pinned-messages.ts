/**
 * Feature: Pinned Messages
 *
 * Lets users mark important messages in a conversation as "pinned" so they
 * can be surfaced in a bar at the top of the thread. Pin state lives on the
 * StoredMessage record inside IndexedDB (via relay-store) and is augmented
 * onto `StoredMessage` at runtime — the store's type doesn't need to know
 * about the flag because relay-store JSON-serializes the whole object.
 */

import {
  addMessage,
  getMessage,
  getAllMessagesForConversation,
  type StoredMessage,
} from '@/lib/db/relay-store';
import { log } from '@/lib/platform/logger';

export type PinnableStoredMessage = StoredMessage & { pinned?: boolean };

async function setPinned(
  conversationId: string,
  messageId: string,
  pinned: boolean,
): Promise<void> {
  const existing = (await getMessage(messageId)) as PinnableStoredMessage | null;
  if (!existing) {
    log.warn(`[pinned-messages] Cannot pin — message ${messageId} not found`);
    return;
  }
  if (existing.conversationId !== conversationId) {
    log.warn(
      `[pinned-messages] Message ${messageId} is in ${existing.conversationId}, not ${conversationId}`,
    );
    return;
  }
  const next: PinnableStoredMessage = { ...existing, pinned };
  // addMessage upserts in relay-store — same key, encrypted replacement.
  await addMessage(next);
}

export async function pinMessage(conversationId: string, messageId: string): Promise<void> {
  await setPinned(conversationId, messageId, true);
}

export async function unpinMessage(conversationId: string, messageId: string): Promise<void> {
  await setPinned(conversationId, messageId, false);
}

/**
 * Return all pinned messages in the given conversation, oldest first.
 */
export async function getPinnedMessages(
  conversationId: string,
): Promise<PinnableStoredMessage[]> {
  const all = (await getAllMessagesForConversation(conversationId)) as PinnableStoredMessage[];
  return all.filter((m) => m.pinned === true);
}
