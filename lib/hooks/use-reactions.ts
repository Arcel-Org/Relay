/**
 * Reactions hook — handles sending, receiving, and revoking message reactions.
 */

import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { toHex } from '@/lib/crypto/hex-utils';
import { log } from '@/lib/platform/logger';
import { saveRatchetState } from '@/lib/messaging/contact-key-cache';
import type { SharedMessagingRefs, SharedMessagingState, MessageWithStatus } from './messaging-types';

interface UseReactionsParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  initiateKeyExchange: (contactRelayId: string, publicKeyHex: string) => void;
}

/** Helper: wait for a session to be established, with retries */
async function waitForSession(
  sessionsRef: SharedMessagingRefs['sessionsRef'],
  contactId: string,
  initiateKeyExchange: (id: string, key: string) => void,
  maxRetries = 6,
  delayMs = 500
) {
  initiateKeyExchange(contactId, '');
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const session = sessionsRef.current.get(contactId);
    if (session) return session;
  }
  return undefined;
}

// Bounds a message's distinct-emoji growth. Reactions have no server-side
// rate limit on this path (unlike e.g. login), so a malicious contact could
// otherwise send many distinct-emoji `reaction` envelopes in a tight loop,
// growing `message.reactions` unboundedly and forcing a full array/Map copy
// on every one — a cheap client-side DoS against the receiving peer's UI.
const MAX_DISTINCT_REACTIONS_PER_MESSAGE = 20;

/** Helper: update a reaction in a message list */
function applyReaction(
  msgs: MessageWithStatus[],
  messageId: string,
  emoji: string,
  senderId: string,
  revoke: boolean
): MessageWithStatus[] | null {
  const msgIdx = msgs.findIndex((m) => m.id === messageId);
  if (msgIdx < 0) return null;

  const newMsgs = [...msgs];
  const message = { ...newMsgs[msgIdx] };
  const reactions = message.reactions ? [...message.reactions] : [];
  const reactionIdx = reactions.findIndex((r) => r.emoji === emoji);

  if (revoke) {
    if (reactionIdx >= 0) {
      const reaction = { ...reactions[reactionIdx] };
      reaction.senders = reaction.senders.filter((s: string) => s !== senderId);
      if (reaction.senders.length === 0) {
        reactions.splice(reactionIdx, 1);
      } else {
        reactions[reactionIdx] = reaction;
      }
    }
  } else {
    if (reactionIdx >= 0) {
      const reaction = { ...reactions[reactionIdx] };
      if (!reaction.senders.includes(senderId)) {
        reaction.senders = [...reaction.senders, senderId];
        reactions[reactionIdx] = reaction;
      }
    } else if (reactions.length < MAX_DISTINCT_REACTIONS_PER_MESSAGE) {
      reactions.push({ emoji, senders: [senderId] });
    } else {
      return null;
    }
  }

  message.reactions = reactions;
  newMsgs[msgIdx] = message;
  return newMsgs;
}

export function useReactions({ shared, state, initiateKeyExchange }: UseReactionsParams) {
  const { wsRef, sessionsRef, identityRef } = shared;
  const { setMessages, setContacts } = state;

  /**
   * Apply reaction/revoke to messages state — scoped to knownContactId's own
   * conversation only. This used to fall back to searching every
   * conversation for a matching messageId when knownContactId wasn't found
   * there, which let a contact react to (or strip a reaction from) a
   * message rendered in a completely different conversation than the one
   * the reaction envelope actually arrived on, for any messageId they
   * happen to learn/guess. Every call site now always has the real
   * conversation id (the sender's relayId on receive, the recipient's on
   * optimistic local update), so there's no legitimate case left that needs
   * the cross-conversation fallback.
   */
  const applyReactionToState = useCallback(
    (messageId: string, emoji: string, senderId: string, revoke: boolean, knownContactId: string) => {
      setMessages((prev) => {
        const msgs = prev.get(knownContactId);
        if (!msgs) return prev;
        const result = applyReaction(msgs, messageId, emoji, senderId, revoke);
        if (!result) return prev;
        const updated = new Map(prev);
        updated.set(knownContactId, result);
        return updated;
      });
    },
    [setMessages]
  );

  const sendReaction = useCallback(
    async (toContactId: string, messageId: string, emoji: string) => {
      let sessionData = sessionsRef.current.get(toContactId);

      if (!sessionData) {
        sessionData = await waitForSession(sessionsRef, toContactId, initiateKeyExchange);
        if (!sessionData) {
          log.error(`Session never established for ${toContactId}, dropping reaction`);
          return;
        }
      }

      if (!identityRef.current) return;

      try {
        const { session } = sessionData;
        const plaintext = new TextEncoder().encode(JSON.stringify({
          type: 'reaction',
          messageId,
          emoji,
        }));
        const encrypted = await session.encryptAsync(plaintext);
        saveRatchetState(toContactId, session.serialize());
        const blob = toHex(encrypted);

        const ws = wsRef.current;
        if (ws) {
          ws.sendMessage(toContactId, blob, uuidv4());
        }

        // Optimistic local update
        const myId = identityRef.current.relayId;
        applyReactionToState(messageId, emoji, myId, false, toContactId);

        // Also update contacts array
        setContacts((prev) => {
          for (let i = 0; i < prev.length; i++) {
            const contact = prev[i];
            if (contact.id === toContactId || contact.relayId === toContactId) {
              const result = applyReaction(contact.messages as MessageWithStatus[], messageId, emoji, myId, false);
              if (result) {
                const updated = [...prev];
                updated[i] = { ...contact, messages: result };
                return updated;
              }
            }
          }
          return prev;
        });
      } catch (err) {
        log.error('Failed to send reaction:', err);
        throw err;
      }
    },
    [wsRef, sessionsRef, identityRef, initiateKeyExchange, applyReactionToState, setContacts]
  );

  const sendReactionRevoke = useCallback(
    async (toContactId: string, messageId: string, emoji: string) => {
      let sessionData = sessionsRef.current.get(toContactId);

      if (!sessionData) {
        sessionData = await waitForSession(sessionsRef, toContactId, initiateKeyExchange);
        if (!sessionData) {
          log.error(`Session never established for ${toContactId}, dropping reaction revoke`);
          return;
        }
      }

      if (!identityRef.current) return;

      try {
        const { session } = sessionData;
        const plaintext = new TextEncoder().encode(JSON.stringify({
          type: 'reaction_revoke',
          messageId,
          emoji,
        }));
        const encrypted = await session.encryptAsync(plaintext);
        saveRatchetState(toContactId, session.serialize());
        const blob = toHex(encrypted);

        const ws = wsRef.current;
        if (ws) {
          ws.sendMessage(toContactId, blob, uuidv4());
        }

        // Optimistic local update
        const myId = identityRef.current.relayId;
        applyReactionToState(messageId, emoji, myId, true, toContactId);

        // Also update contacts array
        setContacts((prev) => {
          for (let i = 0; i < prev.length; i++) {
            const contact = prev[i];
            if (contact.id === toContactId || contact.relayId === toContactId) {
              const result = applyReaction(contact.messages as MessageWithStatus[], messageId, emoji, myId, true);
              if (result) {
                const updated = [...prev];
                updated[i] = { ...contact, messages: result };
                return updated;
              }
            }
          }
          return prev;
        });
      } catch (err) {
        log.error('Failed to send reaction revoke:', err);
        throw err;
      }
    },
    [wsRef, sessionsRef, identityRef, initiateKeyExchange, applyReactionToState, setContacts]
  );

  return {
    sendReaction,
    sendReactionRevoke,
    applyReactionToState,
  };
}
