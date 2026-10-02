/**
 * Group shared-key (epoch) encryption — the inner AEAD layer wrapped inside
 * the existing pairwise-session-encrypted fan-out (see use-group-messaging.ts).
 *
 * relay-crypto.ts's Session class always derives its encryption key from a
 * ratchet chain — there is no exported primitive for encrypting under an
 * arbitrary raw symmetric key, which is exactly what a shared GROUP key is
 * (there's no per-member ratchet chain to advance for it). This is a small,
 * standalone AEAD wrapper for exactly that case, using the same
 * ChaCha20-Poly1305 construction and 12-byte nonce size as everywhere else
 * in this codebase (relay-crypto.ts's Session, relay-store.ts's
 * encryptValue/decryptValue) — just with a fresh random nonce per call
 * instead of a ratchet-derived one, since there's no counter to derive it
 * from here.
 *
 * Wire format: nonce (12 bytes) || ciphertext+tag — identical layout to
 * relay-store.ts's encryptValue/decryptValue.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

const NONCE_SIZE = 12;
export const GROUP_KEY_SIZE = 32;

/** A fresh random 32-byte group epoch key. */
export function generateGroupKey(): Uint8Array {
  const key = new Uint8Array(GROUP_KEY_SIZE);
  crypto.getRandomValues(key);
  return key;
}

/**
 * AEAD-encrypt `plaintext` under `key`. `aad` should bind context that must
 * not be substitutable (groupId + epoch + senderRelayId — see callers) so a
 * ciphertext can't be replayed into a different group/epoch/sender context.
 */
export function encryptWithGroupKey(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(NONCE_SIZE);
  crypto.getRandomValues(nonce);
  const cipher = chacha20poly1305(key, nonce, aad);
  const ctWithTag = cipher.encrypt(plaintext);

  const result = new Uint8Array(NONCE_SIZE + ctWithTag.length);
  result.set(nonce);
  result.set(ctWithTag, NONCE_SIZE);
  return result;
}

/** Throws if `key`/`aad` don't match what `wire` was encrypted under, or if `wire` was tampered with. */
export function decryptWithGroupKey(key: Uint8Array, wire: Uint8Array, aad: Uint8Array): Uint8Array {
  if (wire.length < NONCE_SIZE + 16) {
    throw new Error(`decryptWithGroupKey: ciphertext too short (${wire.length} bytes)`);
  }
  const nonce = wire.slice(0, NONCE_SIZE);
  const ctWithTag = wire.slice(NONCE_SIZE);
  const cipher = chacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ctWithTag);
}

/** Canonical AAD binding for group-content AEAD — groupId + epoch + senderRelayId. */
export function buildGroupAad(groupId: string, epoch: number, senderRelayId: string): Uint8Array {
  return new TextEncoder().encode(`${groupId}:${epoch}:${senderRelayId}`);
}
