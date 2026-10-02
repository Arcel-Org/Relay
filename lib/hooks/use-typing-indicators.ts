/**
 * Typing indicator hook — handles sending and receiving typing events.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { SharedMessagingRefs } from './messaging-types';
import { getBoolSetting } from '@/lib/settings/relay-settings';

export function useTypingIndicators(shared: SharedMessagingRefs) {
  const { wsRef, identityRef, contactsRef } = shared;

  const typingTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const lastTypingSentRef = useRef<Map<string, number>>(new Map());

  // This hook currently only lives for the app's whole lifetime (mounted
  // once from useRelayMessaging), so this has no observable effect today —
  // but it's the one hook in lib/hooks/ with no teardown path at all, and
  // that stops being harmless the moment this is ever reused somewhere that
  // can unmount mid-conversation (a per-thread panel, for instance).
  useEffect(() => {
    const timeouts = typingTimeoutsRef.current;
    return () => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
      timeouts.clear();
    };
  }, []);

  const sendTypingIndicator = useCallback(
    (toContactId: string) => {
      if (!getBoolSetting('typing-indicators', true)) return;
      const ws = wsRef.current;
      if (!ws || !identityRef.current) return;

      const now = Date.now();
      const lastSent = lastTypingSentRef.current.get(toContactId) || 0;

      // Throttle: only send every 2 seconds
      if (now - lastSent < 2000) return;

      const typingMsg = {
        type: 'typing',
        to: toContactId,
        fromId: identityRef.current.relayId,
      };

      ws.sendRaw(typingMsg);
      lastTypingSentRef.current.set(toContactId, now);
    },
    [wsRef, identityRef]
  );

  const handleTypingIndicator = useCallback(
    (msg: { from: string }) => {
      if (!getBoolSetting('typing-indicators', true)) return;
      const { from } = msg;
      // The relay forwards 'typing' to any recipient with no contact/
      // relationship check (identity can't be spoofed, but there's no
      // requirement the sender be someone the recipient actually added) —
      // without this, any registered user could make "X is typing" appear
      // for a user who never added them as a contact.
      const fromContact = contactsRef.current.find((c) => c.relayId === from);
      if (!fromContact || fromContact.blocked) return;
      const { setTypingIndicator } = require('@/lib/app-store').useAppStore.getState();

      // Show typing indicator for 3 seconds
      const showUntil = Date.now() + 3000;
      setTypingIndicator(from, showUntil);

      // Clear existing timeout
      if (typingTimeoutsRef.current.has(from)) {
        clearTimeout(typingTimeoutsRef.current.get(from)!);
      }

      // Set new timeout
      const timeout = setTimeout(() => {
        const { clearTypingIndicator } = require('@/lib/app-store').useAppStore.getState();
        clearTypingIndicator(from);
        typingTimeoutsRef.current.delete(from);
      }, 3000);

      typingTimeoutsRef.current.set(from, timeout);
    },
    []
  );

  const stopTypingIndicator = useCallback((toContactId: string) => {
    lastTypingSentRef.current.delete(toContactId);
  }, []);

  return {
    sendTypingIndicator,
    handleTypingIndicator,
    stopTypingIndicator,
  };
}
