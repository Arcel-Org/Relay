/**
 * Call signaling hook — handles WebRTC call offer/answer/ice/hangup/ring signaling.
 */

import { useState, useCallback } from 'react';
import type { SharedMessagingRefs, CallSignalEvent } from './messaging-types';
import type { CallHangupReason } from '@/lib/relay/relay-websocket';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { log } from '@/lib/platform/logger';

type SessionsRef = SharedMessagingRefs['sessionsRef'];

// Call signaling (SDP offer/answer, ICE candidates) rides through the same
// relay as chat messages. It must never go out unencrypted — SDP includes
// local network/candidate info the relay (and anything terminating TLS in
// front of it, e.g. Cloudflare) has no business seeing. Encrypt with the
// same per-contact session used for messages; if no session exists yet,
// initiate one and wait (mirrors the pattern in use-message-editing.ts /
// use-reactions.ts) rather than falling back to plaintext. Callers must
// treat a null return as "could not send" (e.g. surface a call-setup error).
//
// The field carrying the payload (offer/answer/candidate) is always an
// encrypted hex string on success — real SDP/ICE payloads are objects, so a
// string value unambiguously means "encrypted, needs decrypting".
async function encryptSignalPayload<T>(
  sessionsRef: SessionsRef,
  contactId: string,
  payload: T,
  initiateKeyExchange: (contactRelayId: string, publicKeyHex: string) => void
): Promise<string | null> {
  let sessionData = sessionsRef.current.get(contactId);
  if (!sessionData) {
    log.warn(`[Call] No session with ${contactId} yet — initiating key exchange before sending call signal`);
    initiateKeyExchange(contactId, '');
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      sessionData = sessionsRef.current.get(contactId);
      if (sessionData) break;
    }
    if (!sessionData) {
      log.error(`[Call] Session never established for ${contactId} — refusing to send call signal unencrypted`);
      return null;
    }
  }
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return toHex(sessionData.session.encrypt(bytes));
  } catch (err) {
    log.error('[Call] Failed to encrypt call signal — refusing to send unencrypted:', err);
    return null;
  }
}

/**
 * Returns false when the field was encrypted and decryption failed (or no
 * session exists to decrypt it) — the caller must drop the signal entirely
 * rather than forwarding it downstream still holding the raw encrypted hex
 * string in place of a real RTCSessionDescriptionInit/RTCIceCandidateInit,
 * which would otherwise reach WebRTC APIs as a malformed payload with no
 * signal that decryption specifically was what failed.
 */
function decryptSignalPayload(sessionsRef: SessionsRef, fromContactId: string, msg: Record<string, any>, field: string): boolean {
  if (typeof msg[field] !== 'string') return true; // already a plain object — nothing to decrypt
  const sessionData = sessionsRef.current.get(fromContactId);
  if (!sessionData) {
    log.warn(`[Call] Received encrypted call signal from ${fromContactId} but no session exists to decrypt it`);
    return false;
  }
  try {
    const decrypted = sessionData.session.decrypt(fromHex(msg[field]));
    msg[field] = JSON.parse(new TextDecoder().decode(decrypted));
    return true;
  } catch (err) {
    log.warn(`[Call] Failed to decrypt call signal field "${field}" from ${fromContactId}:`, err);
    return false;
  }
}

export function useCallSignaling(
  shared: SharedMessagingRefs,
  initiateKeyExchange: (contactRelayId: string, publicKeyHex: string) => void
) {
  // Destructure the individual refs (not `shared` itself) for useCallback deps:
  // `shared` is a plain object literal rebuilt every render by the caller, so
  // depending on it directly would defeat memoization on every render. The
  // refs it holds are stable across renders.
  const { wsRef, sessionsRef } = shared;

  const [callSignals, setCallSignals] = useState<CallSignalEvent[]>([]);

  const handleCallSignal = useCallback(
    (msg: Record<string, any>, type: CallSignalEvent['type']) => {
      const fromContactId = msg.fromRelayId || msg.from;
      if (fromContactId) {
        let decrypted = true;
        if (type === 'call_offer') decrypted = decryptSignalPayload(sessionsRef, fromContactId, msg, 'offer');
        if (type === 'call_answer') decrypted = decryptSignalPayload(sessionsRef, fromContactId, msg, 'answer');
        if (type === 'call_ice') decrypted = decryptSignalPayload(sessionsRef, fromContactId, msg, 'candidate');
        if (!decrypted) {
          log.error(`[Call] Dropping ${type} from ${fromContactId} — could not decrypt, refusing to forward a malformed payload`);
          return;
        }
      }
      setCallSignals((prev) => [...prev, { ...msg, type, receivedAt: Date.now() } as CallSignalEvent]);
    },
    [sessionsRef]
  );

  // sendCallOffer/Answer/Ice are called from many places in use-webrtc-call.ts,
  // several not wrapped in try/catch (e.g. the onicecandidate handler). They
  // used to be sync and could throw synchronously on a missing WebSocket;
  // now that encryption may need to await a key exchange, throwing here would
  // surface as an unhandled promise rejection at most call sites instead of
  // being caught. Log and drop the frame instead of throwing — losing one
  // offer/answer/candidate is recoverable (renegotiation/ICE retries), a
  // silent plaintext leak is not.
  const sendCallOffer = useCallback(
    async (toContactId: string, offer: RTCSessionDescriptionInit, callId: string) => {
      const ws = wsRef.current;
      if (!ws) { log.error('[Call] Cannot send offer — WebSocket not initialized'); return; }
      const encrypted = await encryptSignalPayload(sessionsRef, toContactId, offer, initiateKeyExchange);
      if (encrypted === null) return;
      ws.sendCallOffer(toContactId, encrypted, callId);
    },
    [wsRef, sessionsRef, initiateKeyExchange]
  );

  const sendCallAnswer = useCallback(
    async (toContactId: string, answer: RTCSessionDescriptionInit, callId: string) => {
      const ws = wsRef.current;
      if (!ws) { log.error('[Call] Cannot send answer — WebSocket not initialized'); return; }
      const encrypted = await encryptSignalPayload(sessionsRef, toContactId, answer, initiateKeyExchange);
      if (encrypted === null) return;
      ws.sendCallAnswer(toContactId, encrypted, callId);
    },
    [wsRef, sessionsRef, initiateKeyExchange]
  );

  const sendCallIce = useCallback(
    async (toContactId: string, candidate: RTCIceCandidateInit, callId: string) => {
      const ws = wsRef.current;
      if (!ws) { log.error('[Call] Cannot send ICE candidate — WebSocket not initialized'); return; }
      const encrypted = await encryptSignalPayload(sessionsRef, toContactId, candidate, initiateKeyExchange);
      if (encrypted === null) return;
      ws.sendCallIce(toContactId, encrypted, callId);
    },
    [wsRef, sessionsRef, initiateKeyExchange]
  );

  const sendCallRing = useCallback(
    (toContactId: string, callId: string) => {
      const ws = wsRef.current;
      if (!ws) throw new Error('WebSocket not initialized');
      ws.sendCallRing(toContactId, callId);
    },
    [wsRef]
  );

  const sendCallHangup = useCallback(
    (toContactId: string, callId: string, reason?: CallHangupReason) => {
      const ws = wsRef.current;
      if (!ws) throw new Error('WebSocket not initialized');
      ws.sendCallHangup(toContactId, callId, reason);
    },
    [wsRef]
  );

  const sendCallPeers = useCallback(
    (toContactId: string, callId: string, peerIds: string[]) => {
      const ws = wsRef.current;
      if (!ws) return;
      ws.sendCallPeers(toContactId, callId, peerIds);
    },
    [wsRef]
  );

  const consumeCallSignals = useCallback((count: number) => {
    if (!count) return;
    setCallSignals((prev) => prev.slice(count));
  }, []);

  return {
    callSignals,
    handleCallSignal,
    sendCallOffer,
    sendCallAnswer,
    sendCallIce,
    sendCallRing,
    sendCallHangup,
    sendCallPeers,
    consumeCallSignals,
  };
}
