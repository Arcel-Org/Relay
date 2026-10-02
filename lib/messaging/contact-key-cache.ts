/**
 * Contact public key cache — in-memory cache for contact public keys
 * (populated from encrypted IndexedDB), used for session recovery after a
 * page refresh without needing an async round-trip in hot paths.
 *
 * Also caches, per contact:
 *  - the peer's derived Ed25519 SIGNING public key, so a restored session can
 *    verify signed messages immediately instead of dropping them (#3), and
 *  - the encrypted-at-rest ratchet state (chain keys + counters), so a
 *    restored session RESUMES where it left off rather than resetting the recv
 *    counter to 0 — which would both throw away forward secrecy and let a
 *    replayed key-exchange offer roll the ratchet back so captured ciphertexts
 *    decrypt again (#3, #10).
 */

import { isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';
import { upsertContact } from '@/lib/db/relay-store';
import type { SerializedSession } from '@/lib/crypto/relay-crypto';

// In-memory caches (populated from encrypted IndexedDB). These avoid async
// calls in hot paths while keeping keys out of plaintext localStorage.
const contactKeyCache = new Map<string, string>();
const contactPqKeyCache = new Map<string, string>(); // Cache for PQ public keys
const contactSigningKeyCache = new Map<string, string>(); // Ed25519 signing pubkeys
const ratchetStateCache = new Map<string, SerializedSession>(); // per-contact ratchet snapshot
// Last accepted resync request/response per contact — see resync.ts. Persisted
// (not just in-memory) so a captured resync control message can't be replayed
// even across an app restart: acceptance requires the incoming nonce+timestamp
// to strictly advance past whatever is recorded here.
const lastResyncRecordCache = new Map<string, { nonce: string; timestamp: number }>();

// Per-contact serialized write chain.
//
// relay-store.upsertContact is a read-modify-write (getContact → merge → put)
// with NO internal per-contact locking, and it cannot be changed from here.
// Two un-awaited upserts for the SAME contact fired back-to-back — e.g.
// saveContactPublicKey + saveRatchetState from key-exchange — therefore race:
// both read the same base row and last-writer-wins silently DROPS the other's
// fields. Dropping ratchetState re-opens the counter-reset/replay window (#3,
// #10); dropping the keys loses the signing/PQ material. Chaining every write
// for a relayId onto a single promise serializes them so each upsert observes
// the previous one's result and merges cleanly instead of clobbering it.
const contactWriteChains = new Map<string, Promise<unknown>>();
// Test-only escape hatch so tests can deterministically wait for pending
// fire-and-forget writes to land instead of guessing at a delay. Not for
// production use.
export const __contactWriteChainsForTests = contactWriteChains;

function enqueueContactWrite(contactRelayId: string, updates: Record<string, unknown>): void {
  const prev = contactWriteChains.get(contactRelayId) ?? Promise.resolve();
  const next = prev
    // Isolate a failed prior write so the chain keeps draining; storage may not
    // be ready yet — stay best-effort exactly like the previous fire-and-forget.
    .catch(() => {})
    .then(() => upsertContact(contactRelayId, updates as any))
    .catch(() => {});
  contactWriteChains.set(contactRelayId, next);
  // Bound Map growth: once this write settles, drop the entry if it is still the
  // tail (no newer write chained on in the meantime).
  next.then(() => {
    if (contactWriteChains.get(contactRelayId) === next) {
      contactWriteChains.delete(contactRelayId);
    }
  });
}

export function saveContactPublicKey(
  contactRelayId: string,
  publicKeyHex: string,
  pqPublicKeyHex?: string,
  signingPublicKeyHex?: string
): void {
  // Update in-memory caches immediately
  contactKeyCache.set(contactRelayId, publicKeyHex);
  if (pqPublicKeyHex) {
    contactPqKeyCache.set(contactRelayId, pqPublicKeyHex);
  }
  if (signingPublicKeyHex) {
    contactSigningKeyCache.set(contactRelayId, signingPublicKeyHex);
  }

  // Ghost contacts never touch disk — the in-memory cache above is enough to
  // keep messaging working for the rest of this session.
  if (isEphemeralContact(contactRelayId)) return;

  // Persist to encrypted IndexedDB (fire-and-forget; storage may not be ready yet).
  // `signingPublicKeyHex` rides along in the encrypted contact blob so it is
  // available on the next restore (StoredContact hasn't declared the field yet —
  // see followUp — so it is written/read through an `any` view).
  const contactData: any = { publicKeyHex };
  if (pqPublicKeyHex) {
    contactData.pqPublicKeyHex = pqPublicKeyHex;
  }
  if (signingPublicKeyHex) {
    contactData.signingPublicKeyHex = signingPublicKeyHex;
  }
  enqueueContactWrite(contactRelayId, contactData);
}

/**
 * Cache a peer's public keys learned from a profile-directory lookup —
 * in-memory ONLY, deliberately never persisted to IndexedDB (unlike
 * saveContactPublicKey). This is called from a profile lookup, which can
 * happen for ANY relayId (search results, display-name resolution for a
 * message from someone not yet added, etc.) — persisting via
 * upsertContact() would silently create a real contact row (it requires a
 * publicKeyHex and fabricates one if the row doesn't exist yet) for people
 * who were merely looked up, never actually added, polluting the contacts
 * list. The in-memory cache alone is enough to close the first-contact PQ
 * downgrade gap (see username-lookup.ts's seedContactKeysFromProfile) for
 * the current session; if/when this relayId is added as a real contact
 * through the normal add-contact flow, that flow persists properly.
 */
export function cacheContactKeysFromDirectory(
  contactRelayId: string,
  publicKeyHex: string,
  pqPublicKeyHex?: string
): void {
  // Never overwrite an already-established relationship — the wire-based
  // key-exchange flow is authoritative once a key is known (from IndexedDB
  // restore or a real exchange this session); this path only fills in the
  // true first-contact gap, before anything else has been learned.
  if (contactKeyCache.has(contactRelayId)) return;
  contactKeyCache.set(contactRelayId, publicKeyHex);
  if (pqPublicKeyHex) {
    contactPqKeyCache.set(contactRelayId, pqPublicKeyHex);
  }
}

export function loadContactPublicKey(contactRelayId: string): string | null {
  return contactKeyCache.get(contactRelayId) || null;
}

export function loadContactPqPublicKey(contactRelayId: string): string | null {
  return contactPqKeyCache.get(contactRelayId) || null;
}

export function loadContactSigningPublicKey(contactRelayId: string): string | null {
  return contactSigningKeyCache.get(contactRelayId) || null;
}

export function loadAllContactPublicKeys(): Record<string, string> {
  return Object.fromEntries(contactKeyCache);
}

/**
 * Persist a session's ratchet snapshot (see Session.serialize). Kept in a sync
 * in-memory cache for the restore hot path AND written to encrypted-at-rest
 * IndexedDB (non-ghost contacts only — a ghost contact must never leave a trace
 * on disk). Fire-and-forget: an in-flight storage failure still leaves the
 * in-memory snapshot usable for the rest of the session.
 */
export function saveRatchetState(contactRelayId: string, state: SerializedSession): void {
  ratchetStateCache.set(contactRelayId, state);
  if (isEphemeralContact(contactRelayId)) return;
  // Stored under an undeclared StoredContact field (see followUp) — the DB
  // layer persists it as opaque encrypted JSON regardless of the TS type.
  //
  // Carry the known public key along: for a brand-new (inbound-first-contact)
  // peer the ratchet snapshot can be the FIRST write to reach relay-store, and
  // upsertContact throws "publicKeyHex is required when creating a new contact"
  // if it is absent — a throw that was silently swallowed, leaving the fresh
  // session's ratchet un-persisted so the next reload rebuilt from counter 0
  // and re-opened the replay window (#3, #10). On an existing row upsertContact
  // preserves the stored key and ignores this field, so it is a harmless no-op.
  const updates: Record<string, unknown> = { ratchetState: state };
  const knownKey = contactKeyCache.get(contactRelayId);
  if (knownKey) updates.publicKeyHex = knownKey;
  enqueueContactWrite(contactRelayId, updates);
}

/** Load a persisted ratchet snapshot (sync, from cache) — null if none. */
export function loadRatchetState(contactRelayId: string): SerializedSession | null {
  return ratchetStateCache.get(contactRelayId) || null;
}

/**
 * Drop any cached ratchet state for a contact (e.g. after a verified key
 * rotation). Must clear the PERSISTED copy too, not just the in-memory
 * cache — found during an adversarial design review for a not-yet-built
 * resync feature that would have depended on this: this function had zero
 * callers before that review and was never exercised, so this bug was
 * latent. Without the persisted clear, hydrateContactKeyCache() (called on
 * every app start/reload) reads the still-present stale ratchetState back
 * off IndexedDB and resurrects it into ratchetStateCache, silently undoing
 * the clear the moment the page reloads.
 */
export function clearRatchetState(contactRelayId: string): void {
  ratchetStateCache.delete(contactRelayId);
  if (isEphemeralContact(contactRelayId)) return;
  enqueueContactWrite(contactRelayId, { ratchetState: null });
}

/**
 * Persist the (nonce, timestamp) of the most recently ACCEPTED resync
 * request/response for a contact — see resync.ts's freshness/replay check.
 * Same in-memory + fire-and-forget encrypted-IndexedDB pattern as
 * saveRatchetState.
 */
export function saveLastResyncRecord(contactRelayId: string, record: { nonce: string; timestamp: number }): void {
  lastResyncRecordCache.set(contactRelayId, record);
  if (isEphemeralContact(contactRelayId)) return;
  const updates: Record<string, unknown> = { lastResyncRecord: record };
  const knownKey = contactKeyCache.get(contactRelayId);
  if (knownKey) updates.publicKeyHex = knownKey;
  enqueueContactWrite(contactRelayId, updates);
}

/** Load the persisted last-accepted-resync record (sync, from cache) — null if none. */
export function loadLastResyncRecord(contactRelayId: string): { nonce: string; timestamp: number } | null {
  return lastResyncRecordCache.get(contactRelayId) || null;
}

/** Hydrate the in-memory caches from encrypted IndexedDB. Call once after storage init. */
export async function hydrateContactKeyCache(): Promise<void> {
  try {
    const { getAllContacts } = await import('@/lib/db/relay-store');
    const contacts = await getAllContacts();
    for (const c of contacts) {
      if (c.relayId && c.publicKeyHex) {
        contactKeyCache.set(c.relayId, c.publicKeyHex);
      }
      if (c.relayId && c.pqPublicKeyHex) {
        contactPqKeyCache.set(c.relayId, c.pqPublicKeyHex);
      }
      // signingPublicKeyHex / ratchetState are persisted through an `any` view
      // (not yet on the StoredContact type — followUp), so read them the same way.
      const signing = (c as any).signingPublicKeyHex as string | undefined;
      if (c.relayId && signing) {
        contactSigningKeyCache.set(c.relayId, signing);
      }
      const ratchet = (c as any).ratchetState as SerializedSession | undefined;
      if (c.relayId && ratchet && typeof ratchet === 'object') {
        ratchetStateCache.set(c.relayId, ratchet);
      }
      const lastResync = (c as any).lastResyncRecord as { nonce: string; timestamp: number } | undefined;
      if (c.relayId && lastResync && typeof lastResync === 'object') {
        lastResyncRecordCache.set(c.relayId, lastResync);
      }
    }
  } catch { /* storage may not be ready yet */ }
}
