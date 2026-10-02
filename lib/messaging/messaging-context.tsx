'use client';

import React, { createContext, useContext, useMemo } from 'react';
import { useRelayMessaging } from '@/lib/messaging/use-relay-messaging';
import type { Contact } from '@/lib/mock-data';
import type {
  MessageWithStatus,
  CallSignalEvent,
  GroupConversation,
} from '@/lib/hooks/messaging-types';
import type { CallHangupReason } from '@/lib/relay/relay-websocket';

// ---------------------------------------------------------------------------
// 1. MessagingDataContext — contacts, groups, messages, loading, error, sessionStats
//    (data that changes often)
// ---------------------------------------------------------------------------

interface MessagingDataContextValue {
  contacts: Contact[];
  groups: GroupConversation[];
  messages: Map<string, MessageWithStatus[]>;
  loading: boolean;
  error: string | null;
  sessionStats: Map<string, { msgCount: number; savedPercent: number }>;
}

const MessagingDataContext = createContext<MessagingDataContextValue | null>(null);

// ---------------------------------------------------------------------------
// 2. MessagingActionsContext — stable function refs (sendMessage, addContact, etc.)
// ---------------------------------------------------------------------------

interface MessagingActionsContextValue {
  // Core messaging
  loadContacts: () => void;
  loadMessages: (contactId: string) => void;
  sendMessage: (toContactId: string, text: string) => Promise<any>;
  sendFile: (toContactId: string, file: File) => Promise<any>;
  addContact: (userId: string, publicKeyOrDisplayName: Uint8Array | string, options?: { ephemeral?: boolean }) => Promise<any>;
  markAsRead: (messageId: string) => Promise<void>;
  markConversationAsRead: (contactId: string) => void;
  cleanupExpired: () => Promise<void>;
  deleteMessage: (contactId: string, messageId: string) => void;
  removeMessageLocal: (contactId: string, messageId: string) => void;
  sendReadReceipt: (contactRelayId: string, messageId: string) => void;
  burnConversation: (contactId: string) => void;

  // Typing
  sendTypingIndicator: (contactId: string) => void;

  // Reactions
  sendReaction: (toContactId: string, messageId: string, emoji: string) => Promise<void>;
  sendReactionRevoke: (toContactId: string, messageId: string, emoji: string) => Promise<void>;

  // Message editing
  sendMessageEdit: (toContactId: string, messageId: string, newText: string) => Promise<void>;

  // Call signaling
  sendCallOffer: (toContactId: string, offer: RTCSessionDescriptionInit, callId: string) => void;
  sendCallAnswer: (toContactId: string, answer: RTCSessionDescriptionInit, callId: string) => void;
  sendCallIce: (toContactId: string, candidate: RTCIceCandidateInit, callId: string) => void;
  sendCallRing: (toContactId: string, callId: string) => void;
  sendCallHangup: (toContactId: string, callId: string, reason?: CallHangupReason) => void;
  sendCallPeers: (toContactId: string, callId: string, peerIds: string[]) => void;

  // Group messaging
  createGroup: (name: string, memberIds: string[], options?: { avatarEmoji?: string; avatarColor?: string; description?: string }) => GroupConversation;
  sendGroupMessage: (groupId: string, text: string) => Promise<void>;
  sendGroupFile: (groupId: string, file: File) => Promise<void>;
  renameGroup: (groupId: string, name: string) => Promise<void>;
  setGroupDisappearing: (groupId: string, seconds: number) => Promise<void>;
  addGroupMembers: (groupId: string, memberIds: string[]) => Promise<void>;
  removeGroupMember: (groupId: string, memberId: string) => Promise<void>;
  setGroupAdmin: (groupId: string, memberId: string, isAdmin: boolean) => Promise<void>;
  transferGroupOwnership: (groupId: string, newOwnerId: string) => Promise<void>;
  leaveGroup: (groupId: string) => Promise<void>;
}

const MessagingActionsContext = createContext<MessagingActionsContextValue | null>(null);

// ---------------------------------------------------------------------------
// 3. MessagingConnectionContext — connectionStatus, callSignals, consumeCallSignals
// ---------------------------------------------------------------------------

interface MessagingConnectionContextValue {
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  reconnect: () => void;
  callSignals: CallSignalEvent[];
  consumeCallSignals: (count: number) => void;
}

const MessagingConnectionContext = createContext<MessagingConnectionContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function MessagingProvider({ children }: { children: React.ReactNode }) {
  const messaging = useRelayMessaging();

  const dataValue = useMemo<MessagingDataContextValue>(
    () => ({
      contacts: messaging.contacts,
      groups: messaging.groups,
      messages: messaging.messages,
      loading: messaging.loading,
      error: messaging.error,
      sessionStats: messaging.sessionStats,
    }),
    [
      messaging.contacts,
      messaging.groups,
      messaging.messages,
      messaging.loading,
      messaging.error,
      messaging.sessionStats,
    ],
  );

  const actionsValue = useMemo<MessagingActionsContextValue>(
    () => ({
      loadContacts: messaging.loadContacts,
      loadMessages: messaging.loadMessages,
      sendMessage: messaging.sendMessage,
      sendFile: messaging.sendFile,
      addContact: messaging.addContact,
      markAsRead: messaging.markAsRead,
      markConversationAsRead: messaging.markConversationAsRead,
      cleanupExpired: messaging.cleanupExpired,
      deleteMessage: messaging.deleteMessage,
      removeMessageLocal: messaging.removeMessageLocal,
      sendReadReceipt: messaging.sendReadReceipt,
      burnConversation: messaging.burnConversation,
      sendTypingIndicator: messaging.sendTypingIndicator,
      sendReaction: messaging.sendReaction,
      sendReactionRevoke: messaging.sendReactionRevoke,
      sendMessageEdit: messaging.sendMessageEdit,
      sendCallOffer: messaging.sendCallOffer,
      sendCallAnswer: messaging.sendCallAnswer,
      sendCallIce: messaging.sendCallIce,
      sendCallRing: messaging.sendCallRing,
      sendCallHangup: messaging.sendCallHangup,
      sendCallPeers: messaging.sendCallPeers,
      createGroup: messaging.createGroup,
      sendGroupMessage: messaging.sendGroupMessage,
      sendGroupFile: messaging.sendGroupFile,
      renameGroup: messaging.renameGroup,
      setGroupDisappearing: messaging.setGroupDisappearing,
      addGroupMembers: messaging.addGroupMembers,
      removeGroupMember: messaging.removeGroupMember,
      setGroupAdmin: messaging.setGroupAdmin,
      transferGroupOwnership: messaging.transferGroupOwnership,
      leaveGroup: messaging.leaveGroup,
    }),
    [
      messaging.loadContacts,
      messaging.loadMessages,
      messaging.sendMessage,
      messaging.sendFile,
      messaging.addContact,
      messaging.markAsRead,
      messaging.markConversationAsRead,
      messaging.cleanupExpired,
      messaging.deleteMessage,
      messaging.removeMessageLocal,
      messaging.sendReadReceipt,
      messaging.burnConversation,
      messaging.sendTypingIndicator,
      messaging.sendReaction,
      messaging.sendReactionRevoke,
      messaging.sendMessageEdit,
      messaging.sendCallOffer,
      messaging.sendCallAnswer,
      messaging.sendCallIce,
      messaging.sendCallRing,
      messaging.sendCallHangup,
      messaging.sendCallPeers,
      messaging.createGroup,
      messaging.sendGroupMessage,
      messaging.sendGroupFile,
      messaging.renameGroup,
      messaging.setGroupDisappearing,
      messaging.addGroupMembers,
      messaging.removeGroupMember,
      messaging.setGroupAdmin,
      messaging.transferGroupOwnership,
      messaging.leaveGroup,
    ],
  );

  const connectionValue = useMemo<MessagingConnectionContextValue>(
    () => ({
      connectionStatus: messaging.connectionStatus,
      reconnect: messaging.reconnect,
      callSignals: messaging.callSignals,
      consumeCallSignals: messaging.consumeCallSignals,
    }),
    [messaging.connectionStatus, messaging.reconnect, messaging.callSignals, messaging.consumeCallSignals],
  );

  return (
    <MessagingConnectionContext.Provider value={connectionValue}>
      <MessagingActionsContext.Provider value={actionsValue}>
        <MessagingDataContext.Provider value={dataValue}>
          {children}
        </MessagingDataContext.Provider>
      </MessagingActionsContext.Provider>
    </MessagingConnectionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer hooks
// ---------------------------------------------------------------------------

export function useMessagingData(): MessagingDataContextValue {
  const ctx = useContext(MessagingDataContext);
  if (!ctx) throw new Error('useMessagingData must be used within <MessagingProvider>');
  return ctx;
}

export function useMessagingActions(): MessagingActionsContextValue {
  const ctx = useContext(MessagingActionsContext);
  if (!ctx) throw new Error('useMessagingActions must be used within <MessagingProvider>');
  return ctx;
}

export function useMessagingConnection(): MessagingConnectionContextValue {
  const ctx = useContext(MessagingConnectionContext);
  if (!ctx) throw new Error('useMessagingConnection must be used within <MessagingProvider>');
  return ctx;
}

/**
 * Convenience hook that returns all three context values merged.
 * Prefer the individual hooks (useMessagingData, useMessagingActions, useMessagingConnection)
 * in components that only need a subset, to avoid unnecessary re-renders.
 */
export function useMessagingContext() {
  return {
    ...useMessagingData(),
    ...useMessagingActions(),
    ...useMessagingConnection(),
  };
}
