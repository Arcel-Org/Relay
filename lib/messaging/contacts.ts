/**
 * Contact loading, adding, and read-state bookkeeping. Merges contacts from
 * the legacy localStorage bookkeeping service (lib/messaging/contact-bookkeeping.ts)
 * with contacts that only exist in the encrypted IndexedDB store (added via
 * an incoming message or device-sync import), and loads each contact's
 * message history from IndexedDB on load.
 */

import { useCallback } from 'react';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toHex } from '@/lib/crypto/hex-utils';
import { log } from '@/lib/platform/logger';
import { lookupUserProfile } from '@/lib/messaging/username-lookup';
import { markEphemeralContact } from '@/lib/messaging/ephemeral-contacts';
import { loadConversationMessages, markMessagePersistedRead } from '@/lib/messaging/message-persistence';
import { upsertContact } from '@/lib/db/relay-store';
import { getReadReceiptsEnabled } from '@/lib/messaging/read-receipt-setting';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { normalizeRelayId, isValidRelayId } from '@/lib/crypto/relay-id';
import { getShortHash } from '@/lib/messaging/relay-display';
import type { Contact } from '@/lib/mock-data';
import type { SharedMessagingRefs, SharedMessagingState, MessageWithStatus } from '@/lib/hooks/messaging-types';

interface MessagingServiceLike {
  getCurrentUserId: () => string | null;
  setCurrentUserId: (id: string) => void;
  getContactsAsInterface: () => Contact[];
  getConversation: (contactId: string) => unknown[];
  addContact: (userId: string, displayName: string, publicKey: Uint8Array) => Promise<Contact>;
  cleanupExpiredMessages: () => Promise<number>;
}

interface UseContactsParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  service: MessagingServiceLike;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export function useContacts({ shared, state, service, setLoading, setError }: UseContactsParams) {
  const { contactsRef, identityRef, wsRef } = shared;
  const { contacts, setContacts, setMessages } = state;

  // Load contacts
  const loadContacts = useCallback(async () => {
    try {
      setLoading(true);

      // Ensure the messaging service has the current user's ID set before
      // filtering contacts. This guards against timing windows where the
      // auth store has the ID (e.g. freshly restored from session) but
      // initService() ran while it was still null.
      const currentUserId = useRelayAuthStoreV2.getState().currentUserId;
      if (currentUserId && !service.getCurrentUserId()) {
        service.setCurrentUserId(currentUserId);
      }

      const serviceContacts = service.getContactsAsInterface();

      // The legacy messaging-service store (localStorage) is NOT the only
      // place a contact can be persisted: contacts auto-created from an
      // incoming message (see handleMessageReceived above), and contacts
      // imported via device-sync (importSyncPayload -> relay-store.ts's
      // addContact/upsertContact), are written to the encrypted IndexedDB
      // store and never touch the messaging-service localStorage schema.
      // Without merging those in here, such contacts vanish from the
      // sidebar on every reload (or never appear at all on a freshly
      // paired device) even though their keys/messages are still intact.
      // Merge them in, keyed by relayId, with the messaging-service copy
      // (which has a live session/sharedSecret) taking precedence when a
      // relayId exists in both places.
      let indexedDbOnlyContacts: Contact[] = [];
      // Keyed lookup of relay-store's archived/blocked flags — the legacy
      // messaging-service localStorage schema (serviceContacts) never carries
      // either flag, so without this overlay a fresh page load would forget
      // both settings even though ContactSidebar's toggle handlers persisted
      // them correctly (they'd only "stick" for the rest of the current tab
      // session via component-local state).
      let flagsByRelayId = new Map<string, { archived?: boolean; blocked?: boolean }>();
      try {
        const { getAllContacts } = await import('@/lib/db/relay-store');
        const stored = await getAllContacts();
        flagsByRelayId = new Map(
          stored.map((sc) => [sc.relayId, { archived: (sc as any).archived, blocked: (sc as any).blocked }])
        );
        const knownIds = new Set(
          serviceContacts.map((c) => c.relayId || c.id).filter(Boolean)
        );
        indexedDbOnlyContacts = stored
          .filter((sc) => sc.relayId && !knownIds.has(sc.relayId))
          .map((sc) => ({
            id: sc.relayId,
            relayId: sc.relayId,
            name: sc.displayName || sc.name || sc.relayId.slice(0, 11),
            displayName: sc.displayName || sc.name,
            username: sc.username,
            publicKeyHex: sc.publicKeyHex,
            avatar: 'bg-blue-600',
            isOnline: false,
            messages: [],
            addedAt: sc.addedAt,
            archived: (sc as any).archived,
            blocked: (sc as any).blocked,
          } as Contact));
      } catch (err) {
        // Storage may not be ready yet, or genuinely empty — non-fatal.
        log.warn('Failed to load IndexedDB contacts during loadContacts:', err);
      }

      const loadedContacts = [...serviceContacts, ...indexedDbOnlyContacts].map((c) => {
        const relayId = c.relayId || c.id;
        const flags = flagsByRelayId.get(relayId);
        return flags ? { ...c, archived: c.archived ?? flags.archived, blocked: c.blocked ?? flags.blocked } : c;
      });
      // Update ref immediately (before React state update) so the WebSocket
      // `connected` handler has contacts available even if it fires before render
      contactsRef.current = loadedContacts;
      setContacts(loadedContacts);

      // Async-enrich contacts that are missing avatar data (non-blocking)
      const contactsMissingAvatar = loadedContacts.filter((c) => !c.avatarEmoji);
      if (contactsMissingAvatar.length > 0) {
        Promise.all(
          contactsMissingAvatar.map(async (c) => {
            try {
              const relayId = c.relayId || c.id;
              const profile = await lookupUserProfile(relayId);
              if (profile?.avatarEmoji) {
                return { relayId, avatarEmoji: profile.avatarEmoji, avatarColor: profile.avatarColor };
              }
            } catch { /* ignore */ }
            return null;
          })
        ).then((updates) => {
          const valid = updates.filter(Boolean) as { relayId: string; avatarEmoji: string; avatarColor?: string }[];
          if (valid.length > 0) {
            setContacts((prev) =>
              prev.map((c) => {
                const update = valid.find((u) => u.relayId === (c.relayId || c.id));
                return update ? { ...c, avatarEmoji: update.avatarEmoji, avatarColor: update.avatarColor } : c;
              })
            );
          }
        }).catch(() => { /* non-critical */ });
      }

      // LOAD MESSAGES FROM INDEXEDDB for all contacts.
      // service.getConversation() reads a localStorage schema that does not match
      // what persistMessage() writes, so history was always empty after a reload.
      const myId = identityRef.current?.relayId;
      const allMessages = new Map<string, MessageWithStatus[]>();

      await Promise.all(
        loadedContacts.map(async (contact) => {
          const contactId = contact.relayId || contact.id;
          try {
            const stored = await loadConversationMessages(contactId);
            if (stored.length > 0) {
              const contactDisplayName = contact.displayName || contact.name || contactId.slice(0, 11);
              const msgs: MessageWithStatus[] = stored.map((m) => ({
                id: m.id,
                senderId: m.senderId,
                senderName: m.senderId === myId ? 'You' : contactDisplayName,
                text: m.text,
                timestamp: new Date(m.timestamp),
                isOwn: m.senderId === myId,
                // Missing on rows persisted before the `read` field existed —
                // default those to already-read rather than resurrecting old
                // history as unread (see StoredMessage's doc comment).
                read: m.read ?? true,
                delivered: m.status === 'delivered' || m.status === 'received',
                status: m.status as MessageWithStatus['status'],
                expiresAt: m.expiresAt,
                ghost: m.ghost ?? (m.expiresAt !== undefined),
                metadata: {
                  compression_ratio: 0.5,
                  original_size: m.text.length,
                  compressed_size: Math.floor(m.text.length * 0.5),
                  encrypted_size: Math.floor(m.text.length * 0.6),
                  latency_ms: 0,
                  neural_model_score: 0.85,
                },
              }));
              allMessages.set(contactId, msgs);
            }
          } catch (err) {
            log.warn(`Failed to load IndexedDB messages for ${contactId}:`, err);
          }
        })
      );

      // Merge with any in-flight messages that arrived during async loading
      setMessages((prev) => {
        const merged = new Map(allMessages);
        for (const [cId, liveMsgs] of prev) {
          if (!merged.has(cId)) {
            merged.set(cId, liveMsgs);
          } else {
            // Merge stored + live, deduplicating by message ID, preferring live copy
            const storedById = new Map(merged.get(cId)!.map((m) => [m.id, m]));
            for (const m of liveMsgs) {
              storedById.set(m.id, m); // live message wins (has fresher status)
            }
            merged.set(cId, Array.from(storedById.values()).sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp)));
          }
        }
        return merged;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [service, setLoading, setError, contactsRef, identityRef, setContacts, setMessages]);

  // Load messages for a contact
  const loadMessages = useCallback(async (contactId: string) => {
    try {
      const msgs = service.getConversation(contactId);
      setMessages((prev) => new Map(prev).set(contactId, msgs as MessageWithStatus[]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    }
  }, [service, setMessages, setError]);

  // Add new contact
  const addContact = useCallback(
    async (userId: string, publicKeyOrDisplayName: Uint8Array | string, options?: { ephemeral?: boolean }) => {
      try {
        // Determine if second param is publicKey or displayName
        let publicKey: Uint8Array;
        let displayName: string;

        if (typeof publicKeyOrDisplayName === 'string') {
          // It's a display name, generate a key
          displayName = publicKeyOrDisplayName;
          const { generateKeypair } = await import('@/lib/crypto/relay-crypto');
          const { publicKey: genKey } = generateKeypair();
          publicKey = genKey;
        } else {
          // It's a public key, use userId as display name
          publicKey = publicKeyOrDisplayName;
          displayName = userId.startsWith('@')
            ? userId.substring(1)
            : (isValidRelayId(userId) ? getShortHash(userId) : userId);
        }

        // Check if contact already exists by userId or relayId
        const normalizedId = normalizeRelayId(userId) || userId;
        const existingIndex = contacts.findIndex(
          (c) => (c.relayId || c.id) === normalizedId || c.id === userId
        );

        if (existingIndex !== -1) {
          return contacts[existingIndex];
        }

        const normalizedRelayId = normalizedId;

        // Ghost contacts skip service.addContact() entirely — that call persists
        // to localStorage (see RelayMessagingService.addContact), which is exactly
        // what an ephemeral contact must never touch. Build the contact record
        // in memory instead; real session establishment still happens normally
        // via key exchange, which itself checks isEphemeralContact() before any
        // disk write (see saveContactPublicKey).
        if (options?.ephemeral) {
          markEphemeralContact(normalizedRelayId);
        }
        const contact = options?.ephemeral
          ? {
              id: normalizedRelayId,
              relayId: normalizedRelayId,
              name: displayName,
              publicKeyHex: bytesToHex(publicKey),
              messages: [],
              lastMessage: '',
              lastMessageTime: new Date(),
              unreadCount: 0,
              isOnline: false,
            } as unknown as Contact
          : await service.addContact(normalizedRelayId, displayName, publicKey);

        // Ensure contact has proper fields
        // IMPORTANT: Always use relayId as the contact id so sendMessage routes correctly.
        // service.addContact() returns a UUID id which would cause messages to route to
        // 'UUID' instead of the real relayId.
        const enrichedContact: Contact = {
          ...contact,
          relayId: normalizedRelayId,
          name: displayName,
          id: normalizedRelayId,
        };

        // Fetch avatar from server profile
        try {
          const profile = await lookupUserProfile(normalizedRelayId);
          if (profile?.avatarEmoji) {
            enrichedContact.avatarEmoji = profile.avatarEmoji;
            enrichedContact.avatarColor = profile.avatarColor;
          }
        } catch {
          // Non-blocking — avatar will appear on next load
        }

        // Add deduplicated
        setContacts((prev) => {
          // Double-check not adding duplicate
          const exists = prev.find(
            (c) => (c.relayId || c.id) === enrichedContact.relayId ||
                   (c.relayId || c.id) === enrichedContact.id
          );

          if (exists) {
            return prev;
          }

          return [...prev, enrichedContact];
        });

        // Also persist to the encrypted IndexedDB store (relay-store.ts).
        // service.addContact() only writes to messaging-service's localStorage
        // schema — without this, a manually-added contact would be silently
        // dropped from prepareSyncPayload() (device-sync export reads only
        // from relay-store's getAllContacts()), so it would never make it to
        // a newly-paired device. Skipped for ephemeral/ghost contacts, which
        // must never touch disk. Best-effort: don't fail the add if storage
        // isn't ready yet.
        if (!options?.ephemeral) {
          try {
            await upsertContact(normalizedRelayId, {
              name: displayName,
              displayName: enrichedContact.displayName || displayName,
              username: enrichedContact.username,
              publicKeyHex: toHex(publicKey),
              addedAt: Date.now(),
            });
          } catch (err) {
            log.warn(`Failed to persist manually-added contact ${normalizedRelayId} to IndexedDB:`, err);
          }
        }

        return enrichedContact;
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : 'Failed to add contact';
        setError(errMsg);
        throw err;
      }
    },
    [contacts, service, setContacts, setError]
  );

  // Mark message as read
  const markAsRead = useCallback(
    async (messageId: string) => {
      try {
        await markMessagePersistedRead(messageId);
      } catch (err) {
        log.error('Failed to mark as read:', err);
      }
    },
    []
  );

  // Mark all unread messages in a conversation as read (updates in-memory state immediately)
  const markConversationAsRead = useCallback(
    (contactId: string) => {
      const emitReceipts = getReadReceiptsEnabled();
      setMessages((prev) => {
        const contactMsgs = prev.get(contactId);
        if (!contactMsgs) return prev;
        const hasUnread = contactMsgs.some((m) => !m.isOwn && !m.read);
        if (!hasUnread) return prev;
        // Collect the IDs we're flipping before constructing the new array
        // so we can optionally notify the sender of each.
        const newlyRead: string[] = [];
        const updated = contactMsgs.map((m) => {
          if (!m.isOwn && !m.read) {
            newlyRead.push(m.id);
            return { ...m, read: true };
          }
          return m;
        });
        // Persist to storage in the background
        newlyRead.forEach((id) => markMessagePersistedRead(id).catch(() => {}));
        // Emit read receipts to the sender only if the user opted in.
        if (emitReceipts && wsRef.current) {
          newlyRead.forEach((id) => {
            try {
              wsRef.current!.sendReadReceipt(contactId, id);
            } catch {
              /* non-fatal */
            }
          });
        }
        const next = new Map(prev);
        next.set(contactId, updated);
        return next;
      });
    },
    [setMessages, wsRef]
  );

  // Cleanup expired messages
  const cleanupExpired = useCallback(async () => {
    try {
      await service.cleanupExpiredMessages();
    } catch (err) {
      log.error('Failed to cleanup:', err);
    }
  }, [service]);

  return { loadContacts, loadMessages, addContact, markAsRead, markConversationAsRead, cleanupExpired };
}
