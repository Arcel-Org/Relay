/**
 * Server-side encryption for the TOTP secret at rest.
 *
 * Login verifies the TOTP code server-side (required for compatibility with
 * standard authenticator apps like Google Authenticator/Authy, which cannot
 * participate in a client-side-only challenge scheme). That means the server
 * must hold something capable of producing a valid code — but it should not
 * be recoverable from a DB leak alone. Encrypting it with a key
 * that lives only in the environment (never written to the DB file) means an
 * attacker needs both the DB and TOTP_ENCRYPTION_KEY to forge a login.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Fail-closed by default: only 'development'/'test' (or unset, which the
// local dev/test tooling in this repo runs under) get the deterministic
// fallback key. Checking `NODE_ENV === 'production'` instead would silently
// hand out the same known all-zero key under 'staging', 'preview', or any
// other non-'production' value a real deployment might use — defeating the
// at-rest encryption this module exists to provide.
const DEV_LIKE_ENVS = new Set([undefined, 'development', 'test']);

function getKey(): Buffer {
  const hex = process.env.TOTP_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64 || !/^[0-9a-f]{64}$/i.test(hex)) {
    if (!DEV_LIKE_ENVS.has(process.env.NODE_ENV)) {
      throw new Error(
        'TOTP_ENCRYPTION_KEY environment variable is required and must be a 64-character hex string (32 random bytes)'
      );
    }
    // Deterministic dev-only key so local dev works without config.
    return Buffer.from('0'.repeat(64), 'hex');
  }
  return Buffer.from(hex, 'hex');
}

/** Encrypts raw secret bytes for storage. Output is hex(iv | ciphertext | authTag). */
export function encryptServerSecret(plaintext: Uint8Array): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  // Explicit authTagLength, matching AUTH_TAG_LENGTH below — Node defaults
  // GCM to a 16-byte tag already (so this doesn't change behavior today),
  // but pinning it explicitly means a future Node default change can't
  // silently shrink the tag this module's own decrypt side assumes.
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString('hex');
}

/** Decrypts a value produced by encryptServerSecret. Throws if the key or ciphertext is wrong/corrupted. */
export function decryptServerSecret(hex: string): Buffer {
  const key = getKey();
  const data = Buffer.from(hex, 'hex');
  if (data.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short');
  }
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
