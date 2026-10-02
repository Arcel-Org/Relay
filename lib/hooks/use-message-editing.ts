/**
 * Message editing hook — handles sending edit operations to contacts.
 */

import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { toHex } from '@/lib/crypto/hex-utils';
import { log } from '@/lib/platform/logger';
import { saveRatchetState } from '@/lib/messaging/contact-key-cache';
import type { SharedMessagingRefs, SharedMessagingState } from './messaging-types';

interface UseMessageEditingParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  initiateKeyExchange: (contactRelayId: string, publicKeyHex: string) => void;
}

// Enforces the edit window client-side before ever transmitting. Without
// this, sendMessageEdit could fire for ANY messageId/text with no check that
// it's even the local user's own message or within any time window — the
// receive side enforces ownership (see receive.ts's message_edit handler),
// but the send side should refuse before ever transmitting, not rely solely
// on the peer to reject it.
const EDIT_WINDOW_MS = 15 * 60 * 1000;

export function useMessageEditing({ shared, state, initiateKeyExchange }: UseMessageEditingParams) {
  const { wsRef, sessionsRef, identityRef } = shared;
  const { setMessages } = state;

  const sendMessageEdit = useCallback(
    async (toContactId: string, messageId: string, newText: string) => {
      const ownId = identityRef.current?.relayId;
      const existingMsgs = state.messages.get(toContactId);
      const target = existingMsgs?.find((m) => m.id === messageId);
      if (!target || target.senderId !== ownId || Date.now() - target.timestamp.getTime() > EDIT_WINDOW_MS) {
        log.warn(`Refusing to edit ${messageId}: not the sender or outside the edit window`);
        return;
      }

      let sessionData = sessionsRef.current.get(toContactId);

      if (!sessionData) {
        log.warn(`No session for ${toContactId} during edit, initiating key exchange`);
        initiateKeyExchange(toContactId, '');
        for (let i = 0; i < 6; i++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          sessionData = sessionsRef.current.get(toContactId);
          if (sessionData) break;
        }
        if (!sessionData) {
          log.error(`Session never established for ${toContactId}`);
          return;
        }
      }

      if (!identityRef.current) return;

      try {
        const { session } = sessionData;
        const editPayload = {
          type: 'message_edit',
          messageId,
          text: newText,
          timestamp: new Date().toISOString(),
        };

        const plaintext = new TextEncoder().encode(JSON.stringify(editPayload));
        const encrypted = await session.encryptAsync(plaintext);
        saveRatchetState(toContactId, session.serialize());
        const blob = toHex(encrypted);

        const ws = wsRef.current;
        if (ws) {
          ws.sendMessage(toContactId, blob, uuidv4());
        }

        // Optimistic local state update — scoped to toContactId's own
        // conversation, matching the ownership check already done above.
        setMessages((prev) => {
          const msgs = prev.get(toContactId);
          const msgIdx = msgs?.findIndex((m) => m.id === messageId) ?? -1;
          if (!msgs || msgIdx < 0) return prev;

          const updated = new Map(prev);
          const newMsgs = [...msgs];
          const message = { ...newMsgs[msgIdx] };
          message.text = newText;
          message.isEdited = true;
          message.editedAt = new Date();
          message.editCount = (message.editCount || 0) + 1;
          newMsgs[msgIdx] = message;
          updated.set(toContactId, newMsgs);
          return updated;
        });
      } catch (err) {
        log.error('Failed to send message edit:', err);
        throw err;
      }
    },
    [wsRef, sessionsRef, identityRef, initiateKeyExchange, setMessages, state.messages]
  );

  return {
    sendMessageEdit,
  };
}
