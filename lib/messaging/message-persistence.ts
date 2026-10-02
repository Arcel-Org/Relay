/**
 * Relay Message Persistence Layer
 * 
 * Handles saving/loading messages from IndexedDB with encryption.
 * Used by the messaging hook to persist conversations across refreshes.
 */

import { addMessage as storeMessage, getMessage, getAllMessagesForConversation, checkStorageQuota, StoredMessage } from '@/lib/db/relay-store';
import { v4 as uuidv4 } from 'uuid';
import { log } from '@/lib/platform/logger';
import { toast } from '@/components/ToastNotification';

// checkStorageQuota() previously had zero callers — nothing ever surfaced
// its result, so a user could sail past their device's IndexedDB quota with
// no warning at all: sends/receives kept looking fine (persistMessage below
// deliberately swallows write failures so the message stays visible for the
// current session) right up until the next refresh, when everything since
// quota was hit turned out to have silently never been saved. Checked at
// most once per interval — navigator.storage.estimate() is an async browser
// call, no need to run it on every single message.
const QUOTA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let lastQuotaCheckAt = 0;
let hasWarnedThisSession = false;

async function checkAndWarnStorageQuota(): Promise<void> {
  const now = Date.now();
  if (now - lastQuotaCheckAt < QUOTA_CHECK_INTERVAL_MS) return;
  lastQuotaCheckAt = now;
  if (hasWarnedThisSession) return;
  try {
    const quota = await checkStorageQuota();
    if (!quota.ok) {
      hasWarnedThisSession = true;
      toast.warning(
        'Storage almost full',
        `Local message storage is at ${quota.percentUsed}% of this device's available quota. New messages may fail to save until space is freed.`
      );
    }
  } catch {
    // Best-effort only — never let a quota check itself block a send/receive.
  }
}

/**
 * Save a received or sent message to persistent storage
 * Called immediately after decryption or before sending
 */
export async function persistMessage(params: {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  status: 'sending' | 'delivered' | 'received' | 'error';
  timestamp?: number;
  expiresAt?: number;
  ghost?: boolean;
}): Promise<void> {
  try {
    const message: StoredMessage = {
      id: params.id,
      conversationId: params.conversationId,
      senderId: params.senderId,
      text: params.text,
      timestamp: params.timestamp || Date.now(),
      status: params.status,
      expiresAt: params.expiresAt,
      ghost: params.ghost,
      // Every persistMessage call site uses 'received' exclusively for
      // incoming messages and 'sending' exclusively for the sender's own —
      // own messages need no unread tracking against yourself.
      read: params.status !== 'received',
    };

    // Store in encrypted IndexedDB only — never write plaintext messages to localStorage
    await storeMessage(message);
    void checkAndWarnStorageQuota();
  } catch (err) {
    log.error('Failed to persist message:', err);
    // Don't throw - we still want to show the message in UI even if storage fails.
    // A real, immediate data-loss event deserves its own toast regardless of
    // the periodic check's throttle/once-per-session guard above — the user
    // needs to know NOW that this specific message didn't actually save,
    // not find out on the next refresh that it's simply gone.
    toast.warning(
      'Message not saved',
      'This message may not survive a reload — local storage may be full. Free up space or check available storage.'
    );
  }
}

/**
 * Load all messages for a conversation from persistent storage
 * Called when opening a conversation to restore message history
 */
export async function loadConversationMessages(
  conversationId: string
): Promise<Array<{
  id: string;
  senderId: string;
  text: string;
  timestamp: number;
  status: 'sending' | 'delivered' | 'pending' | 'received' | 'error';
  expiresAt?: number;
  ghost?: boolean;
  read?: boolean;
}>> {
  try {
    const messages = await getAllMessagesForConversation(conversationId);
    return messages;
  } catch (err) {
    log.error('Failed to load messages:', err);
    return [];
  }
}

/**
 * Persist that a message has been viewed, so a later reload doesn't lose
 * the unread state — replaces contact-bookkeeping.ts's ContactBookkeepingService.markAsRead,
 * which wrote to a legacy localStorage schema loadConversationMessages
 * never reads back from (see contacts.ts's header comment), making it a
 * write with no effect on rehydrate.
 */
export async function markMessagePersistedRead(messageId: string): Promise<void> {
  try {
    const stored = await getMessage(messageId);
    if (stored && !stored.read) {
      await storeMessage({ ...stored, read: true });
    }
  } catch (err) {
    log.error('Failed to persist read state:', err);
  }
}

/**
 * Format a stored message for display in the UI
 */
export function formatStoredMessage(stored: StoredMessage): {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: Date;
  isOwn: boolean;
  read: boolean;
  delivered: boolean;
  status: string;
  metadata: any;
  expiresAt?: number;
} {
  return {
    id: stored.id,
    senderId: stored.senderId,
    senderName: stored.senderId.slice(0, 11),
    text: stored.text,
    timestamp: new Date(stored.timestamp),
    isOwn: false,
    read: true,
    delivered: stored.status === 'delivered' || stored.status === 'received',
    status: stored.status,
    metadata: null,
    expiresAt: stored.expiresAt,
  };
}
