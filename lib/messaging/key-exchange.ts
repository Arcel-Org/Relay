/**
 * Hybrid (X25519 + ML-KEM768) key exchange — initiates and responds to the
 * handshake, establishes the Session, and drains any messages/files that
 * were queued while waiting for a session (pendingMessagesRef/
 * pendingFilesRef, written by send.ts) or queued incoming ciphertext
 * (pendingEncryptedRef, written by receive.ts). These must all operate on
 * the SAME ref instances passed down from the orchestrator via `shared`, or
 * queued items silently vanish.
 */

import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { toast } from '@/components/ToastNotification';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { bytesToHex } from '@noble/hashes/utils.js';
import { log } from '@/lib/platform/logger';
import {
  Session,
  computeSharedSecret,
  computeHybridSharedSecret,
  performPqEncapsulation,
  deriveHybridSecret,
  deriveSessionRole,
  deriveSuiteTranscript,
  SUITE_HYBRID,
  SUITE_CLASSICAL,
} from '@/lib/crypto/relay-crypto';
import { relayIdFromPublicKey } from '@/lib/crypto/relay-id';
import {
  loadContactPublicKey,
  saveContactPublicKey,
  loadContactPqPublicKey,
  loadContactSigningPublicKey,
  saveRatchetState,
  loadRatchetState,
} from '@/lib/messaging/contact-key-cache';
import { isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';
import { persistMessage } from '@/lib/messaging/message-persistence';
import { computeExpiresAt } from '@/lib/messaging/ghost-mode';
import { signMessage, deriveSigningKeypair } from '@/lib/crypto/message-signing';
import { getSafetyNumber, storeSafetyNumber } from '@/lib/features/features-store';
import { createSafetyNumber } from '@/lib/features/safety-numbers';
import type { SharedMessagingRefs, SharedMessagingState } from '@/lib/hooks/messaging-types';

interface UseKeyExchangeParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  loadDictionary: () => Promise<Uint8Array>;
}

export function useKeyExchange({ shared, state, loadDictionary }: UseKeyExchangeParams) {
  const {
    wsRef, identityRef, sessionsRef,
    keyExchangeLastResponseRef, keyExchangeTimeoutsRef, keyExchangeInitiatedRef,
    pendingPqSecretsRef, pendingEncryptedRef, pendingMessagesRef, pendingFilesRef,
    handleMessageReceivedRef, contactsRef,
  } = shared;
  const { contacts, setMessages } = state;

  const initiateKeyExchange = useCallback(
    (contactRelayId: string, contactPublicKeyHex: string, contactPqPublicKeyHex?: string, options?: { bypassCooldown?: boolean }) => {
      const ws = wsRef.current;
      const identity = identityRef.current;

      if (!ws || !identity) return;

      // Prevent concurrent key exchange attempts with the same contact.
      //
      // This cooldown is also what prevents a reconnect from clobbering an
      // encapsulation that's still in flight: performPqEncapsulation() below
      // is probabilistic — re-running it generates a NEW PQ ciphertext/secret
      // pair even for the same contact, overwriting pendingPqSecretsRef. If
      // the responder's reply to the FIRST (pre-drop) offer arrives after
      // we've already overwritten the stored secret with a second attempt's,
      // the derived hybrid secret silently mismatches theirs (auth-tag
      // failures forever, not a security downgrade — just a broken session).
      // relay-websocket's reconnect backoff is 1s * 1.5^attempt, so a short
      // cooldown here gets exceeded after just two failed reconnects. Kept
      // well above realistic multi-attempt reconnect windows so a genuine
      // blip's original handshake gets a real chance to complete before a
      // reconnect is allowed to start a second, secret-clobbering one.
      const now = Date.now();
      const lastInitiated = keyExchangeLastResponseRef.current.get(`init:${contactRelayId}`) || 0;
      // A refuse-and-reinitiate driven by a just-received offer (the #8 downgrade
      // paths below) passes bypassCooldown: it must respond PROMPTLY instead of
      // sitting out the 20s anti-clobber window. Otherwise two PQ-capable peers
      // that initiated to each other at nearly the same instant (a relay-restart
      // reconnect storm) each receive the other's classical-only offer, each
      // refuses, and each is then cooldown-blocked from re-initiating — a 20s+
      // deadlock with no session on either side. Safe here because the callers
      // only re-initiate when NO PQ encapsulation is already in flight for the
      // peer (see refuseAndReinitiateHybrid), so no stored secret is clobbered.
      if (!options?.bypassCooldown && now - lastInitiated < 20_000) return;

      if (!ws.isReady()) {
        // Schedule a single retry after a short delay to allow reconnection
        if (!keyExchangeTimeoutsRef.current.has(contactRelayId)) {
          const timeout = setTimeout(() => {
            keyExchangeTimeoutsRef.current.delete(contactRelayId);
            if (ws.isReady()) {
              initiateKeyExchange(contactRelayId, contactPublicKeyHex, contactPqPublicKeyHex);
            }
          }, 500);
          keyExchangeTimeoutsRef.current.set(contactRelayId, timeout);
        }
        return;
      }

      // For hybrid key exchange, resolve the contact's PQ public key HERE rather
      // than trusting the caller to pass it — every prod call site currently
      // passes '' / undefined, which is exactly why the PQ path was dead (#1).
      // Fall back to the cached key learned from a prior exchange.
      const resolvedPqHex = contactPqPublicKeyHex || loadContactPqPublicKey(contactRelayId) || undefined;

      let pqCipherTextHex: string | undefined;
      const bothPqCapable = !!(resolvedPqHex && identity.pqPublicKey);
      if (bothPqCapable) {
        try {
          const pqPublic = fromHex(resolvedPqHex!);
          const { cipherText, sharedSecret: pqSharedSecret } = performPqEncapsulation(pqPublic);
          pqCipherTextHex = toHex(cipherText);
          // Store the PQ shared secret so we can derive the hybrid secret when the
          // responder replies (their response won't include a ciphertext for us to
          // decapsulate — this is a one-way encapsulation, as in Signal PQXDH).
          pendingPqSecretsRef.current.set(contactRelayId, pqSharedSecret);
        } catch (err) {
          // Both peers are PQ-capable: do NOT silently drop to a classical
          // handshake (#8). Fail closed — the queued messages stay queued and a
          // later exchange can retry — rather than establishing a downgradeable
          // session a "harvest now, decrypt later" quantum adversary can break.
          log.error(`[Hybrid] PQ encapsulation to ${contactRelayId} failed; refusing classical downgrade`, err);
          return;
        }
      }

      // Send key exchange with hybrid PQ data if available, plus our
      // Ed25519 signing public key so the peer can verify our signed
      // messages (see lib/crypto/message-signing.ts's deriveSigningKeypair
      // for why this can't just be the X25519 identity key).
      const signingKeypair = deriveSigningKeypair(identity.privateKey);
      ws.sendKeyExchange(
        contactRelayId,
        toHex(identity.publicKey),
        identity.pqPublicKey ? toHex(identity.pqPublicKey) : undefined,
        pqCipherTextHex,
        toHex(signingKeypair.publicKey)
      );
      keyExchangeInitiatedRef.current.add(contactRelayId);
      keyExchangeLastResponseRef.current.set(`init:${contactRelayId}`, now);
    },
    [shared]
  );

  const handleKeyExchangeReceived = useCallback(async (msg: any) => {
    const { fromRelayId, publicKey: theirPublicKeyHex, pqPublicKey: theirPqPublicKeyHex, pqCipherText, signingPublicKey: theirSigningPublicKeyHex } = msg;
    const from = fromRelayId; // The relay sends fromRelayId

    if (!identityRef.current) return;

    // A blocked contact's key-exchange offer must never establish/refresh a
    // session — see lib/features/block.ts.
    if (contactsRef.current.find((c) => (c.relayId || c.id) === from)?.blocked) return;

    // Validate that publicKey is present (key_exchange_hint may not have it)
    if (!theirPublicKeyHex) {
      log.warn(`Key exchange from ${from} missing publicKey, ignoring`);
      return;
    }

    try {
      // AUTHENTICATE THE HANDSHAKE (#2): the relay is untrusted and stamps
      // `fromRelayId` itself, so a MITM relay can forward its OWN public key
      // while still claiming the offer came from the victim's contact. A relayId
      // is a hash of the sender's identity key, so a genuine offer MUST satisfy
      // relayIdFromPublicKey(theirPublicKey) === fromRelayId. Reject any mismatch
      // outright — establishing a session with a key that doesn't hash to the
      // claimed identity is exactly the relay-MITM this closes off.
      const theirPublicKey = fromHex(theirPublicKeyHex);
      const derivedRelayId = relayIdFromPublicKey(theirPublicKey);
      if (derivedRelayId !== from) {
        log.error(`[Security] Key exchange identity mismatch from ${from}: presented key hashes to ${derivedRelayId}. Rejecting (possible relay MITM).`);
        toast.warning(
          'Rejected suspicious key exchange',
          `A key exchange claiming to be from ${String(from).slice(0, 11)} did not match that identity and was rejected.`
        );
        return;
      }

      // NEVER REGRESS THE RECV COUNTER (#10): if we already hold a live session
      // for this exact peer key AND durable ratchet state exists, rebuilding
      // would reset the recv counter to 0 — precisely what a replayed key
      // exchange offer exploits to make previously-captured ciphertexts decrypt
      // again. Keep the existing session (both peers resume from persisted
      // ratchet state); just adopt a newly-delivered signing key and re-respond.
      const existingSession = sessionsRef.current.get(from);
      const persisted = loadRatchetState(from);
      // We already hold durable ratchet state for this EXACT peer key → never
      // rebuild from counter 0. Covers both a live session and the race where a
      // key_exchange arrives before the restore path resumed the session (which
      // would otherwise reset counters AND clobber the good persisted state).
      const haveDurableStateForThisKey =
        !!persisted &&
        (existingSession?.publicKeyHex === theirPublicKeyHex ||
          loadContactPublicKey(from) === theirPublicKeyHex);

      if (haveDurableStateForThisKey) {
        let sessionData = existingSession;
        if (!sessionData) {
          // Resume the persisted ratchet into memory rather than resetting to 0.
          const dict = await loadDictionary();
          if (dict && dict.length > 0) {
            sessionData = {
              relayId: from,
              session: Session.fromSerialized(persisted!, dict),
              publicKeyHex: theirPublicKeyHex,
              signingPublicKeyHex:
                theirSigningPublicKeyHex ?? loadContactSigningPublicKey(from) ?? undefined,
            };
            sessionsRef.current.set(from, sessionData);
          }
        }
        if (sessionData && theirSigningPublicKeyHex && sessionData.signingPublicKeyHex !== theirSigningPublicKeyHex) {
          if (!sessionData.signingPublicKeyHex) {
            // First time learning this peer's signing key for an otherwise
            // already-established session (same X25519 identity key) — pin it.
            sessionData.signingPublicKeyHex = theirSigningPublicKeyHex;
            saveContactPublicKey(from, theirPublicKeyHex, theirPqPublicKeyHex, theirSigningPublicKeyHex);
          } else {
            // #3 HARDENING — a key_exchange message carries no signature of its
            // own (only the classical X25519 key is bound, via the relayId-hash
            // check above), so anyone who knows the peer's real (public, not
            // secret) X25519 key can forge one. deriveSigningKeypair() derives
            // the Ed25519 signing key deterministically from that SAME identity
            // private key, so a genuine peer whose classical key hasn't changed
            // can never legitimately present a different signing key. Silently
            // accepting a new one here would let a relay/MITM that knows the
            // peer's public key hijack signature verification for an
            // already-trusted session (a forged "reset" of the trust anchor).
            // Refuse it — keep the pinned key.
            log.error(`[Security] Key exchange for ${from} presents a different signing key than the pinned one for an established session; ignoring (possible relay MITM / forged reset).`);
          }
        }
        log.debug(`[KeyExchange] Session with ${from} preserved/resumed (no ratchet reset)`);
      } else {
        // #2 HARDENING — reject a substituted identity key for an ESTABLISHED
        // peer. relayId = hash(publicKey), so a single relayId can only ever map
        // to one legitimate key (a genuine key change would change the relayId,
        // making it a different contact). A DIFFERENT key that still hashes to
        // the same relayId is a second-preimage collision — findable in ~2^41
        // work because relayIdFromPublicKey uses only 8 bytes mod 36^8 (~41.4
        // bits). Rebuilding a session from such a key would also silently bypass
        // the #10 counter-reset guard (which only fires on a key MATCH), rolling
        // the recv ratchet back to 0. Refuse it. NOTE: this is defense-in-depth
        // for already-established peers only — the ROOT fix for the 41-bit
        // weakness is widening relayIdFromPublicKey to >=128 bits in
        // lib/crypto/relay-id.ts, which is outside this change's file scope
        // (see followUp).
        const establishedKey = existingSession?.publicKeyHex ?? loadContactPublicKey(from);
        if ((existingSession || persisted) && establishedKey && establishedKey !== theirPublicKeyHex) {
          log.error(`[Security] Key exchange for ${from} presents a different key than the established session; rejecting (relayId second-preimage / relay MITM).`);
          const peerName = contacts.find((c) => c.relayId === from)?.name || String(from).slice(0, 11);
          toast.warning(
            'Rejected key change',
            `${peerName}'s handshake used a different encryption key than the established session and was rejected. Verify their safety number before trusting new messages.`
          );
          return;
        }

        // CRITICAL: Load dictionary first and ensure it's ready before creating session
        const dict = await loadDictionary();
        if (!dict || dict.length === 0) {
          throw new Error('Dictionary failed to load');
        }

        // Compute hybrid shared secret (handles both PQ and classical)
        const role = deriveSessionRole(identityRef.current.publicKey, theirPublicKey);
        const haveCiphertext = !!(theirPqPublicKeyHex && pqCipherText && identityRef.current.pqPrivateKey);
        const havePending = pendingPqSecretsRef.current.has(from);
        let sharedSecret: Uint8Array;
        let usedHybrid = false;

        // Refuse a classical(-only) offer from a PQ-capable peer and drive an
        // ENCAPSULATING hybrid exchange instead (#8). The re-initiate bypasses
        // the 20s cooldown so first contact resolves immediately, but is guarded
        // to at most ONE encapsulation in flight per peer: if a PQ secret is
        // already pending, a repeat classical-only offer means the relay is
        // actively stripping PQ in both directions, and re-initiating again would
        // just flood. Bounded fail-closed — hold (no session, never a silent
        // classical downgrade) until the in-flight hybrid completes.
        const refuseAndReinitiateHybrid = (peerPqHex: string) => {
          if (pendingPqSecretsRef.current.has(from)) return;
          saveContactPublicKey(from, theirPublicKeyHex, peerPqHex, theirSigningPublicKeyHex);
          initiateKeyExchange(from, theirPublicKeyHex, peerPqHex, { bypassCooldown: true });
        };

        if (haveCiphertext && havePending) {
          // Both sides encapsulated at once (e.g. simultaneous reconnect). Break
          // the tie by role so BOTH peers derive the SAME hybrid secret rather
          // than each decapsulating the other's (different) ciphertext and
          // silently desyncing: the role-'A' side is the canonical initiator
          // (its own encapsulation counts), role-'B' decapsulates A's ciphertext.
          if (role === 'A') {
            const storedPqSecret = pendingPqSecretsRef.current.get(from)!;
            pendingPqSecretsRef.current.delete(from);
            const classicalShared = computeSharedSecret(identityRef.current.privateKey, theirPublicKey);
            sharedSecret = deriveHybridSecret(classicalShared, storedPqSecret);
          } else {
            pendingPqSecretsRef.current.delete(from);
            sharedSecret = computeHybridSharedSecret({
              myClassicalPrivate: identityRef.current.privateKey,
              theirClassicalPublic: theirPublicKey,
              cipherText: fromHex(pqCipherText),
              myPqPrivate: identityRef.current.pqPrivateKey,
            });
          }
          usedHybrid = true;
          log.debug(`[Hybrid] Established hybrid session with ${from} via role-${role} tie-break`);
        } else if (haveCiphertext) {
          // Responder path: initiator sent their PQ public key + a ciphertext we
          // decapsulate with our PQ private key.
          sharedSecret = computeHybridSharedSecret({
            myClassicalPrivate: identityRef.current.privateKey,
            theirClassicalPublic: theirPublicKey,
            cipherText: fromHex(pqCipherText),
            myPqPrivate: identityRef.current.pqPrivateKey,
          });
          usedHybrid = true;
          log.debug(`[Hybrid] Established hybrid session with ${from} via PQ decapsulation (responder)`);
        } else if (havePending) {
          // Initiator path: we encapsulated earlier and stored the PQ secret; the
          // responder's reply carries no ciphertext, so we reuse the stored secret.
          const storedPqSecret = pendingPqSecretsRef.current.get(from)!;
          pendingPqSecretsRef.current.delete(from);
          const classicalShared = computeSharedSecret(identityRef.current.privateKey, theirPublicKey);
          sharedSecret = deriveHybridSecret(classicalShared, storedPqSecret);
          usedHybrid = true;
          log.debug(`[Hybrid] Established hybrid session with ${from} via stored PQ secret (initiator)`);
        } else if (theirPqPublicKeyHex && identityRef.current.pqPublicKey && identityRef.current.pqPrivateKey) {
          // Both peers are PQ-capable and advertised PQ, but this offer can't
          // complete a hybrid handshake (no ciphertext, no encapsulation in
          // flight — the first-contact case before either side cached the
          // other's PQ key). Do NOT silently settle for classical (#8): cache
          // their keys and drive an ENCAPSULATING exchange, upgrading the channel
          // in one extra round trip. Fails closed, never down to classical.
          log.warn(`[Hybrid] ${from} is PQ-capable but sent a classical-only offer; refusing downgrade and re-initiating a hybrid exchange`);
          refuseAndReinitiateHybrid(theirPqPublicKeyHex);
          return;
        } else {
          // No PQ key on THIS offer. If we've previously learned this peer's PQ
          // key (cached/persisted) AND we're PQ-capable, a classical-only offer
          // is a DOWNGRADE, not a genuine classical peer: a MITM relay can strip
          // the PQ advertisement from BOTH directions (server forwards
          // pqPublicKey only conditionally), so neither side's offer carries it
          // and the suite-transcript binding alone can't catch it — both peers
          // would otherwise settle on SUITE_CLASSICAL and interoperate over a
          // silently-downgraded channel (harvest-now-decrypt-later). Refuse and
          // re-drive hybrid from the cached key instead (#8, symmetric strip).
          const knownPeerPq = loadContactPqPublicKey(from);
          if (knownPeerPq && identityRef.current.pqPublicKey && identityRef.current.pqPrivateKey) {
            log.warn(`[Hybrid] ${from} is known PQ-capable but sent a classical-only offer; refusing silent downgrade and re-initiating hybrid from the cached PQ key`);
            refuseAndReinitiateHybrid(knownPeerPq);
            return;
          }
          // Genuinely classical: no evidence either side is PQ-capable. This
          // also covers true first contact IF the peer really has no PQ key —
          // the earlier residual gap (a MITM stripping the PQ advertisement on
          // the very first exchange, before either side had anything cached)
          // is now closed by username-lookup.ts's lookupUserProfile, which
          // pre-seeds loadContactPqPublicKey() from the profile-directory
          // lookup (an independent, TLS-authenticated HTTPS channel) before
          // any WS key-exchange message is ever processed — so `knownPeerPq`
          // above is populated even on a first exchange, and the downgrade
          // check just above already covers it.
          sharedSecret = computeSharedSecret(identityRef.current.privateKey, theirPublicKey);
        }

        // SECURITY: warn (don't silently trust) if this contact's public key just
        // changed vs. a legacy stored key. With the identity-binding check above
        // a *bound* key can no longer differ for the same relayId, but a key
        // stored before that check existed still might.
        const previouslyKnownKey = loadContactPublicKey(from);
        if (previouslyKnownKey && previouslyKnownKey !== theirPublicKeyHex) {
          const peerName = contacts.find((c) => c.relayId === from)?.name || from.slice(0, 11);
          log.warn(`[Security] Public key for ${from} changed since last session`);
          toast.warning(
            'Contact key changed',
            `${peerName}'s encryption key is different from before. Verify it's really them before trusting new messages.`
          );

          // A key rotation invalidates any prior safety-number verification —
          // recompute against the NEW key, carry the OLD hash forward, and mark
          // unverified so the verification UI shows "re-verify".
          getSafetyNumber(from)
            .then((existing) => {
              if (existing?.verified && identityRef.current) {
                const recomputed = createSafetyNumber(
                  bytesToHex(identityRef.current.publicKey),
                  theirPublicKeyHex,
                  identityRef.current.relayId,
                  from,
                  existing.hashHex
                );
                return storeSafetyNumber({ ...recomputed, verified: false, verifiedAt: undefined });
              }
            })
            .catch((err) => log.warn('[Security] Failed to invalidate stale safety number:', err));
        }

        // Bind the negotiated cipher suite into the root key so a downgrade
        // can't silently succeed (#8), then create the session.
        const suiteId = usedHybrid ? SUITE_HYBRID : SUITE_CLASSICAL;
        const suiteTranscript = deriveSuiteTranscript(suiteId, identityRef.current.publicKey, theirPublicKey);
        const session = new Session(sharedSecret, dict, 1, role, { suiteTranscript });
        sessionsRef.current.set(from, {
          relayId: from,
          session,
          publicKeyHex: theirPublicKeyHex,
          signingPublicKeyHex: theirSigningPublicKeyHex,
        });

        // Persist the contact's keys AND the fresh ratchet state so a later
        // restore resumes this session instead of resetting to counter 0 (#3, #10).
        saveContactPublicKey(from, theirPublicKeyHex, theirPqPublicKeyHex, theirSigningPublicKeyHex);
        saveRatchetState(from, session.serialize());
      }

      // CLEAR KEY EXCHANGE TIMEOUT - session is now ready!
      if (keyExchangeTimeoutsRef.current.has(from)) {
        clearTimeout(keyExchangeTimeoutsRef.current.get(from)!);
        keyExchangeTimeoutsRef.current.delete(from);
      }
    } catch (err) {
      log.error(`Failed to establish session with ${from}:`, err);
      return;
    }

    // Always respond to incoming key exchanges so the other side can establish
    // their session — this is critical after a page refresh, where the refreshed
    // side loses its session and needs a fresh response. Use a 2-second cooldown
    // per-peer to prevent infinite response loops while still handling refresh.
    const ws = wsRef.current;
    if (ws && identityRef.current) {
      const now = Date.now();
      const lastResponded = keyExchangeLastResponseRef.current.get(from) || 0;
      if (now - lastResponded > 2000) {
        // Send our PQ key if we have it, so the other side can encapsulate
        let ourPqPublicKeyHex: string | undefined;
        if (identityRef.current.pqPublicKey) {
          ourPqPublicKeyHex = toHex(identityRef.current.pqPublicKey);
        }

        const ourSigningKeypair = deriveSigningKeypair(identityRef.current.privateKey);
        ws.sendKeyExchange(
          from,
          toHex(identityRef.current.publicKey),
          ourPqPublicKeyHex,
          undefined,
          toHex(ourSigningKeypair.publicKey)
        );
        keyExchangeLastResponseRef.current.set(from, now);
        keyExchangeInitiatedRef.current.add(from);
      }
    }

    // Process any queued encrypted incoming messages for this contact
    const queuedEncrypted = pendingEncryptedRef.current.get(from);
    if (queuedEncrypted && queuedEncrypted.length > 0) {
      log.debug(`[Message] Processing ${queuedEncrypted.length} queued encrypted messages from ${from}`);
      pendingEncryptedRef.current.delete(from);
      for (const { msg: queuedMsg } of queuedEncrypted) {
        // Small delay between messages to avoid race conditions
        await new Promise(resolve => setTimeout(resolve, 50));
        handleMessageReceivedRef.current?.(queuedMsg);
      }
    }

    // Process any pending messages for this contact — a contact can have
    // accumulated more than one message while its key exchange was pending,
    // so send them all in order rather than just the most recent.
    const pendingQueue = pendingMessagesRef.current.get(from);
    if (pendingQueue && pendingQueue.length > 0) {
      const remaining: typeof pendingQueue = [];
      for (const { text, messageId } of pendingQueue) {
        try {
          // Small delay to ensure session is ready
          await new Promise(resolve => setTimeout(resolve, 100));

          // Send pending message directly using relayId
          const sessionData = sessionsRef.current.get(from);
          if (sessionData && sessionData.session) {
            const ws = wsRef.current;
            if (ws && identityRef.current) {
              // Use provided messageId or generate one
              const msgId = messageId || uuidv4();

              // Sign + wrap the same as the live send path (see sendMessage)
              // so a message that happened to be queued for key exchange
              // isn't silently unsigned/unverifiable on the receive side.
              const queuedSigningKeypair = deriveSigningKeypair(identityRef.current.privateKey);
              const signed = await signMessage(msgId, text, identityRef.current.relayId, queuedSigningKeypair.privateKey);
              const wirePayload = JSON.stringify({ type: 'text', text, sig: signed.signature, sigTs: signed.timestamp });
              const plaintext = new TextEncoder().encode(wirePayload);
              const encrypted = await sessionData.session.encryptAsync(plaintext);
              saveRatchetState(from, sessionData.session.serialize());
              const blob = toHex(encrypted);

              // Send immediately
              ws.sendMessage(from, blob, msgId);

              // Also persist to storage (skipped entirely for ghost contacts)
              const pendingExpiresAt = computeExpiresAt(from);
              if (!isEphemeralContact(from)) {
                persistMessage({
                  id: msgId,
                  conversationId: from,
                  senderId: identityRef.current.relayId,
                  text,
                  status: 'sending',
                  timestamp: Date.now(),
                  expiresAt: pendingExpiresAt,
                  ghost: pendingExpiresAt !== undefined,
                }).catch(err => log.error('Failed to persist pending message:', err));
              }
            } else {
              log.warn('WebSocket or identity not ready for pending message');
              remaining.push({ relayId: from, text, messageId });
            }
          } else {
            log.warn('Session not established for pending message');
            remaining.push({ relayId: from, text, messageId });
          }
        } catch (err) {
          log.error(`Error sending pending message to ${from}:`, err);
          // Keep it queued — let it retry on the next key-exchange completion
          remaining.push({ relayId: from, text, messageId });
        }
      }
      if (remaining.length > 0) {
        pendingMessagesRef.current.set(from, remaining);
      } else {
        pendingMessagesRef.current.delete(from);
      }
    }

    // Process any pending file for this contact
    const pendingFile = pendingFilesRef.current.get(from);
    if (pendingFile) {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        const sessionData = sessionsRef.current.get(from);
        if (sessionData && sessionData.session && wsRef.current && identityRef.current) {
          const plaintext = new TextEncoder().encode(pendingFile.payload);
          const encrypted = await sessionData.session.encryptAsync(plaintext);
          saveRatchetState(from, sessionData.session.serialize());
          const blob = toHex(encrypted);
          wsRef.current.sendMessage(from, blob, pendingFile.msgId);
          pendingFilesRef.current.delete(from);
          // Update the optimistic message status
          setMessages((prev) => {
            const updated = new Map(prev);
            const msgs = updated.get(from) || [];
            updated.set(from, msgs.map((m) => m.id === pendingFile.msgId ? { ...m, status: 'sending' as const } : m));
            return updated;
          });
        }
      } catch (err) {
        log.error(`Error sending pending file to ${from}:`, err);
      }
    }
  }, [loadDictionary, shared, contacts, setMessages, initiateKeyExchange]);

  return { initiateKeyExchange, handleKeyExchangeReceived };
}
