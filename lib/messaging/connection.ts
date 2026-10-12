/**
 * WebSocket connection lifecycle — opens the connection, registers every
 * event handler (message dispatch, key exchange, calls, typing, burn,
 * presence, etc.), and connects. This is the thing that wires together
 * every other messaging sub-hook via the WS event handlers, so it's
 * extracted last, once everything it depends on already has a stable home.
 *
 * handleMessageReceivedRef.current is called (not the direct handler) for
 * incoming 'message' events — same stale-closure-avoidance reasoning as
 * receive.ts: the ref always points at the latest handler with fresh
 * `contacts` state, whereas a captured closure here would not.
 */

import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { useRouter } from 'next/navigation';
import { toast } from '@/components/ToastNotification';
import { log } from '@/lib/platform/logger';
import { RelayWebSocketClient } from '@/lib/relay/relay-websocket';
import { computeSharedSecret, deriveSessionRole, deriveSuiteTranscript, SUITE_CLASSICAL, Session } from '@/lib/crypto/relay-crypto';
import { fromHex, toHex } from '@/lib/crypto/hex-utils';
import { signMessage, deriveSigningKeypair } from '@/lib/crypto/message-signing';
import { isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';
import { persistMessage } from '@/lib/messaging/message-persistence';
import { computeExpiresAt } from '@/lib/messaging/ghost-mode';
import {
  loadAllContactPublicKeys,
  loadRatchetState,
  loadContactSigningPublicKey,
  loadContactPqPublicKey,
  saveRatchetState,
} from '@/lib/messaging/contact-key-cache';
import type { SharedMessagingRefs, SharedMessagingState, CallSignalEvent } from '@/lib/hooks/messaging-types';

interface UseConnectionParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  router: ReturnType<typeof useRouter>;
  loadIdentity: () => Promise<{ pubKeyHex: string } | null>;
  loadDictionary: () => Promise<Uint8Array>;
  initiateKeyExchange: (contactRelayId: string, publicKeyHex: string) => void;
  handleKeyExchangeReceived: (msg: any) => void;
  updateMessageStatus: (msgId: string, status: 'delivered' | 'pending' | 'read' | 'error', expiresAt?: number, errorMessage?: string) => void;
  handleBurnRequest: (msg: any) => void;
  handleBurnConfirm: (msg: any) => void;
  handleResyncRequest: (msg: any) => void;
  handleResyncResponse: (msg: any) => void;
  handleTypingIndicator: (msg: any) => void;
  handleCallSignal: (msg: any, type: CallSignalEvent['type']) => void;
  setConnectionStatus: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void;
  setError: (error: string | null) => void;
}

export function useConnection({
  shared,
  state,
  router,
  loadIdentity,
  loadDictionary,
  initiateKeyExchange,
  handleKeyExchangeReceived,
  updateMessageStatus,
  handleBurnRequest,
  handleBurnConfirm,
  handleResyncRequest,
  handleResyncResponse,
  handleTypingIndicator,
  handleCallSignal,
  setConnectionStatus,
  setError,
}: UseConnectionParams) {
  const {
    wsRef, dictRef, identityRef, sessionsRef, contactsRef,
    pendingMessagesRef, reconnectQueueRef, keyExchangeInitiatedRef,
    handleMessageReceivedRef,
  } = shared;
  const { setContacts, setMessages } = state;

  // The relay sends this when a queued message will never be delivered —
  // TTL expiry, a per-recipient/global queue cap eviction, or the
  // delivery-attempt cap on a flapping recipient (server/relay-node.ts's
  // notifyPurged). Without this, the sender's UI was left showing
  // "Sending…"/"pending" forever for a message the relay had already
  // silently dropped, with no way to tell the send actually failed.
  const handlePurgeNotice = useCallback((msg: any) => {
    if (!msg.messageId) return;
    updateMessageStatus(msg.messageId, 'error', undefined, 'Message expired before it could be delivered');
  }, [updateMessageStatus]);

  const initializeWebSocket = useCallback(async () => {
    // Only initialize once
    if (wsRef.current) {
      return;
    }

    const identity = await loadIdentity();
    if (!identity) return;

    const bakedEnvUrl = process.env.NEXT_PUBLIC_RELAY_URL || 'ws://localhost:3000';
    // In the browser, prefer the relay URL injected at REQUEST time by the
    // server (app/layout.tsx sets <html data-relay-url="..."> from the
    // runtime env, since the root layout is a Server Component). This lets a
    // single prebuilt image be deployed to any host whose runtime env sets
    // NEXT_PUBLIC_RELAY_URL — changing the public URL no longer requires a
    // rebuild, and prebuilt (clone-free) images work unchanged. For
    // self-built dev images the baked value is used as the fallback.
    const envUrl =
      typeof document !== 'undefined' &&
      document.documentElement &&
      document.documentElement.dataset &&
      document.documentElement.dataset.relayUrl
        ? document.documentElement.dataset.relayUrl
        : bakedEnvUrl;
    const relayUrl = (() => {
      // When running in the browser, always connect WebSocket back to the SAME
      // origin as the page (same host, same port, matching protocol).
      // server.js proxies every WS/WSS upgrade on port 3000 → relay on 8080,
      // so the WebSocket URL is always identical to the page's own origin.
      //
      // Exception: if NEXT_PUBLIC_RELAY_URL points to a DIFFERENT host entirely
      // (e.g. a separate relay server in production), use that URL directly.
      if (typeof window !== 'undefined') {
        try {
          const parsed = new URL(envUrl);
          const isLocalhost =
            parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
          // If configured for localhost (dev mode), always use the page's own origin
          // so that SSH-tunnelled / port-forwarded / remote access works automatically.
          if (isLocalhost) {
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            return `${proto}//${window.location.host}`;
          }
        } catch {
          // malformed URL — fall through to envUrl
        }
      }
      return envUrl;
    })();

    try {
      setConnectionStatus('connecting');

      const ws = new RelayWebSocketClient(relayUrl);
      wsRef.current = ws;

      // Best-effort: snapshot every live session's ratchet state when the page
      // is hidden/unloaded so a refresh RESUMES from the CURRENT send + recv
      // counters rather than a stale snapshot (#3, #10). The recv side is also
      // persisted per-received-message (receive.ts); this closes the gap for
      // messages SENT since the last receive (send.ts can't persist directly).
      // visibilitychange fires before unload, leaving time for the async write.
      if (typeof document !== 'undefined') {
        const persistAllSessions = () => {
          for (const [cId, data] of sessionsRef.current) {
            try {
              saveRatchetState(cId, data.session.serialize());
            } catch { /* best effort — never block unload */ }
          }
        };
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') persistAllSessions();
        });
        window.addEventListener('pagehide', persistAllSessions);
      }

      // Register event handlers
      ws.on('connected', async () => {
        setConnectionStatus('connected');

        // Drain the reconnect queue. A contact that ALREADY has a live session
        // (e.g. resumed from persisted ratchet state, or never lost one) never
        // goes through another key exchange on this reconnect — the
        // `needsExchange` filter below skips anyone already in sessionsRef —
        // so simply pushing these into pendingMessagesRef would strand them
        // there: nothing but a completed key exchange ever drains that queue,
        // and the 5-minute stale-queue GC in use-relay-messaging.ts would
        // eventually delete the entry with no error and no retry (#4b, silent
        // queue loss). Send those directly, right now, the same way a live
        // sendMessage() call would. Only fall back to pendingMessagesRef —
        // drained once the upcoming key exchange completes — for contacts
        // that still need a fresh handshake.
        const queued = reconnectQueueRef.current.splice(0);
        for (const { contactRelayId, text, msgId, replyTo } of queued) {
          const existingSession = sessionsRef.current.get(contactRelayId);
          if (existingSession?.session && identityRef.current) {
            try {
              const signingKeypair = deriveSigningKeypair(identityRef.current.privateKey);
              const signed = await signMessage(msgId, text, identityRef.current.relayId, signingKeypair.privateKey);
              const expiresAtForMsg = computeExpiresAt(contactRelayId);
              const wirePayload = JSON.stringify({
                type: 'text',
                text,
                ...(replyTo ? { replyTo } : {}),
                ...(expiresAtForMsg !== undefined ? { expiresAt: expiresAtForMsg } : {}),
                sig: signed.signature,
                sigTs: signed.timestamp,
              });
              const plaintext = new TextEncoder().encode(wirePayload);
              const encrypted = await existingSession.session.encryptAsync(plaintext);
              saveRatchetState(contactRelayId, existingSession.session.serialize());
              const blob = toHex(encrypted);
              ws.sendMessage(contactRelayId, blob, msgId);
              setMessages((prev) => {
                const updated = new Map(prev);
                const msgs = updated.get(contactRelayId) || [];
                updated.set(
                  contactRelayId,
                  msgs.map((m) => (m.id === msgId ? { ...m, status: 'sending' as const, encryptedBlob: blob } : m))
                );
                return updated;
              });
              if (!isEphemeralContact(contactRelayId)) {
                persistMessage({
                  id: msgId,
                  conversationId: contactRelayId,
                  senderId: identityRef.current.relayId,
                  text,
                  status: 'sending',
                  timestamp: Date.now(),
                  expiresAt: expiresAtForMsg,
                  ghost: expiresAtForMsg !== undefined,
                }).catch((err) => log.error('Failed to persist reconnect-queued message:', err));
              }
            } catch (err) {
              log.error(`Failed to send reconnect-queued message to ${contactRelayId}:`, err);
              // Fall back to the pending-message queue so a later key exchange
              // (or the next reconnect) can retry rather than losing it outright.
              const existing = pendingMessagesRef.current.get(contactRelayId) || [];
              existing.push({ relayId: contactRelayId, text, messageId: msgId, _queuedAt: Date.now() });
              pendingMessagesRef.current.set(contactRelayId, existing);
            }
            continue;
          }

          const wirePayload = replyTo ? JSON.stringify({ type: 'text', text, replyTo }) : text;
          const existing = pendingMessagesRef.current.get(contactRelayId) || [];
          existing.push({ relayId: contactRelayId, text: wirePayload, messageId: msgId, _queuedAt: Date.now() });
          pendingMessagesRef.current.set(contactRelayId, existing);
        }

        // Restore sessions from stored public keys FIRST (instant, no network needed).
        // This ensures we can decrypt pending messages the relay delivers immediately.
        if (identityRef.current) {
          const storedKeys = loadAllContactPublicKeys();
          const dict = dictRef.current || await loadDictionary().catch(() => null);

          if (dict && dict.length > 0) {
            for (const contact of contactsRef.current) {
              const cId = contact.relayId;
              if (!cId || cId === identityRef.current?.relayId) continue;

              const storedPubKey = storedKeys[cId];
              if (storedPubKey && !sessionsRef.current.has(cId)) {
                try {
                  const theirPublicKey = fromHex(storedPubKey);
                  // Prefer RESUMING persisted ratchet state (#3, #10): restores the
                  // exact chain keys + counters, keeping forward secrecy and never
                  // rolling the recv counter back to 0. Only with no persisted state
                  // do we fall back to deriving a fresh classical session from the
                  // static identity keys — the legacy behavior, and the reason a
                  // restored session used to reset to 0 and shed forward secrecy.
                  const persisted = loadRatchetState(cId);
                  let session: Session;
                  if (persisted) {
                    session = Session.fromSerialized(persisted, dict);
                  } else if (loadContactPqPublicKey(cId) && identityRef.current.pqPublicKey) {
                    // We know this peer is PQ-capable (their PQ public key is
                    // cached — e.g. key-exchange.ts's refuseAndReinitiateHybrid
                    // stored it before the hybrid handshake finished) but have no
                    // persisted ratchet yet. Deriving a classical-only session
                    // here would silently downgrade the channel (#8) AND —
                    // because a session in sessionsRef is excluded from
                    // `needsExchange` below — permanently skip the hybrid
                    // re-drive that's already in flight, pinning the contact to
                    // classical forever. Skip the fallback session entirely so
                    // this contact falls into `needsExchange` and gets a proper
                    // (potentially hybrid) initiateKeyExchange call instead.
                    continue;
                  } else {
                    const sharedSecret = computeSharedSecret(identityRef.current.privateKey, theirPublicKey);
                    const role = deriveSessionRole(identityRef.current.publicKey, theirPublicKey);
                    const suiteTranscript = deriveSuiteTranscript(SUITE_CLASSICAL, identityRef.current.publicKey, theirPublicKey);
                    session = new Session(sharedSecret, dict, 1, role, { suiteTranscript });
                  }
                  sessionsRef.current.set(cId, {
                    relayId: cId,
                    session,
                    publicKeyHex: storedPubKey,
                    // Populate the peer's signing key so a restored session can verify
                    // signed messages immediately instead of dropping them (#3).
                    signingPublicKeyHex: loadContactSigningPublicKey(cId) ?? undefined,
                  });
                } catch (err) {
                  log.warn(`Could not restore session for ${cId}:`, err);
                }
              }
            }
          }
        }

        // Retry anything left in pendingMessagesRef for a contact that ALREADY
        // has a live session at this point (just restored above, or already
        // in memory before this reconnect ran) — without this, those entries
        // could never drain: the `needsExchange` filter below skips any
        // contact already in sessionsRef, so no future key exchange will ever
        // run to trigger key-exchange.ts's own pending-queue drain for them.
        // That's exactly how a message could get permanently stranded (not
        // just delayed) — e.g. the fast-resend path above failing mid-encrypt
        // for a contact whose session already existed. Only the 5-minute
        // stale-entry GC in use-relay-messaging.ts would eventually notice,
        // and only because _queuedAt is now actually set at every push site.
        if (identityRef.current) {
          for (const [pendingRelayId, queue] of Array.from(pendingMessagesRef.current.entries())) {
            const sessionData = sessionsRef.current.get(pendingRelayId);
            if (!sessionData?.session || queue.length === 0) continue;
            const remaining: typeof queue = [];
            for (const { text, messageId } of queue) {
              const msgId = messageId || uuidv4();
              try {
                const signingKeypair = deriveSigningKeypair(identityRef.current.privateKey);
                const signed = await signMessage(msgId, text, identityRef.current.relayId, signingKeypair.privateKey);
                const expiresAtForMsg = computeExpiresAt(pendingRelayId);
                const wirePayload = JSON.stringify({
                  type: 'text',
                  text,
                  ...(expiresAtForMsg !== undefined ? { expiresAt: expiresAtForMsg } : {}),
                  sig: signed.signature,
                  sigTs: signed.timestamp,
                });
                const plaintext = new TextEncoder().encode(wirePayload);
                const encrypted = await sessionData.session.encryptAsync(plaintext);
                saveRatchetState(pendingRelayId, sessionData.session.serialize());
                const blob = toHex(encrypted);
                ws.sendMessage(pendingRelayId, blob, msgId);
                if (!isEphemeralContact(pendingRelayId)) {
                  persistMessage({
                    id: msgId,
                    conversationId: pendingRelayId,
                    senderId: identityRef.current.relayId,
                    text,
                    status: 'sending',
                    timestamp: Date.now(),
                    expiresAt: expiresAtForMsg,
                    ghost: expiresAtForMsg !== undefined,
                  }).catch((err) => log.error('Failed to persist reconnect-drained pending message:', err));
                }
              } catch (err) {
                log.error(`Failed to drain pending message to ${pendingRelayId} on reconnect:`, err);
                remaining.push({ relayId: pendingRelayId, text, messageId, _queuedAt: Date.now() });
              }
            }
            if (remaining.length > 0) pendingMessagesRef.current.set(pendingRelayId, remaining);
            else pendingMessagesRef.current.delete(pendingRelayId);
          }
        }

        // Initiate key exchanges only with contacts that don't have a valid session.
        // Staggered so a large contact list doesn't fire a synchronous burst of
        // PQ (ML-KEM768) encapsulations all at once on every reconnect.
        const needsExchange = contactsRef.current
          .map((contact) => contact.relayId)
          .filter(
            (relayId): relayId is string =>
              !!relayId &&
              relayId !== identityRef.current?.relayId &&
              !sessionsRef.current.has(relayId)
          );
        needsExchange.forEach((relayId, i) => {
          setTimeout(() => {
            keyExchangeInitiatedRef.current.delete(relayId);
            initiateKeyExchange(relayId, '');
          }, i * 75);
        });
      });

      ws.on('disconnected', () => {
        setConnectionStatus('disconnected');
      });

      ws.on('reconnecting', () => {
        setConnectionStatus('disconnected');
      });

      ws.on('error', (err) => {
        log.error('[WS] WebSocket error:', err);
        setConnectionStatus('error');
        setError(err?.message || 'Connection error');
      });

      ws.on('auth_required', () => {
        log.warn('[WS] Session expired — redirecting to login');
        router.push('/auth/login');
      });

      ws.on('key_exchange', (msg) => {
        handleKeyExchangeReceived(msg);
      });

      // Handle key_exchange_hint: someone tried to message us but we have no session.
      // Initiate a fresh key exchange with them so the session can be established.
      ws.on('key_exchange_hint', (msg) => {
        const { fromRelayId } = msg;
        if (!fromRelayId || !identityRef.current) return;
        // Don't reach back out to someone we've blocked — see lib/features/block.ts.
        if (contactsRef.current.find((c) => (c.relayId || c.id) === fromRelayId)?.blocked) return;
        log.debug(`[KeyExchange] Received key exchange hint from ${fromRelayId}, initiating fresh exchange`);
        initiateKeyExchange(fromRelayId, '');
      });

      ws.on('hello_ack', (msg) => {
        // Hello acknowledged
      });

      ws.on('message', (msg) => {
        // Use the ref so we always call the latest version (avoids stale closure)
        handleMessageReceivedRef.current?.(msg);
      });

      ws.on('delivered', (msg) => {
        updateMessageStatus(msg.messageId, 'delivered');
      });

      ws.on('pending', (msg) => {
        updateMessageStatus(msg.messageId, 'pending', msg.expiresAt);
      });

      ws.on('purge_notice', (msg) => {
        handlePurgeNotice(msg);
      });

      // Feature handlers
      ws.on('burn_request', (msg) => {
        handleBurnRequest(msg);
      });

      ws.on('burn_confirm', (msg) => {
        handleBurnConfirm(msg);
      });

      ws.on('resync_request', (msg) => {
        handleResyncRequest(msg);
      });

      ws.on('resync_response', (msg) => {
        handleResyncResponse(msg);
      });

      ws.on('delete_message', (msg) => {
        const senderId = msg.fromRelayId || msg.from;
        const { messageId } = msg;
        if (!senderId || !messageId) return;
        if (contactsRef.current.find((c) => (c.relayId || c.id) === senderId)?.blocked) return;
        // Server verifies senderId (can't be spoofed — see W3 fix), but the
        // thread itself holds both directions of the conversation. Only let
        // a contact delete messages THEY authored (isOwn === false from our
        // side) — otherwise they could delete messages we sent them.
        let authorized = false;
        setMessages((prev) => {
          const updated = new Map(prev);
          const msgs = updated.get(senderId);
          if (msgs) {
            const target = msgs.find((m) => m.id === messageId);
            if (target && !target.isOwn) {
              authorized = true;
              updated.set(senderId, msgs.filter((m) => m.id !== messageId));
            }
          }
          return authorized ? updated : prev;
        });
        if (!authorized) return;
        // Remove from IDB as well
        import('@/lib/db/relay-store').then(({ deleteMessage }) => {
          deleteMessage(messageId).catch(() => {});
        });
      });

      ws.on('typing', (msg) => {
        handleTypingIndicator(msg);
      });

      ws.on('presence', (msg) => {
        // msg: { relayId, online }
        const { relayId: peerId, online } = msg;
        if (!peerId) return;
        if (contactsRef.current.find((c) => (c.relayId || c.id) === peerId)?.blocked) return;
        setContacts((prev) =>
          prev.map((c) =>
            (c.relayId || c.id) === peerId ? { ...c, isOnline: !!online } : c
          )
        );
      });

      // Read receipt: sender's message was read by receiver
      ws.on('read_receipt', (msg) => {
        const { fromRelayId, messageId } = msg;
        if (!fromRelayId || !messageId) return;
        if (contactsRef.current.find((c) => (c.relayId || c.id) === fromRelayId)?.blocked) return;
        updateMessageStatus(messageId, 'read');
      });

      ws.on('call_offer', (msg) => {
        handleCallSignal(msg, 'call_offer');
      });

      ws.on('call_answer', (msg) => {
        handleCallSignal(msg, 'call_answer');
      });

      ws.on('call_ice', (msg) => {
        handleCallSignal(msg, 'call_ice');
      });

      ws.on('call_hangup', (msg) => {
        handleCallSignal(msg, 'call_hangup');
      });

      ws.on('call_ring', (msg) => {
        handleCallSignal(msg, 'call_ring');
      });

      ws.on('call_peers', (msg) => {
        handleCallSignal(msg, 'call_peers');
      });

      // Connect
      await ws.connect(identity.pubKeyHex);
    } catch (err) {
      setConnectionStatus('error');
      const errMsg = err instanceof Error ? err.message : 'Connection failed';
      setError(errMsg);
      toast.error('Connection failed', 'Could not connect to relay server. Retrying...');
    }
  }, [loadIdentity, shared, router, loadDictionary, initiateKeyExchange, handleKeyExchangeReceived, updateMessageStatus, handleBurnRequest, handleBurnConfirm, handleResyncRequest, handleResyncResponse, handleTypingIndicator, handleCallSignal, setConnectionStatus, setError, setContacts, setMessages, handlePurgeNotice]);

  return { initializeWebSocket };
}
