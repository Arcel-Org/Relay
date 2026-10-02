/**
 * Authenticated ratchet-resync recovery.
 *
 * If a 1:1 ratchet ever desyncs (e.g. a crash right after sending, between
 * encrypt and the ratchet-state persist), decryption fails permanently —
 * key-exchange.ts's "#10" anti-replay hardening deliberately refuses to
 * rebuild a session from a plain `key_exchange` message when durable ratchet
 * state already exists for that peer key, because a legitimate resync (same
 * X25519 identity key, re-offered) is otherwise indistinguishable from an
 * attacker replaying a captured old `key_exchange` to reset the recv counter
 * and make previously-captured ciphertexts decryptable again.
 *
 * This module adds a SEPARATE, more strongly authenticated escape hatch — a
 * signed `resync_request`/`resync_response` control-message pair — that
 * doesn't touch #10's logic at all:
 *  - Signed with the sender's Ed25519 signing key (the one already pinned via
 *    contact-key-cache.ts from the original key exchange) — a hostile relay
 *    operator cannot forge this, since it holds neither party's identity key.
 *  - Freshness + replay protection via a persisted "last accepted resync"
 *    record per contact (contact-key-cache.ts's saveLastResyncRecord)  —
 *    accepting a request requires its nonce/timestamp to strictly advance
 *    past whatever's on file, closing exact-replay of a captured resync
 *    packet even across an app restart, without needing unbounded nonce
 *    storage.
 * Reuses signMessage/verifyMessageSignature as-is (nonce slots into the
 * existing `messageId` param) rather than inventing new signing primitives.
 */
import { useCallback, useRef } from 'react';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { signMessage, verifyMessageSignature, deriveSigningKeypair } from '@/lib/crypto/message-signing';
import {
  loadContactPublicKey,
  loadContactSigningPublicKey,
  clearRatchetState,
  saveLastResyncRecord,
  loadLastResyncRecord,
} from '@/lib/messaging/contact-key-cache';
import { log } from '@/lib/platform/logger';
import type { SharedMessagingRefs, SharedMessagingState, MessageWithStatus } from '@/lib/hooks/messaging-types';

// A single decrypt failure is noise (a benign duplicate/reorder never even
// reaches this trigger — the ratchet's own skippedRecvKeys/maxSkip already
// tolerates that). A genuine desync recurs on every subsequent message
// since the chain is actually broken, so require a 2nd failure within this
// window before treating it as real.
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 2;
// Rate-limit outgoing resync requests per contact so a barrage of garbage
// frames (e.g. from a hostile relay spoofing fromRelayId) can't spam them —
// harmless either way, since a forged resync_response could never be
// produced without the peer's real signing key, but this keeps behavior
// quiet and avoids confusing repeated "resynced" system messages.
const RESYNC_RATE_LIMIT_MS = 5 * 60 * 1000;
// Symmetric rate limit on the INCOMING side, for a contact whose signing
// key genuinely IS pinned (a real current or former contact, or a
// compromised device of one) — unlike a hostile relay, they CAN produce a
// validly-signed resync_request/resync_response indefinitely. Without this,
// they could force a full clearRatchetState + re-key on every message,
// forever — a legitimate-signature nuisance/DoS the outgoing-side limit
// alone doesn't cover, since resync_response is accepted even when we never
// sent a matching request.
const INCOMING_ACCEPT_RATE_LIMIT_MS = 5 * 60 * 1000;

interface UseResyncParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  initiateKeyExchange: (
    contactRelayId: string,
    publicKeyHex: string,
    pqPublicKeyHex?: string,
    options?: { bypassCooldown?: boolean }
  ) => void;
}

export function useResync({ shared, state, initiateKeyExchange }: UseResyncParams) {
  const { wsRef, identityRef, sessionsRef } = shared;
  const { setMessages } = state;

  const failureTrackerRef = useRef(new Map<string, { count: number; firstFailureAt: number }>());
  const lastSentAtRef = useRef(new Map<string, number>());
  const lastAcceptedIncomingAtRef = useRef(new Map<string, number>());

  const appendSystemMessage = useCallback((contactRelayId: string, text: string) => {
    setMessages((prev) => {
      const updated = new Map(prev);
      const msgs = updated.get(contactRelayId) || [];
      const sysMsg: MessageWithStatus = {
        id: `resync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        senderId: 'system',
        senderName: 'System',
        text,
        timestamp: new Date(),
        isOwn: false,
        read: true,
        delivered: true,
        status: 'sent',
        messageType: 'system',
        reactions: [],
        metadata: {
          compression_ratio: 1,
          original_size: text.length,
          compressed_size: text.length,
          encrypted_size: text.length,
          latency_ms: 0,
          neural_model_score: 1,
        },
      };
      updated.set(contactRelayId, [...msgs, sysMsg]);
      return updated;
    });
  }, [setMessages]);

  /**
   * Called from receive.ts on every decrypt failure. Internally decides
   * (via its own failure counter + rate limit) whether this particular call
   * should actually trigger sending a signed resync_request — most calls
   * are no-ops that just update the tracker.
   */
  const initiateResync = useCallback((contactRelayId: string) => {
    const now = Date.now();
    const tracker = failureTrackerRef.current.get(contactRelayId);
    if (!tracker || now - tracker.firstFailureAt > FAILURE_WINDOW_MS) {
      failureTrackerRef.current.set(contactRelayId, { count: 1, firstFailureAt: now });
      return;
    }
    tracker.count += 1;
    if (tracker.count < FAILURE_THRESHOLD) return;

    const lastSent = lastSentAtRef.current.get(contactRelayId) || 0;
    if (now - lastSent < RESYNC_RATE_LIMIT_MS) return;

    const identity = identityRef.current;
    const ws = wsRef.current;
    if (!identity || !ws) return;

    lastSentAtRef.current.set(contactRelayId, now);
    failureTrackerRef.current.delete(contactRelayId);

    void (async () => {
      try {
        const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
        const signingKeypair = deriveSigningKeypair(identity.privateKey);
        // The signed content binds the message type ("resync_request:") so a
        // hostile relay can't relabel this in transit as a resync_response
        // (or vice versa, see the response send site below) — see
        // validateIncoming's matching reconstruction for why that matters.
        const signed = await signMessage(nonce, `resync_request:${contactRelayId}`, identity.relayId, signingKeypair.privateKey);
        ws.sendRaw({
          type: 'resync_request',
          fromRelayId: identity.relayId,
          toRelayId: contactRelayId,
          nonce,
          timestamp: signed.timestamp,
          signature: signed.signature,
        });
        log.debug(`[Resync] Sent resync_request to ${contactRelayId} after repeated decrypt failures`);
      } catch (err) {
        log.error(`[Resync] Failed to send resync_request to ${contactRelayId}:`, err);
      }
    })();
  }, [identityRef, wsRef]);

  /** Verifies signature + freshness/replay, returns the pinned signing key hex or null if not found/invalid. */
  const validateIncoming = useCallback((msg: any, ownRelayId: string): boolean => {
    const { fromRelayId, nonce, timestamp, signature } = msg;
    if (!fromRelayId || typeof nonce !== 'string' || typeof timestamp !== 'number' || typeof signature !== 'string') {
      return false;
    }
    // Checked before spending any crypto work: bounds how often we'll ever
    // act on a resync from a given contact, regardless of whether they hold
    // a genuinely valid signing key — a real (or compromised) contact could
    // otherwise force a full clearRatchetState + re-key on every message,
    // forever, since resync_response is accepted even absent a matching
    // outgoing request.
    const now = Date.now();
    const lastAccepted = lastAcceptedIncomingAtRef.current.get(fromRelayId) || 0;
    if (now - lastAccepted < INCOMING_ACCEPT_RATE_LIMIT_MS) {
      log.warn(`[Resync] Ignoring ${msg.type} from ${fromRelayId} — accepted one too recently`);
      return false;
    }
    const signingKeyHex = loadContactSigningPublicKey(fromRelayId) || sessionsRef.current.get(fromRelayId)?.signingPublicKeyHex;
    if (!signingKeyHex) {
      log.warn(`[Resync] Ignoring ${msg.type} from ${fromRelayId} — no pinned signing key on file`);
      return false;
    }
    try {
      // Reconstruct the SAME type-bound content the sender signed (see the
      // two send sites) — this is what stops a hostile relay from relabeling
      // a captured resync_response as a resync_request (or vice versa) in
      // transit: the signature only verifies against the real type, so a
      // relabeled envelope fails here instead of triggering the wrong
      // handler (request-received also initiates a new key exchange;
      // response-received deliberately does not, to avoid both sides racing
      // to initiate at once — see handleResyncResponseReceived's comment).
      verifyMessageSignature(
        { messageId: nonce, content: `${msg.type}:${ownRelayId}`, timestamp, signature, senderRelayId: fromRelayId },
        fromHex(signingKeyHex)
      );
    } catch (err) {
      log.warn(`[Resync] Rejected ${msg.type} from ${fromRelayId} — signature/freshness check failed:`, err);
      return false;
    }
    const lastRecord = loadLastResyncRecord(fromRelayId);
    if (lastRecord && (nonce === lastRecord.nonce || timestamp <= lastRecord.timestamp)) {
      log.warn(`[Resync] Rejected ${msg.type} from ${fromRelayId} — nonce/timestamp did not advance (possible replay)`);
      return false;
    }
    saveLastResyncRecord(fromRelayId, { nonce, timestamp });
    lastAcceptedIncomingAtRef.current.set(fromRelayId, now);
    return true;
  }, [sessionsRef]);

  const handleResyncRequestReceived = useCallback(async (msg: any) => {
    const identity = identityRef.current;
    if (!identity) return;
    if (!validateIncoming(msg, identity.relayId)) return;

    const fromRelayId = msg.fromRelayId as string;
    clearRatchetState(fromRelayId);
    sessionsRef.current.delete(fromRelayId);
    appendSystemMessage(fromRelayId, '🔄 Encryption resynced');

    const ws = wsRef.current;
    if (ws) {
      try {
        const responseNonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
        const signingKeypair = deriveSigningKeypair(identity.privateKey);
        const signed = await signMessage(responseNonce, `resync_response:${fromRelayId}`, identity.relayId, signingKeypair.privateKey);
        ws.sendRaw({
          type: 'resync_response',
          fromRelayId: identity.relayId,
          toRelayId: fromRelayId,
          nonce: responseNonce,
          timestamp: signed.timestamp,
          signature: signed.signature,
        });
      } catch (err) {
        log.error(`[Resync] Failed to send resync_response to ${fromRelayId}:`, err);
      }
    }

    // Both the session and persisted ratchet state are gone now, so
    // key-exchange.ts's #10 check naturally falls through to constructing a
    // brand-new session — no change needed there. Only the request-receiver
    // drives the actual new handshake (see handleResyncResponseReceived for
    // why the requester doesn't also call this, avoiding a race).
    const contactPublicKeyHex = loadContactPublicKey(fromRelayId);
    initiateKeyExchange(fromRelayId, contactPublicKeyHex || '', undefined, { bypassCooldown: true });
  }, [identityRef, sessionsRef, validateIncoming, appendSystemMessage, wsRef, initiateKeyExchange]);

  const handleResyncResponseReceived = useCallback((msg: any) => {
    const identity = identityRef.current;
    if (!identity) return;
    if (!validateIncoming(msg, identity.relayId)) return;

    const fromRelayId = msg.fromRelayId as string;
    clearRatchetState(fromRelayId);
    sessionsRef.current.delete(fromRelayId);
    appendSystemMessage(fromRelayId, '🔄 Encryption resynced');
    // No initiateKeyExchange call here — the requester waits for the
    // responder's forthcoming key_exchange (sent right after clearing on
    // their side, above) to complete the reset via the existing, already-
    // tested flow, rather than both sides racing to initiate at once.
  }, [identityRef, sessionsRef, validateIncoming, appendSystemMessage]);

  return { initiateResync, handleResyncRequestReceived, handleResyncResponseReceived };
}
