/**
 * Shared types and interfaces for the Relay messaging hook system.
 * These are used across all sub-hooks that compose useRelayMessaging.
 */

import type { Contact, Message, CompressionMetadata } from '@/lib/mock-data';
import type { RelayWebSocketClient } from '@/lib/relay/relay-websocket';
import type { Session } from '@/lib/crypto/relay-crypto';

// ─────────────────────────────────────────────────────────────────────────
// MESSAGE TYPES
// ─────────────────────────────────────────────────────────────────────────

export interface MessageWithStatus extends Message {
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'pending' | 'error';
  expiresAt?: number;
  errorMessage?: string;
}

export interface SessionData {
  relayId: string;
  session: Session;
  publicKeyHex: string;
  /**
   * Peer's Ed25519 signing public key (hex), exchanged alongside the X25519
   * key during key exchange — see lib/crypto/message-signing.ts's
   * deriveSigningKeypair for why this can't just be the X25519 key.
   * Absent for a peer running an older build that hasn't sent one yet;
   * treat as "can't verify this peer's signatures" rather than an error.
   */
  signingPublicKeyHex?: string;
}

export interface ConversationMetrics {
  totalMessages: number;
  avgCompressionRatio: number;
}

// ─────────────────────────────────────────────────────────────────────────
// CALL SIGNAL TYPES
// ─────────────────────────────────────────────────────────────────────────

export interface CallSignalEvent {
  type: 'call_offer' | 'call_answer' | 'call_ice' | 'call_hangup' | 'call_ring' | 'call_peers';
  fromRelayId: string;
  toRelayId?: string;
  callId: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  reason?: string;
  peerIds?: string[];
  receivedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────
// GROUP TYPES
// ─────────────────────────────────────────────────────────────────────────

export interface GroupConversation {
  id: string;
  name: string;
  memberIds: string[];
  ownerId: string;
  adminIds: string[];
  createdAt: number;
  updatedAt: number;
  messages: MessageWithStatus[];
  avatarEmoji?: string;
  avatarColor?: string;
  description?: string;
  visibility?: 'public' | 'private';
  publicHandle?: string;
  joinPolicy?: 'open' | 'request';
  /** Seconds after send that a group message auto-expires; unset/0 = off. Synced to all members via a `group_event`. */
  disappearAfter?: number;
}

export interface GroupCreateOptions {
  avatarEmoji?: string;
  avatarColor?: string;
  description?: string;
  visibility?: 'public' | 'private';
  publicHandle?: string;
  joinPolicy?: 'open' | 'request';
}

// ─────────────────────────────────────────────────────────────────────────
// SHARED REFS — passed to each sub-hook from the orchestrator
// ─────────────────────────────────────────────────────────────────────────

export interface IdentityInfo {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  relayId: string;
  pqPrivateKey?: Uint8Array;
  pqPublicKey?: Uint8Array;
}

export interface SharedMessagingRefs {
  wsRef: React.MutableRefObject<RelayWebSocketClient | null>;
  sessionsRef: React.MutableRefObject<Map<string, SessionData>>;
  identityRef: React.MutableRefObject<IdentityInfo | null>;
  dictRef: React.MutableRefObject<Uint8Array | null>;
  // Queue (not single-slot) per contact — a contact can accumulate more than
  // one message while its key exchange is still pending.
  pendingMessagesRef: React.MutableRefObject<Map<string, Array<{ relayId: string; text: string; messageId?: string; _queuedAt?: number }>>>;
  reconnectQueueRef: React.MutableRefObject<Array<{ contactRelayId: string; text: string; msgId: string; replyTo?: { messageId: string; senderName: string; textPreview: string } }>>;
  pendingFilesRef: React.MutableRefObject<Map<string, { relayId: string; payload: string; msgId: string; filename: string; fileSize: number; mimeType: string; dataUrl: string }>>;
  keyExchangeInitiatedRef: React.MutableRefObject<Set<string>>;
  contactsRef: React.MutableRefObject<Contact[]>;
  groupsRef: React.MutableRefObject<GroupConversation[]>;
  sentMessagesRef: React.MutableRefObject<Map<string, number | NodeJS.Timeout>>;
  keyExchangeTimeoutsRef: React.MutableRefObject<Map<string, NodeJS.Timeout>>;
  // Ref to always hold the latest handleMessageReceived (fixes stale closure bug)
  handleMessageReceivedRef: React.MutableRefObject<((msg: any) => void) | null>;
  // Time-based cooldown to prevent key exchange response loops (fixes post-refresh session bug)
  keyExchangeLastResponseRef: React.MutableRefObject<Map<string, number>>;
  // Queue for incoming encrypted messages that arrived before session was ready
  pendingEncryptedRef: React.MutableRefObject<Map<string, Array<{ msg: any; receivedAt: number }>>>;
  // Pending PQ shared secrets: when we initiate a hybrid key exchange, we store
  // the PQ shared secret here until we receive the responder's reply and create
  // the session. Keyed by contact relay ID.
  pendingPqSecretsRef: React.MutableRefObject<Map<string, Uint8Array>>;
  // True once the initial async init sequence (identity, dictionary, WS connect) is done
  initializationCompleteRef: React.MutableRefObject<boolean>;
}

export interface SharedMessagingState {
  messages: Map<string, MessageWithStatus[]>;
  setMessages: React.Dispatch<React.SetStateAction<Map<string, MessageWithStatus[]>>>;
  contacts: Contact[];
  setContacts: React.Dispatch<React.SetStateAction<Contact[]>>;
  groups: GroupConversation[];
  setGroups: React.Dispatch<React.SetStateAction<GroupConversation[]>>;
}
