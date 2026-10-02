/**
 * Incoming message handling — the WS message dispatcher (still in the
 * top-level useRelayMessaging hook) calls handleMessageReceived for every
 * decryptable payload. It decrypts, verifies the sender's signature when
 * present, dispatches by envelope type (text/reaction/reaction_revoke/
 * message_edit/file/group_*), and falls back to legacy plain-text.
 *
 * handleMessageReceivedRef (in shared refs) always points at the latest
 * version of this callback — the WS `onmessage` handler calls through that
 * ref, not a captured closure, to avoid a stale-closure bug where a handler
 * bound before `contacts` loaded never sees newly-added contacts.
 */

import { useCallback, useEffect } from 'react';
import { toast } from '@/components/ToastNotification';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { log } from '@/lib/platform/logger';
import { Session, computeSharedSecret, deriveSessionRole, deriveSuiteTranscript, SUITE_CLASSICAL } from '@/lib/crypto/relay-crypto';
import { isSafeDataUrl, stripSuspiciousTextControlChars } from '@/lib/security/sanitize';
import { lookupUserProfile } from '@/lib/messaging/username-lookup';
import { resolveDisplayName } from '@/lib/messaging/relay-display';
import {
  loadContactPublicKey,
  saveContactPublicKey,
  loadContactSigningPublicKey,
  loadRatchetState,
  saveRatchetState,
} from '@/lib/messaging/contact-key-cache';
import { isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';
import { persistMessage } from '@/lib/messaging/message-persistence';
import { computeExpiresAt } from '@/lib/messaging/ghost-mode';
import { upsertContact } from '@/lib/db/relay-store';
import { sendNotification, vibrate } from '@/lib/platform/notifications';
import { getBoolSetting, playMessageBeep } from '@/lib/settings/relay-settings';
import { verifyMessageSignature } from '@/lib/crypto/message-signing';
import type { Contact } from '@/lib/mock-data';
import type { SharedMessagingRefs, SharedMessagingState, MessageWithStatus } from '@/lib/hooks/messaging-types';

// Buffers in-progress segmented text messages (see send.ts's sendMessage —
// long text is split into ordered relay frames) until all segments for a
// given (sender, group id) arrive. Module-level rather than a ref: this
// dispatcher is re-created per hook instance but the buffer must survive
// across the handful of frames a single logical message is split into,
// and there's only ever one active messaging session per tab.
interface SegmentBuffer {
  chunks: (string | undefined)[];
  total: number;
  receivedAt: number;
  replyTo?: unknown;
  sig?: string;
  sigTs?: number;
  expiresAt?: number;
}
const segmentBuffers = new Map<string, SegmentBuffer>();
const SEGMENT_BUFFER_TTL_MS = 5 * 60 * 1000;
function purgeStaleSegmentBuffers() {
  const cutoff = Date.now() - SEGMENT_BUFFER_TTL_MS;
  for (const [key, buf] of segmentBuffers) {
    if (buf.receivedAt < cutoff) segmentBuffers.delete(key);
  }
}

interface UseMessageReceiveParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  initiateKeyExchange: (contactRelayId: string, publicKeyHex: string) => void;
  loadDictionary: () => Promise<Uint8Array>;
  updateSessionStats: (contactId: string) => void;
  applyReactionToState: (messageId: string, emoji: string, fromRelayId: string, revoke: boolean, knownContactId: string) => void;
  handleGroupMessage: (parsed: any, fromRelayId: string, messageId: string, encrypted: Uint8Array) => void;
  initiateResync: (contactRelayId: string) => void;
}

export function useMessageReceive({
  shared,
  state,
  initiateKeyExchange,
  loadDictionary,
  updateSessionStats,
  applyReactionToState,
  handleGroupMessage,
  initiateResync,
}: UseMessageReceiveParams) {
  const { wsRef, sessionsRef, identityRef, handleMessageReceivedRef, pendingEncryptedRef, sentMessagesRef, contactsRef } = shared;
  const { contacts, setContacts, setMessages } = state;

  const handleMessageReceived = useCallback(async (msg: any) => {
    // Relay sends: { type: 'message', fromRelayId, messageId, encryptedMessage, ... }
    const { fromRelayId, messageId, encryptedMessage } = msg;
    purgeStaleSegmentBuffers();

    if (!fromRelayId || !encryptedMessage) {
      log.warn('Invalid message format:', msg);
      return;
    }

    // Drop everything from a blocked sender before any session lookup/
    // recovery or key-exchange response — no ACK, no session refresh, no
    // signal sent back at all, so a blocked sender just sees silence
    // indistinguishable from the recipient being offline.
    const blockedSenderContact = contactsRef.current.find((c) => (c.relayId || c.id) === fromRelayId);
    if (blockedSenderContact?.blocked) {
      return;
    }

    let sessionData = sessionsRef.current.get(fromRelayId);
    if (!sessionData) {
      log.warn(`[Session] No session for ${fromRelayId}, queuing message and attempting session recovery`);

      // Queue this encrypted message for later processing when session is established
      if (!pendingEncryptedRef.current.has(fromRelayId)) {
        pendingEncryptedRef.current.set(fromRelayId, []);
      }
      pendingEncryptedRef.current.get(fromRelayId)!.push({ msg, receivedAt: Date.now() });

      // Try to restore session from stored public key first (no network needed)
      const storedPubKey = loadContactPublicKey(fromRelayId);
      if (storedPubKey && identityRef.current) {
        try {
          const dict = await loadDictionary();
          if (dict && dict.length > 0) {
            const theirPublicKey = fromHex(storedPubKey);
            // Prefer RESUMING persisted ratchet state (#3, #10) so the restored
            // session keeps forward secrecy and its recv counter instead of
            // resetting to 0; fall back to a fresh classical derivation only when
            // nothing was persisted.
            const persisted = loadRatchetState(fromRelayId);
            let session: Session;
            if (persisted) {
              session = Session.fromSerialized(persisted, dict);
            } else {
              const sharedSecret = computeSharedSecret(identityRef.current.privateKey, theirPublicKey);
              const role = deriveSessionRole(identityRef.current.publicKey, theirPublicKey);
              const suiteTranscript = deriveSuiteTranscript(SUITE_CLASSICAL, identityRef.current.publicKey, theirPublicKey);
              session = new Session(sharedSecret, dict, 1, role, { suiteTranscript });
            }
            sessionsRef.current.set(fromRelayId, {
              relayId: fromRelayId,
              session,
              publicKeyHex: storedPubKey,
              // Populate the peer's signing key so signed messages verify instead
              // of being dropped/held on this restore path (#3).
              signingPublicKeyHex: loadContactSigningPublicKey(fromRelayId) ?? undefined,
            });
            log.debug(`[Session] Session restored from stored key for ${fromRelayId}`);

            // Process queued messages now
            const queued = pendingEncryptedRef.current.get(fromRelayId) || [];
            pendingEncryptedRef.current.delete(fromRelayId);
            for (const { msg: queuedMsg } of queued) {
              await new Promise(resolve => setTimeout(resolve, 50));
              handleMessageReceivedRef.current?.(queuedMsg);
            }

            // Also initiate key exchange to refresh the session in case stored key is stale
            initiateKeyExchange(fromRelayId, '');
            return;
          }
        } catch (err) {
          log.warn(`Could not restore session from stored key for ${fromRelayId}:`, err);
        }
      }

      // Initiate key exchange as fallback — queued messages will be processed
      // in handleKeyExchangeReceived when the session is established
      initiateKeyExchange(fromRelayId, '');

      return;
    }

    try {
      const { session } = sessionData;
      const encrypted = fromHex(encryptedMessage);
      // PEEK-decrypt WITHOUT consuming the recv-ratchet key yet (checkReplay=false).
      // Replay protection MUST stay on for real traffic — the relay is untrusted
      // by design (docs/PROTOCOL.md) and can redeliver a captured ciphertext under
      // a fresh messageId, which the messageId dedup won't catch. We still enforce
      // single-use: either we consume the key below once the message is accepted
      // (consumeRecvKey), or a genuine replay of an already-consumed seq throws
      // here. Peeking first is what lets us HOLD an unverifiable signed message
      // (below) and re-process it later without having burned its key.
      const plaintext = await session.decryptAsync(encrypted, false);
      const text = new TextDecoder().decode(plaintext);

      // Parse the envelope early so we can decide whether to HOLD an unverifiable
      // signed message before doing any contact/display/ACK/consume work.
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON — treat as plain text */ }

      // NEVER DROP+ACK AN UNVERIFIABLE SIGNED MESSAGE (#3): a signed envelope
      // whose signing key hasn't arrived yet is a RACE with key exchange, not a
      // failure. Do NOT ack (so the relay keeps redelivering) and do NOT drop —
      // queue it un-ACKed, kick a key exchange to fetch the signing key, and
      // re-process it once the key lands. The peeked recv key stays retained
      // (not consumed) so re-processing can succeed.
      const isSignedEnvelope =
        parsed?.type === 'text' && typeof parsed.sig === 'string' && typeof parsed.sigTs === 'number';
      if (isSignedEnvelope && !sessionData.signingPublicKeyHex) {
        log.warn(`[Security] Signed message from ${fromRelayId} arrived before its signing key; holding un-ACKed pending key exchange`);
        if (!pendingEncryptedRef.current.has(fromRelayId)) {
          pendingEncryptedRef.current.set(fromRelayId, []);
        }
        const heldQueue = pendingEncryptedRef.current.get(fromRelayId)!;
        // Avoid queuing the same messageId twice on relay redelivery.
        if (!heldQueue.some((q) => q.msg?.messageId === messageId)) {
          heldQueue.push({ msg, receivedAt: Date.now() });
        }
        initiateKeyExchange(fromRelayId, '');
        return; // no consume, no ACK
      }

      // Accepted for processing — enforce single-use replay protection NOW, then
      // persist the advanced ratchet state so a restore resumes here (#3, #10).
      session.consumeRecvKey(encrypted);
      saveRatchetState(fromRelayId, session.serialize());

      // Get or create contact using relayId
      let contact = contacts.find((c) => c.relayId === fromRelayId);
      if (!contact) {

        // FIX: Fetch profile FIRST before creating contact
        // This ensures display name is set immediately when contact is created
        let displayName = fromRelayId.slice(0, 11);
        let username: string | undefined;
        let profileDisplayName: string | undefined;
        let profileAvatarEmoji: string | undefined;
        let profileAvatarColor: string | undefined;

        try {
          const profile = await lookupUserProfile(fromRelayId);
          if (profile) {
            profileDisplayName = profile.displayName;
            username = profile.username;
            profileAvatarEmoji = profile.avatarEmoji;
            profileAvatarColor = profile.avatarColor;
            // Only use username if it exists and is not empty
            displayName = profile.displayName || (profile.username && profile.username.trim() ? profile.username : '') || fromRelayId.slice(0, 11);
          }
        } catch (err) {
          log.error('Failed to fetch profile for new contact:', err);
          // Fall back to ID if fetch fails - don't let it block message delivery
        }

        contact = {
          id: fromRelayId,
          relayId: fromRelayId,
          name: displayName,
          displayName: profileDisplayName || displayName,
          username: username && username.trim() ? username : undefined,
          avatarEmoji: profileAvatarEmoji,
          avatarColor: profileAvatarColor,
          avatar: 'bg-blue-600',
          isOnline: false,
          messages: [],
        };
        // Dedup against the freshest state, not the `contacts` closure this
        // callback captured at invocation time. This handler awaits
        // lookupUserProfile() above, so two messages arriving back-to-back
        // from the same brand-new sender can both pass the `!contact` check
        // before either call lands — without this check-inside-setState,
        // both would append, leaving two duplicate contact entries with the
        // same relayId in state.
        setContacts((prev) =>
          prev.some((c) => c.relayId === fromRelayId) ? prev : [...prev, contact as Contact]
        );

        // Persist contact to IndexedDB so it survives page refreshes
        try {
          await upsertContact(fromRelayId, {
            name: displayName,
            displayName: profileDisplayName || displayName,
            publicKeyHex: sessionData.publicKeyHex,
            username: username && username.trim() ? username : undefined,
            addedAt: Date.now(),
          });
        } catch (err) {
          log.warn(`Failed to persist contact ${fromRelayId}:`, err);
        }

        // Save public key for session recovery
        saveContactPublicKey(fromRelayId, sessionData.publicKeyHex);
      }

      // (the envelope was already parsed into `parsed` above, before the
      // hold-unverifiable-signed-message check and the recv-key consume.)

      // Structured text message with optional reply metadata
      if (parsed?.type === 'text') {
        // Long outgoing text is split by send.ts into ordered segments (the
        // relay hard-caps a single encrypted blob at 64KB — see send.ts's
        // sendMessage for the full rationale). Each segment is its own
        // independent relay frame/messageId/ratchet-step; buffer them here
        // by the shared group id (parsed.seg.id) until all `total` have
        // arrived, then fall through to the normal single-message path
        // below using the reassembled text. The signature was computed
        // ONCE over the full original text on the sender side and repeated
        // identically on every segment, so it can only be verified after
        // reassembly — not per-segment.
        if (parsed.seg && typeof parsed.seg.id === 'string' && typeof parsed.seg.index === 'number' && typeof parsed.seg.total === 'number') {
          const bufKey = `${fromRelayId}:${parsed.seg.id}`;
          let buf = segmentBuffers.get(bufKey);
          if (!buf || buf.total !== parsed.seg.total) {
            buf = { chunks: new Array(parsed.seg.total).fill(undefined), total: parsed.seg.total, receivedAt: Date.now() };
            segmentBuffers.set(bufKey, buf);
          }
          if (parsed.seg.index >= 0 && parsed.seg.index < buf.total) {
            buf.chunks[parsed.seg.index] = parsed.text ?? '';
          }
          buf.receivedAt = Date.now();
          if (parsed.replyTo !== undefined) buf.replyTo = parsed.replyTo;
          if (typeof parsed.sig === 'string') buf.sig = parsed.sig;
          if (typeof parsed.sigTs === 'number') buf.sigTs = parsed.sigTs;
          if (typeof parsed.expiresAt === 'number') buf.expiresAt = parsed.expiresAt;

          const segAckWs = wsRef.current;
          if (segAckWs) segAckWs.sendAck(messageId);

          if (buf.chunks.some((c: string | undefined) => c === undefined)) {
            return; // still waiting on the rest of this message's segments
          }
          segmentBuffers.delete(bufKey);
          parsed = {
            ...parsed,
            text: buf.chunks.join(''),
            replyTo: buf.replyTo,
            sig: buf.sig,
            sigTs: buf.sigTs,
            expiresAt: buf.expiresAt,
          };
        }

        // The logical message id: the shared segment-group id when this was
        // reassembled from segments (matches what the sender signed and what
        // the optimistic sender-side UI message is keyed by), otherwise this
        // frame's own relay-assigned messageId as before.
        const logicalMessageId: string = parsed.seg?.id ?? messageId;

        // Verify the sender's signature if present. A missing signature is
        // treated as an unsigned/legacy message, not a failure — this is a
        // rollout, not every message in flight will have one. A PRESENT but
        // invalid signature means the content doesn't match what the
        // claimed sender's identity key actually signed — this is a hard
        // failure: drop the message rather than merely warn, since a
        // dismissible toast next to an otherwise-normal-looking message
        // that still gets displayed/persisted/ACKed is not a real control.
        if (typeof parsed.sig === 'string' && typeof parsed.sigTs === 'number') {
          try {
            // Must verify against the peer's derived Ed25519 SIGNING key
            // (signingPublicKeyHex), not their X25519 identity key
            // (publicKeyHex) — the two curves produce different public
            // values from the same seed, so verifying against the X25519
            // key here would make every signed message fail unconditionally
            // (see message-signing.ts's deriveSigningKeypair doc comment).
            if (!sessionData.signingPublicKeyHex) {
              throw new Error('No signing key on file for this session — cannot verify');
            }
            verifyMessageSignature(
              { messageId: logicalMessageId, content: parsed.text ?? '', signature: parsed.sig, timestamp: parsed.sigTs, senderRelayId: fromRelayId },
              fromHex(sessionData.signingPublicKeyHex)
            );
          } catch (err) {
            log.warn(`[Security] Message signature verification failed for ${fromRelayId}, dropping message:`, err);
            toast.error(
              'Message rejected',
              `A message from ${resolveDisplayName(fromRelayId, contacts)} failed signature verification and was dropped.`
            );
            const ws = wsRef.current;
            if (ws) ws.sendAck(messageId);
            return;
          }
        }

        // Peer-supplied text is rendered as-is by MessageBubble — strip bidi-
        // override control characters and cap Zalgo-style stacked combining
        // marks here, at the boundary where it enters the client's trusted
        // data model, rather than trusting every future render site to do it.
        const msgText: string = stripSuspiciousTextControlChars(parsed.text ?? '');
        const replyToData = parsed.replyTo ?? undefined;
        const compressedSize = encrypted.length - 43;
        const compressionRatio = compressedSize > 0 ? compressedSize / plaintext.length : 0.5;
        const replyMsg: MessageWithStatus = {
          id: messageId,
          senderId: fromRelayId,
          senderName: resolveDisplayName(fromRelayId, contacts),
          text: msgText,
          replyTo: replyToData,
          timestamp: new Date(),
          isOwn: false,
          read: false,
          delivered: true,
          status: 'delivered',
          reactions: [],
          publicKeyHex: sessionData.publicKeyHex,
          encryptedBlob: toHex(encrypted),
          metadata: {
            compression_ratio: compressionRatio,
            original_size: plaintext.length,
            compressed_size: compressedSize,
            encrypted_size: encrypted.length,
            latency_ms: 0,
            neural_model_score: 0.9,
          },
        };
        let isDuplicateMessage = false;
        setMessages((prev) => {
          const updated = new Map(prev);
          const msgs = updated.get(fromRelayId) || [];
          if (msgs.some((m) => m.id === messageId)) {
            isDuplicateMessage = true;
            return prev;
          }
          updated.set(fromRelayId, [...msgs, replyMsg]);
          return updated;
        });
        // Honor the SENDER's transmitted ghost intent when present — falling
        // back to this recipient's own local ghost setting means a message
        // the sender meant to self-destruct persists forever on a recipient
        // who hasn't independently turned on ghost mode for this thread.
        //
        // But a sender-supplied expiresAt is attacker-controlled data, not a
        // trusted timestamp — nothing previously bounded how far in the
        // future it could be, so a malicious/compromised peer could set it
        // years out and silently defeat the *receiver's own* shorter
        // ghost-mode setting for this thread (the more security-relevant
        // direction for a self-destruct feature). If the receiver has an
        // active local ghost setting, the stricter (sooner) of the two wins;
        // only fall through to the sender's value alone when the receiver
        // has no ghost setting of their own for this thread.
        const senderExpiresAt =
          typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) && parsed.expiresAt > Date.now()
            ? parsed.expiresAt
            : undefined;
        const localExpiresAt = computeExpiresAt(fromRelayId);
        const recvExpiresAt =
          senderExpiresAt !== undefined && localExpiresAt !== undefined
            ? Math.min(senderExpiresAt, localExpiresAt)
            : senderExpiresAt ?? localExpiresAt;
        // Gated on the dedup outcome above — messageId is relay-supplied,
        // untrusted metadata (never bound inside the AEAD-authenticated
        // plaintext), and persistMessage/addMessage is an unconditional
        // upsert-by-id. Without this gate, a relay redelivering an old
        // envelope under a reused id would silently overwrite that
        // message's prior stored content/status in IndexedDB even though
        // the live view correctly ignored it as a duplicate.
        if (!isEphemeralContact(fromRelayId) && !isDuplicateMessage) {
          persistMessage({
            id: messageId,
            conversationId: fromRelayId,
            senderId: fromRelayId,
            text: msgText,
            status: 'received',
            timestamp: replyMsg.timestamp.getTime(),
            expiresAt: recvExpiresAt,
            ghost: recvExpiresAt !== undefined,
          }).catch(err => log.error('Failed to persist received message:', err));
        }
        const ws = wsRef.current;
        if (ws) ws.sendAck(messageId);
        updateSessionStats(fromRelayId);
        return;
      }

      if (parsed?.type === 'reaction') {
        // Scoped to the sender's own conversation — without knownContactId,
        // applyReactionToState falls back to searching every conversation
        // for a matching messageId, letting a contact react to (or, via
        // reaction_revoke below, strip a reaction from) a message rendered
        // in a completely different conversation than the one this envelope
        // arrived on, if they ever learn/guess that message's id.
        applyReactionToState(parsed.messageId, parsed.emoji, fromRelayId, false, fromRelayId);
        const ws = wsRef.current;
        if (ws) ws.sendAck(messageId);
        return;
      }

      if (parsed?.type === 'reaction_revoke') {
        applyReactionToState(parsed.messageId, parsed.emoji, fromRelayId, true, fromRelayId);
        const ws = wsRef.current;
        if (ws) ws.sendAck(messageId);
        return;
      }

      if (parsed?.type === 'message_edit') {
        const { messageId: targetMsgId } = parsed;
        const newText = stripSuspiciousTextControlChars(parsed.text ?? '');
        setMessages((prev) => {
          // Only look in the conversation with the sender of THIS envelope,
          // and only apply if they're the message's original author —
          // without both checks, any contact who learns/guesses a message
          // id (ids are otherwise-unrelated UUIDs, but a screenshot, a
          // group-chat reuse, or a future replay could leak one) could
          // rewrite that message's text as displayed on the victim's
          // client, including messages the victim sent themselves in an
          // entirely different conversation. Mirrors the actor/sender check
          // already applied to group_event (use-group-messaging.ts).
          const msgs = prev.get(fromRelayId);
          if (!msgs) return prev;
          const msgIdx = msgs.findIndex((m) => m.id === targetMsgId);
          if (msgIdx < 0 || msgs[msgIdx].senderId !== fromRelayId) return prev;

          const updated = new Map(prev);
          const newMsgs = [...msgs];
          const message = { ...newMsgs[msgIdx] };
          message.text = newText;
          message.isEdited = true;
          message.editedAt = new Date();
          message.editCount = (message.editCount || 0) + 1;
          newMsgs[msgIdx] = message;
          updated.set(fromRelayId, newMsgs);
          return updated;
        });
        const ws = wsRef.current;
        if (ws) ws.sendAck(messageId);
        return;
      }

      if (parsed?.type === 'file') {
        const { mimeType, size, data: rawDataUrl } = parsed;
        // A peer could send a javascript:/vbscript: URI instead of real file
        // data — those get rendered into href/src attributes below, so drop
        // anything that isn't a genuine data: URI before it reaches the UI.
        const dataUrl = isSafeDataUrl(rawDataUrl) ? rawDataUrl : undefined;
        // A peer-supplied filename is rendered as-is (message preview, the
        // file-share card, the download attribute) — strip bidi-override
        // control characters so a filename can't visually spoof its own
        // extension (classic RTLO attack: a name that LOOKS like
        // "photo.jpg" but is actually "photo.exe" reversed).
        const filename = stripSuspiciousTextControlChars(parsed.filename ?? '');
        const fileMsg: MessageWithStatus = {
          id: messageId,
          senderId: fromRelayId,
          senderName: resolveDisplayName(fromRelayId, contacts),
          text: `📎 ${filename}`,
          timestamp: new Date(),
          isOwn: false,
          read: false,
          delivered: true,
          status: 'delivered',
          reactions: [],
          publicKeyHex: sessionData.publicKeyHex,
          encryptedBlob: toHex(encrypted),
          fileShare: {
            filename: filename || 'file',
            original_size: size || 0,
            compressed_size: Math.max(0, encrypted.length - 43 - 16),
            compression_ratio: size > 0 ? Math.max(0, (encrypted.length - 43 - 16)) / size : 0,
            type: mimeType || 'application/octet-stream',
            dataUrl,
          },
          metadata: {
            compression_ratio: size > 0 ? Math.max(0, (encrypted.length - 43 - 16)) / size : 0,
            original_size: size || 0,
            compressed_size: Math.max(0, encrypted.length - 43 - 16),
            encrypted_size: encrypted.length,
            latency_ms: 0,
            neural_model_score: 0.9,
          },
        };
        setMessages((prev) => {
          const updated = new Map(prev);
          const msgs = updated.get(fromRelayId) || [];
          // Dedup: skip if already present
          if (msgs.some((m) => m.id === messageId)) return prev;
          updated.set(fromRelayId, [...msgs, fileMsg]);
          return updated;
        });
        const ws = wsRef.current;
        if (ws) ws.sendAck(messageId);
        return;
      }

      if ((parsed?.type === 'group_message' || parsed?.type === 'group_file' || parsed?.type === 'group_event') && parsed?.groupId) {
        handleGroupMessage(parsed, fromRelayId, messageId, encrypted);
        const ws = wsRef.current;
        if (ws) ws.sendAck(messageId);
        return;
      }

      // Calculate actual compression ratio
      const compressedSize = encrypted.length - 43; // Subtract encryption overhead
      const compressionRatio = compressedSize > 0 ? compressedSize / plaintext.length : 0.5;

      // Create message with resolved display name
      const newMsg: MessageWithStatus = {
        id: messageId,
        senderId: fromRelayId,
        senderName: resolveDisplayName(fromRelayId, contacts),
        text,
        timestamp: new Date(),
        isOwn: false,
        read: false,
        delivered: true,
        status: 'delivered',
        reactions: [],
        publicKeyHex: sessionData.publicKeyHex,
        encryptedBlob: toHex(encrypted),
        metadata: {
          compression_ratio: compressionRatio,
          original_size: plaintext.length,
          compressed_size: compressedSize,
          encrypted_size: encrypted.length,
          latency_ms: 0,
          neural_model_score: 0.9,
        },
      };

      let isDuplicateLegacyMessage = false;
      setMessages((prev) => {
        const updated = new Map(prev);
        const contactMsgs = updated.get(fromRelayId) || [];
        // Dedup: skip if message with this ID already exists (relay can re-deliver queued messages)
        if (contactMsgs.some((m) => m.id === messageId)) {
          isDuplicateLegacyMessage = true;
          return prev;
        }
        updated.set(fromRelayId, [...contactMsgs, newMsg]);
        return updated;
      });

      // PERSIST MESSAGE IMMEDIATELY TO STORAGE (skipped for ghost contacts)
      const recvExpiresAt = computeExpiresAt(fromRelayId);
      if (recvExpiresAt !== undefined) {
        newMsg.ghost = true;
        newMsg.expiresAt = recvExpiresAt;
      }
      // Gated on the dedup outcome above (see the 'text' branch for why:
      // messageId is relay-supplied and persistMessage is an unconditional
      // upsert-by-id — an unconditional call here lets a redelivered
      // envelope under a reused id overwrite prior stored message content).
      if (!isEphemeralContact(fromRelayId) && !isDuplicateLegacyMessage) {
        persistMessage({
          id: messageId,
          conversationId: fromRelayId, // Use relayId as conversation ID
          senderId: fromRelayId,
          text,
          status: 'received',
          timestamp: newMsg.timestamp.getTime(),
          expiresAt: recvExpiresAt,
          ghost: recvExpiresAt !== undefined,
        }).catch(err => log.error('Failed to persist received message:', err));
      }

      // Send ACK
      const ws = wsRef.current;
      if (ws) {
        ws.sendAck(messageId);
      }

      // Update stats
      updateSessionStats(fromRelayId);

      // Settings' "Sound"/"Vibration" toggles — fire regardless of window
      // focus (the "did I just get a message" cue, distinct from the
      // desktop notification below, which is deliberately focus-gated).
      // Reveal no sender metadata, so no ephemeral-contact exception needed.
      playMessageBeep();
      if (getBoolSetting('vibration', true)) vibrate();

      // Native notification when window is hidden or blurred (desktop + web).
      // Skipped for ephemeral/ghost contacts — the OS notification center is
      // outside the app's control and outside any in-app wipe, so surfacing
      // a ghost contact's display name there would defeat the entire point
      // of marking them ephemeral (never leaves a trace). Also respects
      // Settings' "Push notifications" toggle — previously this fired
      // unconditionally regardless of that setting.
      const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (isHidden && !isEphemeralContact(fromRelayId) && getBoolSetting('notifications', false)) {
        const senderName = resolveDisplayName(fromRelayId, contacts);
        sendNotification('Relay', `New message from ${senderName}`);
      }

    } catch (err) {
      log.error('Decryption failed:', err);
      // A repeated decrypt failure from the same sender (not a one-off —
      // see resync.ts's own threshold/debounce) may be a genuine ratchet
      // desync rather than tampering; this records the failure and, once
      // its own criteria are met, sends a signed resync_request so the two
      // sides can safely re-key instead of being stuck on this forever.
      initiateResync(fromRelayId);
      // Show error message but don't crash — dedup to avoid duplicates on re-delivery
      const errorDisplayName = resolveDisplayName(fromRelayId, contacts);
      const storedPublicKey = loadContactPublicKey(fromRelayId);
      setMessages((prev) => {
        const updated = new Map(prev);
        const contactMsgs = updated.get(fromRelayId) || [];
        if (contactMsgs.some((m) => m.id === messageId)) {
          return prev;
        }
        updated.set(fromRelayId, [
          ...contactMsgs,
          {
            id: messageId,
            senderId: fromRelayId,
            senderName: errorDisplayName,
            text: '⚠ Message could not be verified',
            timestamp: new Date(),
            isOwn: false,
            read: true,
            delivered: true,
            status: 'error',
            errorMessage: 'Decryption failed',
            publicKeyHex: storedPublicKey,
            metadata: {
              compression_ratio: 0,
              original_size: 0,
              compressed_size: 0,
              encrypted_size: 0,
              latency_ms: 0,
              neural_model_score: 0,
            },
          } as MessageWithStatus,
        ]);
        return updated;
      });
    }
  }, [contacts, shared, initiateKeyExchange, loadDictionary, updateSessionStats, applyReactionToState, handleGroupMessage, initiateResync, setContacts, setMessages]);

  // Keep the ref in sync with the latest handler so the WebSocket listener
  // always calls the current version (fixes stale closure after contacts load)
  useEffect(() => {
    handleMessageReceivedRef.current = handleMessageReceived;
  }, [handleMessageReceived, handleMessageReceivedRef]);

  const updateMessageStatus = useCallback(
    (msgId: string, status: 'delivered' | 'pending' | 'read' | 'error', expiresAt?: number, errorMessage?: string) => {
      // Clear message timeout since we got confirmation from relay
      if (sentMessagesRef.current.has(msgId + '_timeout')) {
        const timeout = sentMessagesRef.current.get(msgId + '_timeout');
        if (timeout) {
          clearTimeout(timeout as NodeJS.Timeout);
          sentMessagesRef.current.delete(msgId + '_timeout');
        }
      }

      setMessages((prev) => {
        const updated = new Map(prev);
        for (const [contactId, msgs] of updated) {
          const msgIdx = msgs.findIndex((m) => m.id === msgId);
          if (msgIdx >= 0) {
            const newMsgs = [...msgs];
            newMsgs[msgIdx] = {
              ...newMsgs[msgIdx],
              status,
              ...(expiresAt ? { expiresAt } : {}),
              ...(errorMessage ? { errorMessage } : {}),
            };
            updated.set(contactId, newMsgs);
            break;
          }
        }
        return updated;
      });
    },
    [setMessages, sentMessagesRef]
  );

  return { handleMessageReceived, updateMessageStatus };
}
