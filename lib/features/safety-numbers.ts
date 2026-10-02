/**
 * Feature 8: SAFETY NUMBERS
 * 
 * Safety number = first 30 bytes of SHA-256(myPublicKey || theirPublicKey)
 * sorted by relayId alphabetically
 * 
 * Display as:
 * - 12 BIP39 words (deterministic encoding)
 * - QR code for in-person scanning
 * - 5 groups of 6 digits for voice verification
 * 
 * In conversation header: "Verify safety numbers"
 * If safety numbers change: show warning banner
 */

import { sha256 } from '@noble/hashes/sha2.js';
import * as bip39 from 'bip39';
import { fromHex, toHex } from '@/lib/crypto/hex-utils';

export interface SafetyNumber {
  relayId: string;
  contactRelayId: string;
  hashHex: string; // first 30 bytes of SHA256
  words12: string[]; // BIP39 words
  digits: string; // 5 groups of 6: "123456 234567 345678 456789 567890"
  qrData: string; // QR code data (the hash itself)
  verified: boolean; // user confirmed match
  verifiedAt?: number;
  previousHash?: string; // if changed, store old hash to show warning
}

/**
 * Compute safety number from two public keys
 * Ensures both sides compute the same value regardless of key order
 */
export function computeSafetyNumber(
  myPublicKeyHex: string,
  theirPublicKeyHex: string,
  myRelayId: string,
  theirRelayId: string,
): string {
  // Sort by relayId to ensure consistent ordering
  const [id1, key1, id2, key2] = myRelayId < theirRelayId
    ? [myRelayId, myPublicKeyHex, theirRelayId, theirPublicKeyHex]
    : [theirRelayId, theirPublicKeyHex, myRelayId, myPublicKeyHex];

  // Concatenate keys in sorted order
  const combined = new TextEncoder().encode(key1 + key2);

  // SHA256 hash
  const hash = sha256(combined);

  // Take first 30 bytes
  const truncated = hash.slice(0, 30);

  // Return as hex string
  return toHex(truncated);
}

/**
 * Convert the safety-number hash to 12 BIP39 words.
 *
 * BIP39 word count is entropy-bits/32 + 3 bits of checksum per 32,
 * i.e. exactly 12 words needs 128 bits (16 bytes) of entropy, not a
 * multiple-of-32 padding of the full 240-bit hash (that produces 256 bits
 * -> 24 words) — found via a previously-nonexistent test: this function's
 * own name, doc comment, and every caller (SafetyNumberModal's UI copy,
 * formatSafetyNumberFull/Short below) all assumed 12, but it silently
 * returned 24. 128 bits of a well-distributed hash is already far beyond
 * what a manual, out-of-band comparison needs to be practically
 * unbruteforceable for this purpose (an attacker needs a colliding value
 * that is ALSO a valid keypair for the specific relayId being verified,
 * not just any 128-bit collision) — matches the security margin other
 * safety-number implementations use for the human-verified portion.
 */
export function hashToWords12(hashHex: string): string[] {
  const bytes = fromHex(hashHex).slice(0, 16); // first 128 bits
  const mnemonic = bip39.entropyToMnemonic(toHex(bytes));
  return mnemonic.split(' ');
}

/**
 * Convert 30 bytes to 5 groups of 6 digits
 * 30 bytes * 8 bits = 240 bits
 * Each 6-digit group uses 20 bits (max 999999)
 */
export function hashToDigits(hashHex: string): string {
  const bytes = fromHex(hashHex);

  // Convert bytes to a big integer
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  // Extract 5 groups of 6 digits
  const groups: string[] = [];
  for (let i = 0; i < 5; i++) {
    const divisor = 1000000n;
    const group = Number(value % divisor);
    groups.unshift(group.toString().padStart(6, '0'));
    value = value / divisor;
  }

  return groups.join(' ');
}

/**
 * Create safety number object
 */
export function createSafetyNumber(
  myPublicKeyHex: string,
  theirPublicKeyHex: string,
  myRelayId: string,
  theirRelayId: string,
  previousHash?: string,
): SafetyNumber {
  const hashHex = computeSafetyNumber(myPublicKeyHex, theirPublicKeyHex, myRelayId, theirRelayId);
  const words12 = hashToWords12(hashHex);
  const digits = hashToDigits(hashHex);

  return {
    relayId: myRelayId,
    contactRelayId: theirRelayId,
    hashHex,
    words12,
    digits,
    qrData: hashHex, // QR encodes the hex hash
    verified: false,
    previousHash,
  };
}

/**
 * Mark safety number as verified
 */
export function verifySafetyNumber(safetyNumber: SafetyNumber): SafetyNumber {
  return {
    ...safetyNumber,
    verified: true,
    verifiedAt: Date.now(),
  };
}

/**
 * Check if safety number has changed
 * This would indicate a possible MITM
 */
export function hasSafetyNumberChanged(safetyNumber: SafetyNumber): boolean {
  return safetyNumber.previousHash !== undefined && safetyNumber.previousHash !== safetyNumber.hashHex;
}

/**
 * Format safety number for display in small spaces
 * Shows first 3 words + last 3 words
 */
export function formatSafetyNumberShort(safetyNumber: SafetyNumber): string {
  const first3 = safetyNumber.words12.slice(0, 3).join(' ');
  const last3 = safetyNumber.words12.slice(-3).join(' ');
  return `${first3}\n...\n${last3}`;
}

/**
 * Format all 12 words for verification dialog
 */
export function formatSafetyNumberFull(safetyNumber: SafetyNumber): string {
  return safetyNumber.words12.join('\n');
}

/**
 * Format digits for voice verification
 * Show as "123456 234567 345678 456789 567890"
 */
export function formatSafetyNumberDigits(safetyNumber: SafetyNumber): string {
  return safetyNumber.digits;
}

