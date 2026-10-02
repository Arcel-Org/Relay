/**
 * Custom hook for Relay Messaging
 * 
 * Handles:
 * - WebSocket connection to relay server
 * - Identity loading from sessionStorage
 * - Encryption/decryption with Session
 * - Message state management
 * - Key exchange protocol
 * - Message persistence to IndexedDB
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getMessagingService } from '@/lib/messaging/contact-bookkeeping';
import { RelayWebSocketClient } from '@/lib/relay/relay-websocket';
import { Session, buildDictionary, computeSharedSecret, computeHybridSharedSecret, performPqEncapsulation, deriveHybridSecret, deriveSessionRole } from '@/lib/crypto/relay-crypto';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { isSafeDataUrl } from '@/lib/security/sanitize';
import { normalizeUserId, lookupUserProfile } from '@/lib/messaging/username-lookup';
import { resolveDisplayName } from '@/lib/messaging/relay-display';
import { loadCachedDictionary, cacheDictionary } from '@/lib/messaging/compression-cache';
import type { Contact, Message, CompressionMetadata } from '@/lib/mock-data';
import { v4 as uuidv4 } from 'uuid';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { initStorage, getStorageReady, upsertContact } from '@/lib/db/relay-store';
import { markEphemeralContact, isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';
import { bytesToHex } from '@noble/hashes/utils.js';
import { persistMessage, loadConversationMessages } from '@/lib/messaging/message-persistence';
import { computeExpiresAt } from '@/lib/messaging/ghost-mode';
import { toast } from '@/components/ToastNotification';
import { getReadReceiptsEnabled } from '@/lib/messaging/read-receipt-setting';
import {
  saveContactPublicKey,
  loadContactPublicKey,
  loadContactPqPublicKey,
  loadAllContactPublicKeys,
  hydrateContactKeyCache,
} from '@/lib/messaging/contact-key-cache';

import { log } from '@/lib/platform/logger';
import { getSafetyNumber, storeSafetyNumber } from '@/lib/features/features-store';
import { createSafetyNumber } from '@/lib/features/safety-numbers';
import { signMessage, verifyMessageSignature } from '@/lib/crypto/message-signing';

// Sub-hooks
import { useTypingIndicators } from '@/lib/hooks/use-typing-indicators';
import { useCallSignaling } from '@/lib/hooks/use-call-signaling';
import { useReactions } from '@/lib/hooks/use-reactions';
import { useMessageEditing } from '@/lib/hooks/use-message-editing';
import { useGroupMessaging } from '@/lib/hooks/use-group-messaging';
import { useResonanceScore } from '@/lib/messaging/resonance';
import { useReadReceipts } from '@/lib/messaging/read-receipts';
import { useBurnRequests } from '@/lib/messaging/burn';
import { useIdentity } from '@/lib/messaging/identity';
import { useDictionary } from '@/lib/messaging/dictionary';
import { useKeyExchange } from '@/lib/messaging/key-exchange';
import { useResync } from '@/lib/messaging/resync';
import { useContacts } from '@/lib/messaging/contacts';
import { useMessageSend } from '@/lib/messaging/send';
import { useMessageReceive } from '@/lib/messaging/receive';
import { useConnection } from '@/lib/messaging/connection';

// Types — imported from shared types file
import type {
  MessageWithStatus,
  SessionData,
  CallSignalEvent,
  GroupConversation,
  SharedMessagingRefs,
  SharedMessagingState,
} from '@/lib/hooks/messaging-types';

// Re-export types so existing imports from 'use-relay-messaging' still work
export type { MessageWithStatus, CallSignalEvent, GroupConversation } from '@/lib/hooks/messaging-types';

// ─────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────

export function useRelayMessaging() {
  const router = useRouter();
  const service = getMessagingService();
  const authStore = useRelayAuthStoreV2();

  // State
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<Map<string, MessageWithStatus[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const [sessionStats, setSessionStats] = useState<Map<string, { msgCount: number; savedPercent: number }>>(new Map());
  const [storageReady, setStorageReady] = useState(false);
  const [groups, setGroups] = useState<GroupConversation[]>([]);

  // Refs
  const wsRef = useRef<RelayWebSocketClient | null>(null);
  const sessionsRef = useRef<Map<string, SessionData>>(new Map());
  const identityRef = useRef<{ privateKey: Uint8Array; publicKey: Uint8Array; relayId: string; pqPrivateKey?: Uint8Array; pqPublicKey?: Uint8Array } | null>(null);
  const dictRef = useRef<Uint8Array | null>(null);
  // Queue (not single-slot) per contact — a contact can accumulate more than
  // one message while its key exchange is still pending.
  const pendingMessagesRef = useRef<Map<string, Array<{ relayId: string; text: string; messageId?: string; _queuedAt?: number }>>>(new Map());
  const reconnectQueueRef = useRef<Array<{ contactRelayId: string; text: string; msgId: string; replyTo?: { messageId: string; senderName: string; textPreview: string } }>>([]);
  const pendingFilesRef = useRef<Map<string, { relayId: string; payload: string; msgId: string; filename: string; fileSize: number; mimeType: string; dataUrl: string }>>(new Map());
  const cleanupIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const keyExchangeInitiatedRef = useRef<Set<string>>(new Set()); // Track which contacts we've initiated key exchange with
  const contactsRef = useRef<Contact[]>([]); // Track latest contacts for use in callbacks
  const groupsRef = useRef<GroupConversation[]>([]); // Track latest groups for use in callbacks (see sendGroupFile's membership-race fix)
  const initializationCompleteRef = useRef(false); // Track when all async init is done
  const sentMessagesRef = useRef<Map<string, number | NodeJS.Timeout>>(new Map()); // msgId -> timestamp when sent, or timeout handle for msgId_timeout
  const keyExchangeTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map()); // contactId -> timeout

  // Feature: Burn requests
  const burnTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Ref to always hold the latest handleMessageReceived (fixes stale closure bug)
  const handleMessageReceivedRef = useRef<((msg: any) => void) | null>(null);

  // Time-based cooldown to prevent key exchange response loops (fixes post-refresh session bug)
  const keyExchangeLastResponseRef = useRef<Map<string, number>>(new Map());

  // Queue for incoming encrypted messages that arrived before session was ready
  const pendingEncryptedRef = useRef<Map<string, Array<{ msg: any; receivedAt: number }>>>(new Map());

  // Pending PQ shared secrets: when we initiate a hybrid key exchange, we store
  // the PQ shared secret here until we receive the responder's reply and create
  // the session. Keyed by contact relay ID.
  const pendingPqSecretsRef = useRef<Map<string, Uint8Array>>(new Map());

  // ─────────────────────────────────────────────────────────────────────
  // SUB-HOOK COMPOSITION — shared refs & state passed to each sub-hook
  // ─────────────────────────────────────────────────────────────────────

  const sharedRefs: SharedMessagingRefs = {
    wsRef, sessionsRef, identityRef, dictRef,
    pendingMessagesRef, reconnectQueueRef, pendingFilesRef,
    keyExchangeInitiatedRef, contactsRef, groupsRef, sentMessagesRef, keyExchangeTimeoutsRef,
    handleMessageReceivedRef, keyExchangeLastResponseRef, pendingEncryptedRef, pendingPqSecretsRef,
    initializationCompleteRef,
  };
  const sharedState: SharedMessagingState = { messages, setMessages, contacts, setContacts, groups, setGroups };

  // NOTE: initiateKeyExchange is defined below and used by sub-hooks.
  // We define a stable ref so sub-hooks can receive it at construction time.
  const initiateKeyExchangeRef = useRef<(contactRelayId: string, publicKeyHex: string) => void>(() => {});
  const initiateKeyExchangeForHooks = useCallback(
    (contactRelayId: string, publicKeyHex: string) => {
      initiateKeyExchangeRef.current(contactRelayId, publicKeyHex);
    },
    []
  );

  // Instantiate sub-hooks
  const typing = useTypingIndicators(sharedRefs);
  const callSignaling = useCallSignaling(sharedRefs, initiateKeyExchangeForHooks);
  const reactions = useReactions({ shared: sharedRefs, state: sharedState, initiateKeyExchange: initiateKeyExchangeForHooks });
  const messageEditing = useMessageEditing({ shared: sharedRefs, state: sharedState, initiateKeyExchange: initiateKeyExchangeForHooks });
  const groupMessaging = useGroupMessaging({ shared: sharedRefs, state: sharedState, initiateKeyExchange: initiateKeyExchangeForHooks });
  const calculateResonanceScore = useResonanceScore(messages);
  const { deleteMessageLocal, removeMessageLocal, sendReadReceiptToContact } = useReadReceipts({ shared: sharedRefs, state: sharedState });
  const { initiateBurnRequest, handleBurnRequest, handleBurnConfirm } = useBurnRequests({ shared: sharedRefs, state: sharedState });
  const loadIdentity = useIdentity({ shared: sharedRefs, authStore, router, setError });
  const loadDictionary = useDictionary(sharedRefs);
  const { initiateKeyExchange, handleKeyExchangeReceived } = useKeyExchange({
    shared: sharedRefs,
    state: sharedState,
    loadDictionary,
  });
  // Keep the ref in sync so sub-hooks (reactions/messageEditing/groupMessaging,
  // via initiateKeyExchangeForHooks) always call the latest version.
  useEffect(() => {
    initiateKeyExchangeRef.current = initiateKeyExchange;
  }, [initiateKeyExchange]);
  const { initiateResync, handleResyncRequestReceived, handleResyncResponseReceived } = useResync({
    shared: sharedRefs,
    state: sharedState,
    initiateKeyExchange,
  });
  const { loadContacts, loadMessages, addContact, markAsRead, markConversationAsRead, cleanupExpired } =
    useContacts({ shared: sharedRefs, state: sharedState, service, setLoading, setError });

  // ─────────────────────────────────────────────────────────────────────
  // SESSION STATS
  // ─────────────────────────────────────────────────────────────────────

  const updateSessionStats = useCallback((contactId: string) => {
    setMessages((prev) => {
      const contactMsgs = prev.get(contactId) || [];
      const totalOriginal = contactMsgs.reduce(
        (sum, m) => sum + (m.metadata?.original_size || 0),
        0
      );
      const totalCompressed = contactMsgs.reduce(
        (sum, m) => sum + (m.metadata?.compressed_size || 0),
        0
      );
      const savedBytes = totalOriginal - totalCompressed;
      const savedPercent =
        totalOriginal > 0 ? Math.round((savedBytes / totalOriginal) * 100) : 0;

      setSessionStats((prev) => {
        const updated = new Map(prev);
        updated.set(contactId, {
          msgCount: contactMsgs.length,
          savedPercent,
        });
        return updated;
      });

      return prev;
    });
  }, []);

  const { sendMessage, sendFile } = useMessageSend({
    shared: sharedRefs,
    state: sharedState,
    initiateKeyExchange: initiateKeyExchangeForHooks,
    updateSessionStats,
  });
  const { handleMessageReceived, updateMessageStatus } = useMessageReceive({
    shared: sharedRefs,
    state: sharedState,
    initiateKeyExchange: initiateKeyExchangeForHooks,
    loadDictionary,
    updateSessionStats,
    applyReactionToState: reactions.applyReactionToState,
    handleGroupMessage: groupMessaging.handleGroupMessage,
    initiateResync,
  });
  const { initializeWebSocket } = useConnection({
    shared: sharedRefs,
    state: sharedState,
    router,
    loadIdentity,
    loadDictionary,
    initiateKeyExchange,
    handleKeyExchangeReceived,
    updateMessageStatus,
    handleBurnRequest,
    handleBurnConfirm,
    handleResyncRequest: handleResyncRequestReceived,
    handleResyncResponse: handleResyncResponseReceived,
    handleTypingIndicator: typing.handleTypingIndicator,
    handleCallSignal: callSignaling.handleCallSignal,
    setConnectionStatus,
    setError,
  });

  // NOTE: loadIdentity -> useIdentity sub-hook
  // NOTE: initializeWebSocket -> useConnection sub-hook

  // NOTE: initializeWebSocket -> useConnection sub-hook
  // NOTE: loadDictionary -> useDictionary sub-hook
  // NOTE: initiateKeyExchange, handleKeyExchangeReceived -> useKeyExchange sub-hook
  // NOTE: sendMessage, sendFile -> useMessageSend sub-hook
  // NOTE: handleMessageReceived, updateMessageStatus -> useMessageReceive sub-hook

  // NOTE: Ephemeral countdown UI is handled in MessageBubble component via useEffect.
  // NOTE: initiateBurnRequest, confirmBurn, handleBurnRequest, handleBurnConfirm -> useBurnRequests sub-hook

  // ─────────────────────────────────────────────────────────────────────
  // STANDARD HOOKS
  // ─────────────────────────────────────────────────────────────────────

  // NOTE: Typing indicators -> useTypingIndicators sub-hook
  // NOTE: Reactions (send, revoke, handle) -> useReactions sub-hook

  // NOTE: loadContacts, loadMessages, addContact, markAsRead, markConversationAsRead,
  //       cleanupExpired -> useContacts sub-hook

  // ─────────────────────────────────────────────────────────────────────
  // EFFECTS
  // ─────────────────────────────────────────────────────────────────────

  // Initialize on mount
  useEffect(() => {
    // Set current user in messaging service from auth store
    const initService = async () => {
      const identity = await loadIdentity();
      const { currentUserId } = useRelayAuthStoreV2.getState();
      
      if (identity && currentUserId) {
        // Create a temporary user record in the messaging service storage
        // This bridges the gap between the new auth store and the old messaging service
        try {
          // Get or create a user record in localStorage for this identity
          const allUsers = JSON.parse(localStorage.getItem('relay:users') || '[]');
          const existingUser = allUsers.find((u: any) => u.id === currentUserId);
          
          if (!existingUser) {
            // Create a minimal user record
            const userRecord = {
              id: currentUserId,
              name: useRelayAuthStoreV2.getState().currentRelayId || 'Me',
              publicKey: Array.from(identity.publicKey),
              privateKey: Array.from(identity.privateKey),
              createdAt: new Date().toISOString(),
              lastLogin: new Date().toISOString(),
              isVerified: true,
            };
            allUsers.push(userRecord);
            localStorage.setItem('relay:users', JSON.stringify(allUsers));
          }
        } catch (err) {
          log.warn('Failed to create user record:', err);
        }
        
        service.setCurrentUserId(currentUserId);
      } else {
        log.warn('[Service Init] Cannot initialize service - missing identity or currentUserId');
      }
    };
    
    // CRITICAL: Load dictionary FIRST before doing anything else
    // Use a cancellation flag to prevent React StrictMode's double-invocation from
    // creating two WebSocket connections (which causes an infinite reconnect loop:
    // relay closes the first connection when the second registers, the first then
    // auto-reconnects, displacing the second, and so on forever).
    let cancelled = false;

    const initializeApp = async () => {
      try {
        // 1. Load identity first
        const identity = await loadIdentity();
        if (!identity || cancelled) return;

        // 2. Initialize storage and load dictionary in parallel (independent operations)
        const [, dict] = await Promise.all([
          initStorage(identity.privateKey).then(() => {
            if (cancelled) return;
            setStorageReady(true);
            // Hydrate key cache after storage is ready (depends on storage)
            return hydrateContactKeyCache();
          }),
          loadDictionary(),
        ]);
        if (cancelled) return;
        if (!dict || dict.length === 0) {
          setError('Failed to load dictionary. Try refreshing the page.');
          toast.error('Encryption error', 'Failed to load crypto dictionary. Try refreshing.');
          return;
        }

        // 3. Initialize service and load contacts (both depend on storage being ready)
        await initService();
        await Promise.all([
          loadContacts(),
          Promise.resolve(groupMessaging.loadGroupsFromStorage()),
        ]);
        
        // 5. Initialize WebSocket
        if (cancelled) return;
        await initializeWebSocket();
        if (cancelled) return;
        
        // 6. MARK INITIALIZATION AS COMPLETE
        // This must be the very last step - it unlocks sending messages
        initializationCompleteRef.current = true;
      } catch (err) {
        if (cancelled) return;
        const errMsg = err instanceof Error ? err.message : 'Initialization failed';
        setError(errMsg);
        toast.error('Startup error', errMsg);
        initializationCompleteRef.current = false;
      }
    };
    
    initializeApp();

    return () => {
      // Cancel any in-flight async initialization so the second StrictMode mount
      // (or a genuine unmount) starts completely clean.
      cancelled = true;
      if (wsRef.current) {
        wsRef.current.disconnect();
        wsRef.current = null;
      }
      initializationCompleteRef.current = false;
    };
  }, []);

  // Cleanup interval - expires old messages and times out stuck messages
  useEffect(() => {
    const cleanupRoutine = async () => {
      // Clean up expired messages
      await cleanupExpired();

      const now = Date.now();

      // Garbage-collect stale pending messages (older than 5 minutes)
      const PENDING_STALE_MS = 5 * 60 * 1000;
      for (const [key, queue] of pendingMessagesRef.current) {
        const fresh = queue.filter(
          (entry) => entry._queuedAt === undefined || now - entry._queuedAt <= PENDING_STALE_MS
        );
        if (fresh.length === 0) {
          pendingMessagesRef.current.delete(key);
        } else if (fresh.length !== queue.length) {
          pendingMessagesRef.current.set(key, fresh);
        }
      }

      // Garbage-collect old sent-message timestamps (older than 5 minutes)
      for (const [msgId, timestamp] of sentMessagesRef.current) {
        if (typeof timestamp === 'number' && now - timestamp > PENDING_STALE_MS) {
          sentMessagesRef.current.delete(msgId);
        }
      }

      // Clean up stuck "sending" messages (stuck for more than 60 seconds)
      const SENDING_TIMEOUT_MS = 60000; // 60 seconds
      
      setMessages((prev) => {
        let hasChanges = false;
        const updated = new Map(prev);
        
        for (const [contactId, msgs] of updated) {
          const updatedMsgs = msgs.map((msg) => {
            if (msg.status === 'sending' && sentMessagesRef.current.has(msg.id)) {
              const sentTime = sentMessagesRef.current.get(msg.id);
              if (typeof sentTime === 'number' && now - sentTime > SENDING_TIMEOUT_MS) {
                log.warn(`[Message] Auto-timing out stuck message ${msg.id} (${now - sentTime}ms old)`);
                hasChanges = true;
                return {
                  ...msg,
                  status: 'error' as const,
                  errorMessage: 'Message delivery timeout - relay server may be unreachable',
                };
              }
            }
            // Belt-and-suspenders against the relay's own purge_notice
            // (connection.ts's handlePurgeNotice) never arriving — a missed
            // WS event, a reconnect gap, whatever — by checking each still-
            // "pending" message's own server-assigned expiresAt directly.
            // Only 'pending' is checked: a delivered/read message reuses the
            // same `expiresAt` field for ghost-mode self-destruct timing,
            // which is an unrelated concept this must not touch.
            if (msg.status === 'pending' && msg.expiresAt && now > msg.expiresAt) {
              log.warn(`[Message] ${msg.id} past its relay-queue expiresAt with no purge_notice received — marking failed`);
              hasChanges = true;
              return {
                ...msg,
                status: 'error' as const,
                errorMessage: 'Message expired before it could be delivered',
              };
            }
            return msg;
          });
          
          if (hasChanges) {
            updated.set(contactId, updatedMsgs);
          }
        }
        
        return hasChanges ? updated : prev;
      });
    };
    
    cleanupIntervalRef.current = setInterval(cleanupRoutine, 10000); // Check every 10 seconds
    
    return () => {
      if (cleanupIntervalRef.current) clearInterval(cleanupIntervalRef.current);
    };
  }, [cleanupExpired]);

  // Sync contacts to ref for use in callbacks
  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  // Sync groups to ref for use in callbacks (see sendGroupFile's membership-race fix)
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Merge messages into contacts and deduplicate
  const contactsWithMessages = (() => {
    // Deduplicate contacts by ID - keep the first occurrence
    const seen = new Set<string>();
    const uniqueContacts = contacts.filter((contact) => {
      if (seen.has(contact.id)) {
        return false;
      }
      seen.add(contact.id);
      return true;
    });
    
    // Map messages into the deduplicated contacts
    return uniqueContacts.map((contact) => {
      const contactId = contact.relayId || contact.id;
      const msgs = messages.get(contactId) || contact.messages || [];
      if (msgs.length > 0 && messages.has(contactId)) {
      }
      return {
        ...contact,
        messages: msgs,
      };
    });
  })();



  // NOTE: sendMessageEdit -> useMessageEditing sub-hook
  // NOTE: sendCallOffer/Answer/Ice/Ring/Hangup/Peers, consumeCallSignals -> useCallSignaling sub-hook
  // NOTE: createGroup, sendGroupMessage, sendGroupFile, renameGroup, addGroupMembers,
  //       removeGroupMember, setGroupAdmin, transferGroupOwnership, leaveGroup,
  //       loadGroupsFromStorage, handleGroupMessage -> useGroupMessaging sub-hook


  // Manual reconnect — tears down the current socket and initiates a fresh connection.
  const reconnect = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const identity = identityRef.current;
    if (!identity) return;
    setConnectionStatus('connecting');
    ws.disconnect();
    ws.connect(toHex(identity.publicKey)).catch((err: unknown) => {
      log.error('[WS] Reconnect failed:', err);
      setConnectionStatus('error');
    });
  }, []);

  return {
    // Core state
    contacts: contactsWithMessages,
    groups,
    messages,
    loading,
    error,
    connectionStatus,
    sessionStats,
    reconnect,

    // Core messaging
    loadContacts,
    loadMessages,
    sendMessage,
    sendFile,
    addContact,
    markAsRead,
    markConversationAsRead,
    cleanupExpired,
    deleteMessage: deleteMessageLocal,
    removeMessageLocal,
    sendReadReceipt: sendReadReceiptToContact,
    burnConversation: initiateBurnRequest,

    // Typing indicators (from sub-hook)
    sendTypingIndicator: typing.sendTypingIndicator,

    // Reactions (from sub-hook)
    sendReaction: reactions.sendReaction,
    sendReactionRevoke: reactions.sendReactionRevoke,

    // Message editing (from sub-hook)
    sendMessageEdit: messageEditing.sendMessageEdit,

    // Call signaling (from sub-hook)
    callSignals: callSignaling.callSignals,
    consumeCallSignals: callSignaling.consumeCallSignals,
    sendCallOffer: callSignaling.sendCallOffer,
    sendCallAnswer: callSignaling.sendCallAnswer,
    sendCallIce: callSignaling.sendCallIce,
    sendCallRing: callSignaling.sendCallRing,
    sendCallHangup: callSignaling.sendCallHangup,
    sendCallPeers: callSignaling.sendCallPeers,

    // Group messaging (from sub-hook)
    createGroup: groupMessaging.createGroup,
    sendGroupMessage: groupMessaging.sendGroupMessage,
    sendGroupFile: groupMessaging.sendGroupFile,
    renameGroup: groupMessaging.renameGroup,
    setGroupDisappearing: groupMessaging.setGroupDisappearing,
    addGroupMembers: groupMessaging.addGroupMembers,
    removeGroupMember: groupMessaging.removeGroupMember,
    setGroupAdmin: groupMessaging.setGroupAdmin,
    transferGroupOwnership: groupMessaging.transferGroupOwnership,
    leaveGroup: groupMessaging.leaveGroup,
  };
}
