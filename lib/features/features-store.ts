/**
 * Extended Relay Store Layer - Features Integration
 *
 * Extends relay-store.ts with encrypted IndexedDB storage for feature data
 * that doesn't fit the main contact/message schema. Trimmed to what's
 * actually live — this used to also hold CRUD for editable messages,
 * disappearing-message settings, per-group records, voice messages, a
 * settings blob, presence status, and contact requests, none of which had
 * any real writer anywhere in the app (each of those features was rebuilt
 * elsewhere as its own small module — see the deleted lib/features/*.ts
 * files' git history for what superseded them). Only safety numbers
 * (MITM-detection key fingerprints) are genuinely read/written through here.
 */

import { set, get } from 'idb-keyval';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

import type { SafetyNumber } from './safety-numbers';

let storageKey: Uint8Array | null = null;

export function initFeaturesStorage(key: Uint8Array): void {
  storageKey = key;
}

function ensureStorageKey(): void {
  if (!storageKey) {
    throw new Error('Features storage not initialized. Call initFeaturesStorage() first.');
  }
}

async function encryptValue(value: Uint8Array): Promise<Uint8Array> {
  ensureStorageKey();
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const cipher = chacha20poly1305(storageKey!, nonce);
  const ctWithTag = cipher.encrypt(value);
  const result = new Uint8Array(12 + ctWithTag.length);
  result.set(nonce);
  result.set(ctWithTag, 12);
  return result;
}

async function decryptValue(encryptedData: Uint8Array): Promise<Uint8Array> {
  ensureStorageKey();
  if (encryptedData.length < 28) {
    throw new Error(`Invalid encrypted data: too short (${encryptedData.length} bytes)`);
  }
  const nonce = encryptedData.slice(0, 12);
  const ctWithTag = encryptedData.slice(12);
  const cipher = chacha20poly1305(storageKey!, nonce);
  const plaintext = cipher.decrypt(ctWithTag);
  if (!plaintext) {
    throw new Error('Decryption failed: authentication tag mismatch');
  }
  return plaintext;
}

// ─────────────────────────────────────────────────────────────────────────
// SAFETY NUMBERS
// ─────────────────────────────────────────────────────────────────────────

export async function storeSafetyNumber(safety: SafetyNumber): Promise<void> {
  const json = JSON.stringify(safety);
  const data = new TextEncoder().encode(json);
  const encrypted = await encryptValue(data);
  const key = `safety:${safety.contactRelayId}`;
  await set(key, encrypted);
}

export async function getSafetyNumber(contactRelayId: string): Promise<SafetyNumber | null> {
  const key = `safety:${contactRelayId}`;
  const encrypted = await get(key);
  if (!encrypted) return null;
  const decrypted = await decryptValue(encrypted as Uint8Array);
  const json = new TextDecoder().decode(decrypted);
  return JSON.parse(json) as SafetyNumber;
}
