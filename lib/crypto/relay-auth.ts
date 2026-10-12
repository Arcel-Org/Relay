/**
 * Relay - Cryptographic identity system
 * Implements X25519 keypair generation, TOTP derivation, and encrypted storage
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { log } from '@/lib/platform/logger';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { relayIdFromPublicKey } from './relay-id';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { managedNonce } from '@noble/ciphers/utils.js';

// `@noble/ciphers/simple` (encrypt/decrypt helpers) was removed in @noble/ciphers v2.
// managedNonce(xchacha20poly1305) reproduces the exact same behavior: a random
// 24-byte XChaCha20-Poly1305 nonce is generated, the message is encrypted, and the
// nonce is prepended to the ciphertext — byte-for-byte identical wire format to the
// old `simple.encrypt`/`simple.decrypt`, so previously-encrypted data still decrypts.
const managedXChaCha = managedNonce(xchacha20poly1305);
const chachaEncrypt = (key: Uint8Array, plaintext: Uint8Array) => managedXChaCha(key).encrypt(plaintext);
const chachaDecrypt = (key: Uint8Array, ciphertext: Uint8Array) => managedXChaCha(key).decrypt(ciphertext);
import { TOTP, Secret } from 'otpauth';
import * as bip39 from 'bip39';
import { generateHybridKeypair } from '@/lib/crypto/relay-crypto';

// Encryption key length for ChaCha20-Poly1305

// Types
export interface RelayIdentity {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  relayId: string;
  mnemonicWords: string[];
  // Post-quantum cryptography (optional for backward compat)
  pqPrivateKey?: Uint8Array;
  pqPublicKey?: Uint8Array;
}

export interface StoredIdentity {
  encryptedPrivateKey: Uint8Array;
  publicKey: Uint8Array;
  relayId: string;
  version: number;
  // Post-quantum private key, PIN-encrypted the same way as encryptedPrivateKey.
  encryptedPqPrivateKey?: Uint8Array;
  // TOTP secret, PIN-encrypted for local storage hygiene. Never decrypted for
  // use — the app always recomputes it from the decrypted privateKey instead.
  encryptedTOTPSecretLocal?: Uint8Array;
}

// Constants
const AUTH_VERSION = 1;
const SALT_TOTP = new TextEncoder().encode('relay-auth-v1'); // derivation salt — change only in lockstep across deploy (breaks TOTP for pre-change accounts)
const INFO_TOTP = new TextEncoder().encode('totp');
const SALT_STORAGE = new TextEncoder().encode('storage-v1');
const SALT_RECOVERY = new TextEncoder().encode('recovery-v1');
const SALT_DURESS = new TextEncoder().encode('duress-v1');

// PBKDF2-HMAC-SHA256 iteration count for PIN-derived keys (storage + duress).
// OWASP Password Storage Cheat Sheet (2024) recommends >=600,000 for SHA-256.
// This is a KDF parameter baked into every derived key: changing it is a
// BREAKING change for identities derived with the old count (their PIN will
// no longer unlock them). Safe to change only while pre-release / before real
// users exist. Stored here as a single constant; 200k was the original bar,
// raised to 600k to match current OWASP guidance.
const PBKDF2_ITERATIONS = 600_000;
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_LENGTH = 20;

/**
 * Generate a new X25519 keypair and Relay identity
 */
export async function generateRelayIdentity(): Promise<RelayIdentity> {
  // Generate hybrid keypair (X25519 + ML-KEM768)
  const hybrid = generateHybridKeypair();

  // Derive Relay ID from X25519 public key hash (classical key for backward compat)
  const relayId = relayIdFromPublicKey(hybrid.classicalPublic);

  // Generate 12-word mnemonic (BIP39 requires 128 bits / 16 bytes for 12 words)
  const fullEntropy = sha256(hybrid.classicalPrivate);
  const entropy128 = fullEntropy.slice(0, 16); // Take first 16 bytes (128 bits)
  const mnemonicWords = bip39.entropyToMnemonic(bytesToHex(entropy128)).split(' ');

  return {
    privateKey: hybrid.classicalPrivate,
    publicKey: hybrid.classicalPublic,
    relayId,
    mnemonicWords,
    pqPrivateKey: hybrid.pqPrivate,
    pqPublicKey: hybrid.pqPublic,
  };
}

/**
 * Derive TOTP secret from private key
 * IMPORTANT: The TOTP secret is derived deterministically from the private key
 * This means TOTP codes are cryptographically bound to your keypair
 */
export function deriveTOTPSecret(privateKey: Uint8Array): Uint8Array {
  const totpSecret = hkdf(sha256, privateKey, SALT_TOTP, INFO_TOTP, TOTP_LENGTH);
  return totpSecret;
}

/**
 * Create a TOTP instance from private key
 */
export function createTOTPFromKey(privateKey: Uint8Array): TOTP {
  const totpSecret = deriveTOTPSecret(privateKey);
  // Convert to base32 for TOTP (otpauth expects base32)
  const base32Secret = toBase32(totpSecret);

  return new TOTP({
    secret: base32Secret,
    period: TOTP_PERIOD,
    digits: TOTP_DIGITS,
    algorithm: 'SHA1',
  });
}

/**
 * Create a TOTP instance directly from an already-derived TOTP secret
 * (without deriving it again)
 */
export function createTOTPFromSecret(totpSecret: Uint8Array): TOTP {
  // Convert to base32 for TOTP (otpauth expects base32)
  const base32Secret = toBase32(totpSecret);

  return new TOTP({
    secret: Secret.fromBase32(base32Secret),
    period: TOTP_PERIOD,
    digits: TOTP_DIGITS,
    algorithm: 'SHA1',
  });
}

/**
 * Get current TOTP code
 */
export function getCurrentTOTPCode(totp: TOTP): string {
  return totp.generate();
}

/**
 * Get time remaining until next TOTP code (in seconds)
 */
export function getTimeUntilNextTOTP(): number {
  const now = Date.now();
  const secondsIntoCurrentWindow = (Math.floor(now / 1000) % TOTP_PERIOD);
  return TOTP_PERIOD - secondsIntoCurrentWindow;
}

/**
 * Verify TOTP code with time window tolerance
 * Accepts codes from current and previous 30-second window
 * This handles clock skew between client and server (~60 second tolerance)
 */
export function verifyTOTPCode(totp: TOTP, enteredCode: string): boolean {
  const currentCode = totp.generate();

  // Check current window
  if (constantTimeHexEqual(enteredCode, currentCode)) {
    return true;
  }

  // Also accept previous window for clock skew tolerance
  // This is standard TOTP behavior per RFC 6238
  const now = Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / TOTP_PERIOD);
  const previousCounter = counter - 1;
  
  // Get secret bytes from Secret object
  const secretBytes = totp.secret.bytes as Uint8Array;
  
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  view.setBigInt64(0, BigInt(previousCounter), false);
  
  const hmacResult = hmac(sha1, secretBytes, new Uint8Array(counterBytes));
  const offset = hmacResult[hmacResult.length - 1] & 0x0f;
  const code =
    ((hmacResult[offset] & 0x7f) << 24 |
      (hmacResult[offset + 1] & 0xff) << 16 |
      (hmacResult[offset + 2] & 0xff) << 8 |
      (hmacResult[offset + 3] & 0xff)) %
    Math.pow(10, TOTP_DIGITS);
  
  const previousCode = String(code).padStart(TOTP_DIGITS, '0');
  
  if (constantTimeHexEqual(enteredCode, previousCode)) {
    return true;
  }

  return false;
}

/**
 * Derive storage encryption key from PIN and device fingerprint.
 *
 * Uses PBKDF2-SHA256 with 600,000 iterations to make offline brute-force of
 * the 6-digit PIN infeasible even when an attacker has both the
 * encryptedPrivateKey and the deviceFingerprint from IndexedDB.
 * At ~100ms per guess, exhausting 10^6 PINs takes ~28 hours per attacker core.
 *
 * BREAKING CHANGE: callers must await this function.
 */
export async function deriveStorageKey(pin: string, deviceFingerprint: string): Promise<Uint8Array> {
  const pinBytes = new TextEncoder().encode(pin);
  // Combine device fingerprint + SALT_STORAGE as the PBKDF2 salt so that the
  // derived key is device-bound and domain-separated from other uses.
  const enc = new TextEncoder();
  const saltBase = new Uint8Array([...enc.encode(deviceFingerprint), ...SALT_STORAGE]);
  return pbkdf2Async(sha256, pinBytes, saltBase, { c: PBKDF2_ITERATIONS, dkLen: 32 });
}

/**
 * Duress PIN: a second PIN that, when entered at login, silently wipes the
 * local identity and all local data instead of unlocking it — the UI shows
 * the same "incorrect PIN" result as a genuine wrong guess, so someone
 * coercing the user to unlock has no way to tell a duress-wipe happened.
 *
 * Same PBKDF2-SHA256/600k construction as the real storage key, but domain
 * separated (SALT_DURESS) so the duress hash can't be derived from or
 * confused with the real PIN's storage key.
 */
export async function hashDuressPin(pin: string, deviceFingerprint: string): Promise<string> {
  const pinBytes = new TextEncoder().encode(pin);
  const enc = new TextEncoder();
  const saltBase = new Uint8Array([...enc.encode(deviceFingerprint), ...SALT_DURESS]);
  const hash = await pbkdf2Async(sha256, pinBytes, saltBase, { c: PBKDF2_ITERATIONS, dkLen: 32 });
  return bytesToHex(hash);
}

/** Constant-time comparison of two equal-length strings (hex, digits, etc). */
export function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyDuressPin(
  pin: string,
  deviceFingerprint: string,
  storedHashHex: string
): Promise<boolean> {
  const hash = await hashDuressPin(pin, deviceFingerprint);
  return constantTimeHexEqual(hash, storedHashHex);
}

/**
 * Derive recovery encryption key from recovery code
 * Used to encrypt TOTP secret for account recovery without PIN
 */
export function deriveRecoveryKey(recoveryCode: string): Uint8Array {
  const recoveryBytes = new TextEncoder().encode(recoveryCode.trim().replace(/[-\s]/g, '').toUpperCase());
  const recoveryKey = hkdf(sha256, recoveryBytes, new Uint8Array([]), SALT_RECOVERY, 32);
  return recoveryKey;
}

/**
 * Encrypt TOTP secret with recovery code
 * Allows TOTP verification during recovery login without PIN/private key
 */
export function encryptTOTPSecretForRecovery(
  totpSecret: Uint8Array,
  recoveryCode: string
): Uint8Array {
  const recoveryKey = deriveRecoveryKey(recoveryCode);
  return chachaEncrypt(recoveryKey, totpSecret);
}

/**
 * Decrypt TOTP secret using recovery code
 * Returns the decrypted TOTP secret for verification
 */
export function decryptTOTPSecretForRecovery(
  encryptedTOTPSecret: Uint8Array,
  recoveryCode: string
): Uint8Array {
  try {
    const recoveryKey = deriveRecoveryKey(recoveryCode);
    return chachaDecrypt(recoveryKey, encryptedTOTPSecret);
  } catch (error) {
    throw new Error('Decryption failed - invalid recovery code or corrupted TOTP data');
  }
}

/**
 * Verify TOTP code during recovery using recovery code to decrypt TOTP secret
 */
export function verifyTOTPForRecovery(
  encryptedTOTPSecretHex: string,
  recoveryCode: string,
  enteredTOTPCode: string
): boolean {
  try {
    const encryptedTOTPSecret = hexToBytes(encryptedTOTPSecretHex);
    const totpSecret = decryptTOTPSecretForRecovery(encryptedTOTPSecret, recoveryCode);
    const totp = createTOTPFromSecret(totpSecret);
    return verifyTOTPCode(totp, enteredTOTPCode);
  } catch (error) {
    log.error('TOTP recovery verification failed:', error);
    return false;
  }
}

const DEVICE_TOKEN_KEY = 'relay:device-token';

/**
 * Get or create a persistent random device token stored in localStorage.
 * This makes the PIN-derived storage key infeasible to brute-force even
 * when the attacker knows the user's UA and screen dimensions.
 */
function getOrCreateDeviceToken(): string {
  const existing = localStorage.getItem(DEVICE_TOKEN_KEY);
  if (existing) return existing;
  // First call on this device — generate a 32-byte random token.
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...tokenBytes));
  localStorage.setItem(DEVICE_TOKEN_KEY, token);
  // Two concurrent first-callers (e.g. two tabs opening at once) can each
  // read `existing` as null and each generate a DIFFERENT token; whichever
  // setItem() runs last wins in localStorage. Re-reading after our own
  // write means every caller ends up returning the SAME final value
  // instead of some callers walking away with a token that was never
  // actually persisted — a mismatch here silently breaks the PIN-derived
  // storage key on whichever tab lost the race.
  return localStorage.getItem(DEVICE_TOKEN_KEY) ?? token;
}

/**
 * Get device fingerprint: UA + screen dimensions + persistent random device token.
 * Must be called on client side only.
 * Warning: clearing localStorage will invalidate the device token and make
 * any PIN-encrypted keys on this device permanently unrecoverable.
 */
export function getDeviceFingerprint(): string {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    throw new Error('Device fingerprint unavailable - this function must be called in browser context');
  }
  const ua = navigator.userAgent;
  const width = window.screen.width;
  const height = window.screen.height;
  const token = getOrCreateDeviceToken();
  return `${ua}:${width}x${height}:${token}`;
}

/**
 * Encrypt private key using AES-256-GCM from Web Crypto API
 */
export async function encryptPrivateKey(
  privateKey: Uint8Array,
  storageKey: Uint8Array
): Promise<Uint8Array> {
  // Use ChaCha20-Poly1305 with automatic nonce handling
  // The nonce is prepended to the ciphertext
  return chachaEncrypt(storageKey, privateKey);
}

/**
 * Decrypt private key using ChaCha20-Poly1305
 */
export async function decryptPrivateKey(
  encryptedData: Uint8Array,
  storageKey: Uint8Array
): Promise<Uint8Array> {
  // Use ChaCha20-Poly1305 with automatic nonce handling
  // The nonce is extracted from the ciphertext
  try {
    return chachaDecrypt(storageKey, encryptedData);
  } catch (error) {
    throw new Error('Decryption failed - invalid PIN or corrupted data');
  }
}

/**
 * Create a stored identity (encrypted + metadata)
 */
export async function createStoredIdentity(
  identity: RelayIdentity,
  pin: string,
  totpSecret?: Uint8Array
): Promise<StoredIdentity> {
  const deviceFingerprint = getDeviceFingerprint();
  const storageKey = await deriveStorageKey(pin, deviceFingerprint);

  const encryptedPrivateKey = await encryptPrivateKey(identity.privateKey, storageKey);
  const encryptedPqPrivateKey = identity.pqPrivateKey
    ? await encryptPrivateKey(identity.pqPrivateKey, storageKey)
    : undefined;
  const encryptedTOTPSecretLocal = totpSecret
    ? await encryptPrivateKey(totpSecret, storageKey)
    : undefined;

  return {
    encryptedPrivateKey,
    encryptedPqPrivateKey,
    encryptedTOTPSecretLocal,
    publicKey: identity.publicKey,
    relayId: identity.relayId,
    version: AUTH_VERSION,
  };
}

/**
 * Recover identity from stored data
 */
export async function recoverIdentity(
  storedIdentity: StoredIdentity,
  pin: string,
  deviceFingerprint?: string
): Promise<RelayIdentity> {
  // Use provided device fingerprint or get current one
  const fingerprint = deviceFingerprint || getDeviceFingerprint();
  const storageKey = await deriveStorageKey(pin, fingerprint);

  const privateKey = await decryptPrivateKey(storedIdentity.encryptedPrivateKey, storageKey);
  const pqPrivateKey = storedIdentity.encryptedPqPrivateKey
    ? await decryptPrivateKey(storedIdentity.encryptedPqPrivateKey, storageKey)
    : undefined;

  return {
    privateKey,
    publicKey: storedIdentity.publicKey,
    relayId: storedIdentity.relayId,
    mnemonicWords: [], // Not stored; recovered via backup
    pqPrivateKey,
  };
}

/**
 * Sign a challenge using ECDH (X25519)
 * Returns shared secret from ECDH with provided public key
 */
export function signChallenge(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  // X25519 ECDH
  const sharedSecret = x25519.scalarMult(privateKey, peerPublicKey);
  return sharedSecret;
}

/**
 * Verify PIN (by attempting decryption with different PIN)
 */
export async function verifyPIN(
  storedIdentity: StoredIdentity,
  pin: string,
  deviceFingerprint?: string
): Promise<boolean> {
  try {
    await recoverIdentity(storedIdentity, pin, deviceFingerprint);
    return true;
  } catch {
    return false;
  }
}

// --- Helper Functions ---

/**
 * Convert bytes to base32 (for TOTP)
 * RFC 4648 base32 alphabet
 */
export function toBase32(data: Uint8Array): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  let bits = 0;
  let value = 0;

  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i];
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += ALPHABET[(value >> bits) & 31];
    }
  }

  if (bits > 0) {
    result += ALPHABET[(value << (5 - bits)) & 31];
  }

  // Add padding
  while (result.length % 8 !== 0) {
    result += '=';
  }

  return result;
}


/**
 * Convert base32 string to bytes (for TOTP recovery)
 */
export function fromBase32(str: string): Uint8Array {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.replace(/=/g, '');

  let bits = 0;
  let value = 0;
  const result: number[] = [];

  for (let i = 0; i < str.length; i++) {
    const idx = ALPHABET.indexOf(str[i].toUpperCase());
    if (idx === -1) throw new Error('Invalid base32 character');

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      result.push((value >> bits) & 255);
    }
  }

  return new Uint8Array(result);
}
