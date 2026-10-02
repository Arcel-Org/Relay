/**
 * Outgoing text messages and file transfers. If no session exists yet with
 * the recipient, the message/file is queued (pendingMessagesRef /
 * pendingFilesRef) and a key exchange is kicked off — key-exchange.ts drains
 * those queues once the session is established. Both sides must operate on
 * the SAME ref instances (passed down from the orchestrator via `shared`),
 * or queued messages silently vanish.
 */

import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { toHex } from '@/lib/crypto/hex-utils';
import { log } from '@/lib/platform/logger';
import { toast } from '@/components/ToastNotification';
import { normalizeUserId } from '@/lib/messaging/username-lookup';
import { isValidRelayId } from '@/lib/crypto/relay-id';
import { isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';
import { persistMessage } from '@/lib/messaging/message-persistence';
import { computeExpiresAt } from '@/lib/messaging/ghost-mode';
import { signMessage, deriveSigningKeypair } from '@/lib/crypto/message-signing';
import { loadContactPublicKey, saveRatchetState } from '@/lib/messaging/contact-key-cache';
import type { SharedMessagingRefs, SharedMessagingState, MessageWithStatus } from '@/lib/hooks/messaging-types';
import type { CompressionMetadata } from '@/lib/mock-data';

// Configurable per-deployment file-size cap (defaults to 10 MB when unset or
// non-positive) — a fixed 10 MB constant left operators with no way to raise
// or lower the limit without a code change.
const MAX_FILE_SIZE_MB = Number(process.env.NEXT_PUBLIC_MAX_FILE_SIZE_MB) > 0
  ? Number(process.env.NEXT_PUBLIC_MAX_FILE_SIZE_MB)
  : 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// The relay hard-caps a single encrypted blob at 64KB — long text messages
// must be split into ordered segments before encryption, each sent as its
// own relay frame, and reassembled on the receive side (see receive.ts's
// segmentBuffers). 8000 chars keeps every segment's encrypted+hex-encoded
// size comfortably under that cap even for worst-case (all multi-byte)
// text.
const SEGMENT_TEXT_CHARS = 8000;

function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

interface UseMessageSendParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  initiateKeyExchange: (contactRelayId: string, publicKeyHex: string) => void;
  updateSessionStats: (contactId: string) => void;
}

export function useMessageSend({ shared, state, initiateKeyExchange, updateSessionStats }: UseMessageSendParams) {
  const {
    wsRef, identityRef, dictRef, sessionsRef,
    reconnectQueueRef, pendingMessagesRef, pendingFilesRef,
    sentMessagesRef, keyExchangeTimeoutsRef, keyExchangeInitiatedRef,
    initializationCompleteRef,
  } = shared;
  const { contacts, setContacts, setMessages } = state;

  const sendMessage = useCallback(
    async (toContactId: string, text: string, replyTo?: { messageId: string; senderName: string; textPreview: string }) => {
      // CHECK 1: Initialization must be complete
      if (!initializationCompleteRef.current) {
        throw new Error('Messaging system is still initializing. Please wait a moment and try again.');
      }

      // CHECK 2: WebSocket must exist
      const ws = wsRef.current;
      if (!ws) {
        throw new Error('WebSocket client not initialized');
      }

      // CHECK 3: Identity must be loaded
      if (!identityRef.current) {
        throw new Error('User identity not loaded. Please log in again.');
      }

      // Prevent self-messaging before queueing (catches both online and offline paths)
      if (toContactId === identityRef.current.relayId) {
        throw new Error('You cannot message yourself');
      }
      const contactEntryForSelf = contacts.find((c) => c.id === toContactId || c.relayId === toContactId);
      if (contactEntryForSelf?.relayId === identityRef.current.relayId) {
        throw new Error('You cannot message yourself');
      }

      if (!ws.isReady()) {
        // Connection is temporarily down — queue the message and show it as pending.
        // It will be sent automatically once the relay reconnects and key exchange completes.
        const msgId = uuidv4();
        const resolvedId = toContactId;
        const contactEntry = contacts.find((c) => c.id === resolvedId || c.relayId === resolvedId);
        const contactRelayId = contactEntry?.relayId || resolvedId;

        reconnectQueueRef.current.push({ contactRelayId, text, msgId, replyTo });

        const contactPublicKey = contactEntry?.publicKeyHex || loadContactPublicKey(contactRelayId) || undefined;
        const queuedMsg: MessageWithStatus = {
          id: msgId,
          senderId: identityRef.current.relayId,
          senderName: 'You',
          text,
          replyTo: replyTo ?? undefined,
          timestamp: new Date(),
          isOwn: true,
          read: true,
          delivered: false,
          status: 'pending',
          reactions: [],
          publicKeyHex: contactPublicKey,
          metadata: {
            compression_ratio: 0,
            original_size: text.length,
            compressed_size: 0,
            encrypted_size: 0,
            latency_ms: 0,
            neural_model_score: 0,
          },
        };

        setMessages((prev) => {
          const updated = new Map(prev);
          const msgs = updated.get(contactRelayId) || [];
          updated.set(contactRelayId, [...msgs, queuedMsg]);
          return updated;
        });

        return queuedMsg;
      }

      // CHECK 4: Dictionary must be loaded
      if (!dictRef.current || dictRef.current.length === 0) {
        throw new Error('Encryption dictionary not loaded. Try refreshing the page.');
      }

      // Resolve username/short code to relayId if needed
      let resolvedContactId = toContactId;
      if (!isValidRelayId(toContactId)) {
        const resolved = await normalizeUserId(toContactId);
        if (!resolved) {
          throw new Error(`User not found: ${toContactId}`);
        }
        resolvedContactId = resolved;
      }

      // FIX: Prevent self-messaging
      if (resolvedContactId === identityRef.current.relayId) {
        throw new Error('You cannot message yourself');
      }

      // Find contact to get relayId - but if not found, use resolved ID directly
      let contact = contacts.find((c) => c.id === resolvedContactId || c.relayId === resolvedContactId);
      const contactRelayId = contact?.relayId || resolvedContactId;

      // Get or create session - look by relayId not by contact ID
      let sessionData = sessionsRef.current.get(contactRelayId);
      if (!sessionData) {

        // Return optimistic message while we wait for key exchange
        const msgId = uuidv4();

        // Queue message for later using relayId as the key (include messageId for
        // tracking). Push onto the per-contact queue — a second message sent to
        // the same not-yet-connected contact must not overwrite the first.
        const existingQueue = pendingMessagesRef.current.get(contactRelayId) || [];
        existingQueue.push({
          relayId: contactRelayId,
          text,
          messageId: msgId, // Track the messageId so we can update it later
          _queuedAt: Date.now(), // read by use-relay-messaging.ts's stale-entry GC
        });
        pendingMessagesRef.current.set(contactRelayId, existingQueue);

        // Track when this message was sent (for timeout)
        sentMessagesRef.current.set(msgId, Date.now());

        // Initiate key exchange with the contact's relayId
        initiateKeyExchange(
          contactRelayId,
          contact?.publicKeyHex || ''
        );

        // Set a timeout for key exchange. If it doesn't complete, retry with
        // backoff before finally giving up. An established session in the interim
        // (detected via sessionsRef) short-circuits the error path.
        if (keyExchangeTimeoutsRef.current.has(contactRelayId)) {
          clearTimeout(keyExchangeTimeoutsRef.current.get(contactRelayId)!);
        }

        const MAX_KX_ATTEMPTS = 3;
        const KX_BASE_DELAY_MS = 8000; // 8s, 16s, 24s — ~48s total budget
        const scheduleKxAttempt = (attempt: number) => {
          const delay = KX_BASE_DELAY_MS * attempt;
          const timeout = setTimeout(async () => {
            keyExchangeTimeoutsRef.current.delete(contactRelayId);

            // If session was established meanwhile, we're done — bail out silently.
            if (sessionsRef.current.has(contactRelayId)) {
              log.debug(`[KeyExchange] Session established before retry for ${contactRelayId} — aborting retry.`);
              return;
            }

            const hasStoredKey = !!loadContactPublicKey(contactRelayId);
            const hasDict = !!dictRef.current && dictRef.current.length > 0;
            const wsReady = !!wsRef.current?.isReady();
            const peer = contacts.find((c) => c.relayId === contactRelayId || c.id === contactRelayId);
            log.warn(`[KeyExchange] attempt ${attempt}/${MAX_KX_ATTEMPTS} timeout for ${contactRelayId}`, {
              hasSession: false,
              hasStoredKey,
              hasDict,
              wsReady,
              online: peer?.isOnline,
              username: peer?.username,
            });

            if (attempt < MAX_KX_ATTEMPTS) {
              // Re-kick the handshake and wait again with a longer delay.
              keyExchangeInitiatedRef.current.delete(contactRelayId);
              initiateKeyExchange(contactRelayId, peer?.publicKeyHex || '');
              scheduleKxAttempt(attempt + 1);
              return;
            }

            // Final attempt exhausted — try a contact-refresh before erroring out.
            const username = peer?.username;
            if (username) {
              try {
                const freshId = await normalizeUserId('@' + username);
                if (freshId && freshId !== contactRelayId) {
                  log.debug(`[Contact] Contact ${username} relayId changed: ${contactRelayId} -> ${freshId}. Updating.`);
                  setContacts((prev) => prev.map((c) =>
                    (c.relayId === contactRelayId || c.id === contactRelayId)
                      ? { ...c, relayId: freshId, id: freshId }
                      : c
                  ));
                  const pendingQueue = pendingMessagesRef.current.get(contactRelayId);
                  if (pendingQueue) {
                    pendingMessagesRef.current.delete(contactRelayId);
                    pendingMessagesRef.current.set(freshId, pendingQueue.map((p) => ({ ...p, relayId: freshId })));
                  }
                  initiateKeyExchange(freshId, '');
                  return;
                }
              } catch {
                // fall through to error
              }
            }

            // One last check — race-safe. If a session arrived right before we
            // flipped to error, honor it.
            if (sessionsRef.current.has(contactRelayId)) {
              log.debug(`[KeyExchange] Session established during final retry for ${contactRelayId} — skipping error.`);
              return;
            }

            // Remove this message from the pending queue — leaving it there
            // would let a session that establishes later (e.g. the contact
            // comes back online after we've already shown "error" for this
            // message) silently resurrect and send a message the UI already
            // told the user failed.
            const staleQueue = pendingMessagesRef.current.get(contactRelayId);
            if (staleQueue) {
              const filtered = staleQueue.filter((entry) => entry.messageId !== msgId);
              if (filtered.length > 0) {
                pendingMessagesRef.current.set(contactRelayId, filtered);
              } else {
                pendingMessagesRef.current.delete(contactRelayId);
              }
            }

            setMessages((prev) => {
              const updated = new Map(prev);
              const msgs = updated.get(contactRelayId) || [];
              const updatedMsgs = msgs.map((m) =>
                m.id === msgId ? { ...m, status: 'error' as const, errorMessage: 'Key exchange timeout - contact may be unreachable' } : m
              );
              updated.set(contactRelayId, updatedMsgs);
              return updated;
            });
            toast.error('Send failed', 'Key exchange timeout — contact may be unreachable.');
          }, delay);
          keyExchangeTimeoutsRef.current.set(contactRelayId, timeout);
        };
        scheduleKxAttempt(1);

        const contactPublicKey = contact?.publicKeyHex || loadContactPublicKey(contactRelayId) || undefined;
        const newMsg: MessageWithStatus = {
          id: msgId,
          senderId: identityRef.current!.relayId,
          senderName: 'You',
          text,
          timestamp: new Date(),
          isOwn: true,
          read: true,
          delivered: false,
          status: 'sending',
          reactions: [],
          publicKeyHex: contactPublicKey,
          metadata: {
            compression_ratio: 0.5,
            original_size: text.length,
            compressed_size: Math.floor(text.length * 0.5),
            encrypted_size: Math.floor(text.length * 0.6),
            latency_ms: 0,
            neural_model_score: 0.85,
          },
        };

        setMessages((prev) => {
          const updated = new Map(prev);
          // Use contactRelayId as the key for messages
          const contactMsgs = updated.get(contactRelayId) || [];
          updated.set(contactRelayId, [...contactMsgs, newMsg]);
          return updated;
        });

        return newMsg;
      }

      // Clear key exchange timeout if it exists (session is now ready)
      if (keyExchangeTimeoutsRef.current.has(contactRelayId)) {
        clearTimeout(keyExchangeTimeoutsRef.current.get(contactRelayId)!);
        keyExchangeTimeoutsRef.current.delete(contactRelayId);
      }

      const { session } = sessionData;
      const msgId = uuidv4();

      try {
        const expiresAtForMsg = computeExpiresAt(contactRelayId);

        // Sign with a dedicated Ed25519 signing key derived from our
        // identity key (independent of the session key) — the AEAD tag
        // already stops the relay from tampering with ciphertext in
        // transit, but this additionally binds the message to our identity
        // in a way that survives session resets and doesn't depend on the
        // two parties being the only ones who could have held the
        // (symmetric) session key. See deriveSigningKeypair for why this
        // can't just be the raw X25519 identity private key.
        //
        // Signed ONCE over the full original text using the group msgId —
        // not per-segment — because the receive side can only verify after
        // all segments are reassembled (see receive.ts's segmentBuffers).
        // The identical signature/timestamp is repeated on every segment's
        // envelope so reassembly can pick it up off any one of them.
        const signingKeypair = deriveSigningKeypair(identityRef.current.privateKey);
        const signed = await signMessage(msgId, text, identityRef.current.relayId, signingKeypair.privateKey);

        // The relay hard-caps a single encrypted blob at 64KB — split long
        // text into ordered segments, each independently encrypted
        // (advancing the ratchet one step per segment) and sent as its own
        // relay frame under its own messageId.
        const segments = chunkText(text, SEGMENT_TEXT_CHARS);
        const isSegmented = segments.length > 1;

        let totalOriginalSize = 0;
        let totalEncryptedSize = 0;
        let firstBlob: string | undefined;
        const sendJobs: { blob: string; frameMsgId: string }[] = [];

        for (let i = 0; i < segments.length; i++) {
          const segmentText = segments[i];
          // Encrypt (offloaded to Web Worker). Always send the structured
          // envelope now (not just when replyTo/a ghost expiry is present)
          // so every message carries a signature; the receive path still
          // accepts legacy plain-text payloads with no envelope for
          // backward compat.
          const wirePayload = JSON.stringify({
            type: 'text',
            text: segmentText,
            ...(replyTo ? { replyTo } : {}),
            ...(expiresAtForMsg !== undefined ? { expiresAt: expiresAtForMsg } : {}),
            ...(isSegmented ? { seg: { id: msgId, index: i, total: segments.length } } : {}),
            sig: signed.signature,
            sigTs: signed.timestamp,
          });
          const plaintext = new TextEncoder().encode(wirePayload);
          const encrypted = await session.encryptAsync(plaintext);
          // Persist the send-ratchet advance immediately — encryptAsync()
          // mutates in-memory chain state that would otherwise only be
          // saved on the next INCOMING message (see receive.ts), so a crash
          // right after sending permanently desyncs the outgoing direction
          // with no way to recover (the peer's recv ratchet has already
          // moved past what we'd rebuild from our last-saved snapshot).
          saveRatchetState(contactRelayId, session.serialize());

          totalOriginalSize += plaintext.length;
          totalEncryptedSize += encrypted.length;

          const blob = toHex(encrypted);
          if (i === 0) firstBlob = blob;
          const frameMsgId = isSegmented ? uuidv4() : msgId;
          sendJobs.push({ blob, frameMsgId });
        }

        // Track compression metrics (aggregated across all segments)
        const compressionMetadata: Partial<CompressionMetadata> = {
          original_size: totalOriginalSize,
          compressed_size: Math.max(0, totalEncryptedSize - 43 * segments.length - 16 * segments.length),
          latency_ms: 0,
        };

        // Create optimistic message — one logical message regardless of
        // how many wire segments it was split into.
        const newMsg: MessageWithStatus = {
          id: msgId,
          senderId: identityRef.current.relayId,
          senderName: 'You',
          text,
          timestamp: new Date(),
          isOwn: true,
          read: true,
          delivered: false,
          status: 'sending',
          reactions: [],
          publicKeyHex: sessionData.publicKeyHex,
          encryptedBlob: firstBlob,
          ghost: expiresAtForMsg !== undefined,
          expiresAt: expiresAtForMsg,
          replyTo: replyTo ?? undefined,
          metadata: {
            compression_ratio:
              compressionMetadata.original_size! > 0
                ? compressionMetadata.compressed_size! / compressionMetadata.original_size!
                : 0,
            original_size: compressionMetadata.original_size || 0,
            compressed_size: compressionMetadata.compressed_size || 0,
            encrypted_size: totalEncryptedSize,
            latency_ms: 0,
            neural_model_score: 0.85,
          },
        };

        // Add to local state using relayId as key
        setMessages((prev) => {
          const updated = new Map(prev);
          const contactMsgs = updated.get(contactRelayId) || [];
          updated.set(contactRelayId, [...contactMsgs, newMsg]);
          return updated;
        });

        // Track when this message was sent
        sentMessagesRef.current.set(msgId, Date.now());

        // PERSIST SENT MESSAGE IMMEDIATELY TO STORAGE (skipped for ghost contacts)
        if (!isEphemeralContact(contactRelayId)) {
          persistMessage({
            id: msgId,
            conversationId: contactRelayId, // Use relayId as conversation ID
            senderId: identityRef.current.relayId,
            text,
            status: 'sending',
            timestamp: newMsg.timestamp.getTime(),
            expiresAt: expiresAtForMsg,
            ghost: expiresAtForMsg !== undefined,
          }).catch(err => log.error('Failed to persist sent message:', err));
        }

        // Send each segment over WebSocket - use relayId for relay routing
        for (const job of sendJobs) {
          ws.sendMessage(contactRelayId, job.blob, job.frameMsgId);
        }

        // Update stats
        updateSessionStats(contactRelayId);

        // Set a timeout for this message (60 seconds). If it doesn't get
        // delivered or pending status, mark as error. Skipped entirely when
        // segmented: the relay's delivered/pending ack references each
        // segment's own frameMsgId, never the group msgId the UI message
        // and this timeout are keyed by, so it could never be cleared
        // correctly and would always fire a false-positive error.
        if (!isSegmented) {
          const messageTimeout = setTimeout(() => {
            log.warn(`[Message] Message timeout ${msgId} for ${contactRelayId} - relay may be offline`);
            sentMessagesRef.current.delete(msgId);

            // Mark the message as error
            setMessages((prev) => {
              const updated = new Map(prev);
              const msgs = updated.get(contactRelayId) || [];
              const updatedMsgs = msgs.map((m) =>
                m.id === msgId ? { ...m, status: 'error' as const, errorMessage: 'Message timeout - relay server may be unavailable' } : m
              );
              updated.set(contactRelayId, updatedMsgs);
              return updated;
            });
            toast.error('Send failed', 'Message timeout — relay server may be unavailable.');
          }, 60000); // 60 second timeout

          sentMessagesRef.current.set(msgId + '_timeout', messageTimeout);
        }

        return newMsg;
      } catch (err) {
        toast.error('Send failed', 'Encryption error. Try refreshing the page.');
        throw new Error(`Failed to encrypt message: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [contacts, initiateKeyExchange, shared, setContacts, setMessages, updateSessionStats]
  );

  const sendFile = useCallback(
    async (toContactId: string, file: File) => {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `File is too large (max ${MAX_FILE_SIZE_MB} MB). Selected file is ${(file.size / 1024 / 1024).toFixed(1)} MB.`
        );
      }

      if (!initializationCompleteRef.current) {
        throw new Error('Messaging system is still initializing. Please wait a moment and try again.');
      }
      const ws = wsRef.current;
      if (!ws || !ws.isReady()) {
        throw new Error('Connection to relay server lost. Reconnecting...');
      }
      if (!identityRef.current) {
        throw new Error('User identity not loaded. Please log in again.');
      }

      let resolvedContactId = toContactId;
      if (!isValidRelayId(toContactId)) {
        const resolved = await normalizeUserId(toContactId);
        if (!resolved) throw new Error(`User not found: ${toContactId}`);
        resolvedContactId = resolved;
      }

      // Block self-messaging (including media) to prevent storage exploitation
      if (resolvedContactId === identityRef.current.relayId) {
        throw new Error('You cannot send files to yourself');
      }

      const contact = contacts.find((c) => c.id === resolvedContactId || c.relayId === resolvedContactId);
      const contactRelayId = contact?.relayId || resolvedContactId;

      // ─── PRIVACY: Anonymize filename to prevent timestamp/metadata leaks ───
      // Generate an anonymous name while preserving extension
      const fileExtension = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '';
      // A CSPRNG, not Math.random() — the whole point of this ID is to be
      // unpredictable so it can't be correlated back to anything (timing,
      // sequence, etc.); Math.random() is not seeded from an unpredictable
      // source and isn't the right tool for a value with a stated privacy
      // requirement, even though the practical stakes here are low.
      const randomId = toHex(crypto.getRandomValues(new Uint8Array(10)));
      const anonymizedFilename = `file_${randomId}${fileExtension}`;

      // Read file — strip EXIF/metadata from images by re-drawing through a canvas.
      // For non-image files we just base64-encode the raw bytes.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const isImage = file.type.startsWith('image/');
        if (isImage && typeof window !== 'undefined') {
          const objectUrl = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('No canvas context');
              ctx.drawImage(img, 0, 0);
              const outputMime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
              resolve(canvas.toDataURL(outputMime, 0.92));
            } catch {
              // Canvas failed — fall back to raw read (no metadata stripping)
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(new Error('Failed to read file'));
              reader.readAsDataURL(file);
            }
          };
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed to load image for metadata stripping'));
          };
          img.src = objectUrl;
        } else {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        }
      });

      const payload = JSON.stringify({
        type: 'file',
        filename: anonymizedFilename,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        data: dataUrl,
      });

      const msgId = uuidv4();

      // Optimistic message shown immediately regardless of session state
      // Text is empty since filename is displayed in the fileShare section (anonymized)
      const optimisticMsg: MessageWithStatus = {
        id: msgId,
        senderId: identityRef.current.relayId,
        senderName: 'You',
        text: '',
        timestamp: new Date(),
        isOwn: true,
        read: true,
        delivered: false,
        status: 'sending',
        reactions: [],
        fileShare: {
          filename: anonymizedFilename,
          originalFilename: file.name,
          original_size: file.size,
          compressed_size: 0,
          compression_ratio: 0,
          type: file.type || 'application/octet-stream',
          dataUrl,
        },
        metadata: {
          compression_ratio: 0,
          original_size: file.size,
          compressed_size: 0,
          encrypted_size: 0,
          latency_ms: 0,
          neural_model_score: 0.85,
        },
      };

      setMessages((prev) => {
        const updated = new Map(prev);
        const msgs = updated.get(contactRelayId) || [];
        updated.set(contactRelayId, [...msgs, optimisticMsg]);
        return updated;
      });

      const sessionData = sessionsRef.current.get(contactRelayId);
      if (!sessionData) {
        // No session yet — queue the file and initiate key exchange.
        // The file will be sent automatically once the session is established.
        // pendingFilesRef only has room for one queued file per contact — a
        // second sendFile() call before the first one's key exchange
        // completes would otherwise silently clobber it (the first file
        // would never send and the sender would get no error).
        if (pendingFilesRef.current.has(contactRelayId)) {
          throw new Error('A file is already queued for this contact — wait for it to send before sending another.');
        }
        pendingFilesRef.current.set(contactRelayId, {
          relayId: contactRelayId,
          payload,
          msgId,
          filename: anonymizedFilename,
          fileSize: file.size,
          mimeType: file.type || 'application/octet-stream',
          dataUrl,
        });
        sentMessagesRef.current.set(msgId, Date.now());
        initiateKeyExchange(contactRelayId, contact?.publicKeyHex || '');

        // If key exchange never completes, the queued file would otherwise
        // sit forever with no feedback to the user and permanently occupy
        // the single pendingFilesRef slot for this contact.
        const FILE_KX_TIMEOUT_MS = 45_000;
        setTimeout(() => {
          if (pendingFilesRef.current.get(contactRelayId)?.msgId !== msgId) return;
          pendingFilesRef.current.delete(contactRelayId);
          sentMessagesRef.current.delete(msgId);
          setMessages((prev) => {
            const updated = new Map(prev);
            const msgs = updated.get(contactRelayId) || [];
            updated.set(contactRelayId, msgs.map((m) =>
              m.id === msgId ? { ...m, status: 'error' as const, errorMessage: 'Key exchange timeout - contact may be unreachable' } : m
            ));
            return updated;
          });
          toast.error('Send failed', 'Key exchange timeout — contact may be unreachable.');
        }, FILE_KX_TIMEOUT_MS);

        return optimisticMsg;
      }

      const { session } = sessionData;

      const plaintext = new TextEncoder().encode(payload);
      const encrypted = await session.encryptAsync(plaintext);
      saveRatchetState(contactRelayId, session.serialize());
      const blob = toHex(encrypted);

      // Update the already-added optimistic message with real compression sizes
      setMessages((prev) => {
        const updated = new Map(prev);
        const msgs = updated.get(contactRelayId) || [];
        updated.set(contactRelayId, msgs.map((m) =>
          m.id === msgId ? {
            ...m,
            publicKeyHex: sessionData.publicKeyHex,
            encryptedBlob: blob,
            fileShare: m.fileShare ? {
              ...m.fileShare,
              compressed_size: Math.max(0, encrypted.length - 43 - 16),
              compression_ratio: file.size > 0 ? Math.max(0, (encrypted.length - 43 - 16)) / file.size : 0,
            } : m.fileShare,
            metadata: {
              ...m.metadata,
              compressed_size: Math.max(0, encrypted.length - 43 - 16),
              encrypted_size: encrypted.length,
            },
          } : m
        ));
        return updated;
      });

      sentMessagesRef.current.set(msgId, Date.now());
      ws.sendMessage(contactRelayId, blob, msgId);

      return optimisticMsg;
    },
    [contacts, initiateKeyExchange, shared, setMessages]
  );

  return { sendMessage, sendFile };
}
