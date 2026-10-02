/**
 * Read receipts + local message deletion — both are small, self-contained
 * WS-notify-and-mutate-local-state operations.
 */

import { useCallback } from 'react';
import type { SharedMessagingRefs, SharedMessagingState } from '@/lib/hooks/messaging-types';
import { getReadReceiptsEnabled } from '@/lib/messaging/read-receipt-setting';

interface UseReadReceiptsParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
}

export function useReadReceipts({ shared, state }: UseReadReceiptsParams) {
  const { wsRef } = shared;
  const { setMessages } = state;

  const deleteMessageLocal = useCallback(
    (contactId: string, messageId: string) => {
      setMessages((prev) => {
        const updated = new Map(prev);
        const msgs = updated.get(contactId);
        if (msgs) {
          updated.set(contactId, msgs.filter((m) => m.id !== messageId));
        }
        return updated;
      });

      // Remove from encrypted IndexedDB
      import('@/lib/db/relay-store').then(({ deleteMessage }) => {
        deleteMessage(messageId).catch(() => {});
      });

      // Notify peer so their copy is deleted too
      const ws = wsRef.current;
      if (ws?.isReady()) {
        ws.sendDeleteMessage(contactId, messageId);
      }
    },
    [setMessages, wsRef]
  );

  // In-memory-only removal, no peer notify and no IndexedDB write — for the
  // ghost-mode sweeper (lib/messaging/ghost-mode.ts), which already deletes
  // the expired message from IndexedDB itself. Each side's ghost-mode expiry
  // is local/independent: calling deleteMessageLocal here would incorrectly
  // send the peer a "delete for everyone" for a message that only expired on
  // OUR side. Without this at all, the sweeper deleted from storage but the
  // already-rendered message stayed visible in an open thread until reload.
  const removeMessageLocal = useCallback(
    (contactId: string, messageId: string) => {
      setMessages((prev) => {
        const msgs = prev.get(contactId);
        if (!msgs) return prev;
        const updated = new Map(prev);
        updated.set(contactId, msgs.filter((m) => m.id !== messageId));
        return updated;
      });
    },
    [setMessages]
  );

  // Mirrors the opt-in gate in contacts.ts's markConversationAsRead — read
  // receipts are a sender-side choice (see read-receipt-setting.ts), so this
  // must never fire when the user has disabled them, even for callers that
  // don't check the setting themselves.
  const sendReadReceiptToContact = useCallback(
    (contactRelayId: string, messageId: string) => {
      if (!getReadReceiptsEnabled()) return;
      const ws = wsRef.current;
      if (ws && ws.isReady()) {
        ws.sendReadReceipt(contactRelayId, messageId);
      }
    },
    [wsRef]
  );

  return { deleteMessageLocal, removeMessageLocal, sendReadReceiptToContact };
}
