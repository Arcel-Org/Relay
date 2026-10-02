/**
 * Mutual burn — clears a conversation on both sides. The confirm carries an
 * optional AEAD-encrypted receipt (using the existing session, if any) so
 * the initiator gets cryptographic proof the confirm really came from the
 * conversation's peer, not just the relay's say-so.
 */

import { useCallback } from 'react';
import { toast } from '@/components/ToastNotification';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { log } from '@/lib/platform/logger';
import type { SharedMessagingRefs, SharedMessagingState } from '@/lib/hooks/messaging-types';

interface UseBurnRequestsParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
}

export function useBurnRequests({ shared, state }: UseBurnRequestsParams) {
  const { wsRef, identityRef, sessionsRef, contactsRef } = shared;
  const { setMessages } = state;

  const initiateBurnRequest = useCallback(
    (contactId: string) => {
      const ws = wsRef.current;
      if (!ws || !identityRef.current) return;

      const burnMessage = {
        type: 'burn_request',
        to: contactId,
        conversationId: contactId,
        fromId: identityRef.current.relayId,
      };

      ws.sendRaw(burnMessage);
    },
    [wsRef, identityRef]
  );

  const confirmBurn = useCallback(
    (contactId: string) => {
      const ws = wsRef.current;
      if (!ws || !identityRef.current) return;

      const burnMessage = {
        type: 'burn_confirm',
        to: contactId,
        conversationId: contactId,
        fromId: identityRef.current.relayId,
      };

      ws.sendRaw(burnMessage);

      // Clear local messages
      setMessages((prev) => {
        const updated = new Map(prev);
        updated.set(contactId, []);
        return updated;
      });

      // Persist the clear to IndexedDB — without this the in-memory clear
      // is cosmetic only and the full message history reappears on reload.
      import('@/lib/db/relay-store').then(({ deleteConversation }) => {
        deleteConversation(contactId).catch(() => {});
      });
    },
    [wsRef, identityRef, setMessages]
  );

  const handleBurnRequest = useCallback((msg: any) => {
    const senderId = msg.fromRelayId || msg.from || msg.fromId;
    if (!senderId) return;

    // Only honor a burn from someone who's actually a contact. The relay
    // forwards burn_request to any connected relayId with no relationship
    // check, and relayIds are discoverable via profile search — without this
    // gate, any registered (non-contact) user could force-wipe a victim's
    // local conversation entry keyed to the attacker's own identity, with no
    // confirmation UI. Silently ignore (no wipe, no confirm) rather than
    // erroring, so a stranger probing this can't distinguish "not a contact"
    // from "wiped but conversation was already empty."
    const senderContact = contactsRef.current.find((c) => c.relayId === senderId);
    if (!senderContact || senderContact.blocked) {
      log.warn('Ignored burn_request from non-contact or blocked contact:', senderId);
      return;
    }

    // Clear local conversation
    setMessages((prev) => {
      const updated = new Map(prev);
      updated.set(senderId, []);
      return updated;
    });

    // Persist cleared conversation to IndexedDB
    import('@/lib/db/relay-store').then(({ deleteConversation }) => {
      deleteConversation(senderId).catch(() => {});
    });

    toast.warning('Conversation cleared', 'Your contact cleared this conversation');

    // Send burn_confirm back so the sender's UI also clears. When we still
    // have an established session with them, attach a receipt — an AEAD
    // ciphertext only the true holder of the shared session secret could
    // produce — so the sender gets cryptographic proof (not just "the relay
    // says so") that the confirm really came from this conversation's peer.
    const ws = wsRef.current;
    if (ws?.isReady()) {
      let receipt: string | undefined;
      const sessionData = sessionsRef.current.get(senderId);
      if (sessionData) {
        try {
          const payload = new TextEncoder().encode(`burn-receipt:${senderId}:${Date.now()}`);
          receipt = toHex(sessionData.session.encrypt(payload));
        } catch (err) {
          log.warn('Failed to produce burn receipt:', err);
        }
      }
      ws.sendBurnConfirm(senderId, receipt);
    }
  }, [setMessages, wsRef, sessionsRef]);

  const handleBurnConfirm = useCallback((msg: any) => {
    const from = msg.fromRelayId || msg.from;
    if (!from) return;

    // Same gate as handleBurnRequest, and for the same reason: this message
    // is unsolicited from the relay's point of view (nothing here confirms a
    // burn_request was ever sent), so a non-contact could otherwise force
    // this same local wipe. `.find(...)?.blocked` alone doesn't cover it —
    // find() returns undefined for a non-contact, and undefined?.blocked is
    // falsy, so the wipe proceeded anyway.
    const senderContact = contactsRef.current.find((c) => c.relayId === from);
    if (!senderContact || senderContact.blocked) {
      log.warn('Ignored burn_confirm from non-contact or blocked contact:', from);
      return;
    }

    // Clear local messages
    setMessages((prev) => {
      const updated = new Map(prev);
      updated.set(from, []);
      return updated;
    });

    // Persist the clear to IndexedDB — same reasoning as confirmBurn: an
    // in-memory-only clear reappears on reload.
    import('@/lib/db/relay-store').then(({ deleteConversation }) => {
      deleteConversation(from).catch(() => {});
    });

    // Verify the receipt if one was attached — proves the confirm came from
    // whoever holds this conversation's shared secret, independent of
    // trusting the relay server's identity claim.
    if (msg.receipt) {
      const sessionData = sessionsRef.current.get(from);
      let verified = false;
      if (sessionData) {
        try {
          sessionData.session.decrypt(fromHex(msg.receipt), false);
          verified = true;
        } catch {
          verified = false;
        }
      }
      if (verified) {
        toast.success('Burn verified', 'Cryptographically confirmed — your contact\'s copy is gone');
      } else {
        toast.warning('Burn confirmed', 'Cleared, but the receipt could not be verified');
      }
    }
  }, [setMessages, sessionsRef]);

  return { initiateBurnRequest, confirmBurn, handleBurnRequest, handleBurnConfirm };
}
