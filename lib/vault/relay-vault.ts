/**
 * Relay Vault - Optional Encrypted Cloud Backup
 * 
 * Completely optional. Default is OFF.
 * User explicitly enables it via Settings.
 * 
 * All data encrypted with keys derived from private key.
 * Vault server cannot read content.
 * 
 * Features:
 * - Opt-in cloud sync with explicit consent
 * - Auto-sync every 5 minutes when enabled
 * - Merge strategy: don't overwrite newer local data
 * - Delete vault data on demand
 */

import { hkdfDerive } from '@/lib/crypto/relay-crypto';
import { log } from '@/lib/platform/logger';
import {
  getAllContacts,
  getAllConversations,
  getAllMessagesForConversation,
  addContact,
  addConversation,
  addMessage,
  getContact,
  getConversation,
  getMessage,
} from '@/lib/db/relay-store';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import * as pako from 'pako';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

// ─────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────

// No hardcoded fallback — this used to default to an Arcel-controlled
// `vault.relay.app` with no dev/prod gate, meaning a self-hoster who never
// set NEXT_PUBLIC_VAULT_URL (it wasn't even documented in .env.example)
// could have their users' opt-in "encrypted cloud backup" silently synced
// to the ORIGINAL operator's server instead of the self-hoster's own
// infrastructure — the opposite of what a self-hosted deployment is for.
// enableVault() below refuses to activate at all without this explicitly
// configured, so every deployment (including the hosted one) must set it.
const VAULT_URL = process.env.NEXT_PUBLIC_VAULT_URL;

// ─────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────

interface VaultState {
  enabled: boolean;
  lastSyncAt: number | null;
  autoSyncIntervalId: NodeJS.Timeout | null;
}

const vaultState: VaultState = {
  enabled: false,
  lastSyncAt: null,
  autoSyncIntervalId: null,
};

// ─────────────────────────────────────────────────────────────────────────
// LOCAL STORAGE FOR VAULT SETTINGS
// ─────────────────────────────────────────────────────────────────────────

function loadVaultSettings(): VaultState {
  if (typeof window === 'undefined') return vaultState;

  const saved = localStorage.getItem('relay-vault-settings');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      vaultState.enabled = parsed.enabled ?? false;
      vaultState.lastSyncAt = parsed.lastSyncAt ?? null;
    } catch (e) {
      log.error('Failed to parse vault settings:', e);
    }
  }

  return vaultState;
}

function saveVaultSettings(): void {
  if (typeof window === 'undefined') return;

  localStorage.setItem(
    'relay-vault-settings',
    JSON.stringify({
      enabled: vaultState.enabled,
      lastSyncAt: vaultState.lastSyncAt,
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ENCRYPTION / DECRYPTION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Derive vault encryption key from private key
 */
function deriveVaultKey(privateKey: Uint8Array): Uint8Array {
  return hkdfDerive(
    privateKey,
    new Uint8Array(0),
    'vault-encryption-v1',
    32
  );
}

/**
 * Encrypt data for vault
 * Returns: nonce (12 bytes) + ciphertext + tag
 */
async function vaultEncrypt(
  data: Uint8Array,
  vaultKey: Uint8Array
): Promise<Uint8Array> {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const cipher = chacha20poly1305(vaultKey, nonce);
  const ctWithTag = cipher.encrypt(data);

  // Combine: nonce + ciphertext + tag
  const result = new Uint8Array(12 + ctWithTag.length);
  result.set(nonce);
  result.set(ctWithTag, 12);

  return result;
}

/**
 * Decrypt data from vault
 */
async function vaultDecrypt(
  encryptedData: Uint8Array,
  vaultKey: Uint8Array
): Promise<Uint8Array> {
  if (encryptedData.length < 28) {
    throw new Error('Encrypted data too short');
  }

  const nonce = encryptedData.slice(0, 12);
  const ctWithTag = encryptedData.slice(12);

  const cipher = chacha20poly1305(vaultKey, nonce);
  const plaintext = cipher.decrypt(ctWithTag);

  if (!plaintext) {
    throw new Error('Decryption failed: authentication tag mismatch');
  }

  return plaintext;
}

// ─────────────────────────────────────────────────────────────────────────
// AUTHENTICATION (HMAC-based, proves identity without revealing key)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Derive a vault-auth-only HMAC key from the identity private key via HKDF.
 * Never use the raw identity private key itself as an HMAC key — it's also
 * used for X25519 ECDH, and reusing one key across two different crypto
 * primitives is exactly the kind of mixing that leads to cross-protocol
 * attacks down the line. This key is scoped to nothing but vault auth.
 *
 * NOTE: changing this derivation (or the signed message below) is a
 * breaking protocol change for whatever service verifies X-Auth-Signature
 * at VAULT_URL — that verifier is not part of this repo and must be
 * updated to match before this ships against a real vault backend.
 */
function deriveVaultAuthKey(privateKey: Uint8Array): Uint8Array {
  return hkdfDerive(privateKey, new Uint8Array(0), 'vault-auth-v1', 32);
}

/**
 * Generate HMAC for authentication, binding the signature to the specific
 * method + path + timestamp being requested — not just the timestamp. A
 * timestamp-only signature is replayable against *any* endpoint (e.g. a
 * captured GET auth header could be replayed against DELETE) within its
 * freshness window; binding to method+path closes that off.
 */
function generateAuthHeader(privateKey: Uint8Array, method: string, path: string, timestamp: number): string {
  const authKey = deriveVaultAuthKey(privateKey);
  const message = new TextEncoder().encode(`${method}:${path}:${timestamp}`);
  const signature = hmac(sha256, authKey, message);
  return toHex(signature);
}

// ─────────────────────────────────────────────────────────────────────────
// SYNC TO VAULT
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sync local data to vault
 * POST to /sync with encrypted blob
 */
export async function syncToVault(privateKey: Uint8Array): Promise<void> {
  if (!vaultState.enabled) {
    throw new Error('Vault is not enabled');
  }
  // Defense in depth against a stale `enabled: true` persisted in
  // localStorage from before this deployment had VAULT_URL configured (or
  // from before this guard existed at all) — enableVault() refuses to set
  // this to begin with, but a value already persisted bypasses that.
  if (!VAULT_URL) {
    throw new Error('Vault sync is not configured on this deployment');
  }

  try {
    log.debug('[Vault] Syncing to vault...');

    // Gather all data
    const contacts = await getAllContacts();
    const conversations = await getAllConversations();
    const messages: Record<string, any[]> = {};

    for (const conv of conversations) {
      const msgs = await getAllMessagesForConversation(conv.id);
      // Keep last 500 messages per conversation
      messages[conv.id] = msgs.slice(-500);
    }

    // Build payload
    const payload = {
      version: 1,
      timestamp: Date.now(),
      contacts,
      conversations,
      messages,
    };

    // Serialize and compress
    const json = JSON.stringify(payload);
    const serialized = new TextEncoder().encode(json);
    const compressed = pako.deflateRaw(serialized);

    // Derive vault key and encrypt
    const vaultKey = deriveVaultKey(privateKey);
    const encryptedBlob = await vaultEncrypt(new Uint8Array(compressed), vaultKey);

    // Generate auth header
    const timestamp = Date.now();
    const authSignature = generateAuthHeader(privateKey, 'POST', '/sync', timestamp);

    // Send to vault
    const response = await fetch(`${VAULT_URL}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Auth-Signature': authSignature,
        'X-Timestamp': timestamp.toString(),
      },
      body: new Uint8Array(encryptedBlob) as unknown as BodyInit,
    });

    if (!response.ok) {
      throw new Error(`Vault sync failed: ${response.statusText}`);
    }

    vaultState.lastSyncAt = Date.now();
    saveVaultSettings();
    log.debug('[Vault] Sync complete');
  } catch (err) {
    log.error('Vault sync failed:', err);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SYNC FROM VAULT
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sync from vault (merge strategy)
 * GET from /sync, decrypt, merge with local data
 * Never overwrite newer local data
 */
export async function syncFromVault(privateKey: Uint8Array): Promise<void> {
  if (!vaultState.enabled) {
    throw new Error('Vault is not enabled');
  }
  // Defense in depth against a stale `enabled: true` persisted in
  // localStorage from before this deployment had VAULT_URL configured (or
  // from before this guard existed at all) — enableVault() refuses to set
  // this to begin with, but a value already persisted bypasses that.
  if (!VAULT_URL) {
    throw new Error('Vault sync is not configured on this deployment');
  }

  try {
    log.debug('[Vault] Syncing from vault...');

    // Generate auth header
    const timestamp = Date.now();
    const authSignature = generateAuthHeader(privateKey, 'GET', '/sync', timestamp);

    // Fetch from vault
    const response = await fetch(`${VAULT_URL}/sync`, {
      method: 'GET',
      headers: {
        'X-Auth-Signature': authSignature,
        'X-Timestamp': timestamp.toString(),
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        log.debug('[Vault] No vault data available yet');
        return;
      }
      throw new Error(`Vault sync failed: ${response.statusText}`);
    }

    const encryptedBlob = new Uint8Array(await response.arrayBuffer());

    // Derive vault key and decrypt
    const vaultKey = deriveVaultKey(privateKey);
    const compressed = await vaultDecrypt(encryptedBlob, vaultKey);

    // Decompress
    const decompressed = pako.inflateRaw(compressed);
    const json = new TextDecoder().decode(decompressed);
    const payload = JSON.parse(json);

    // Merge with local data. Local storage is IndexedDB (relay-store.ts),
    // not localStorage — a prior version checked localStorage here, which
    // never held these keys, so `existing` was always null and every sync
    // silently overwrote (or resurrected deleted) local data unconditionally.
    for (const contact of payload.contacts) {
      const existing = await getContact(contact.relayId);
      if (!existing || contact.addedAt > existing.addedAt) {
        await addContact(contact);
      }
    }

    for (const conversation of payload.conversations) {
      const existing = await getConversation(conversation.id);
      if (!existing || conversation.lastMessageAt > existing.lastMessageAt) {
        await addConversation(conversation);
      }
    }

    // Messages: merge, keeping higher timestamps
    for (const conversationId in payload.messages) {
      for (const message of payload.messages[conversationId]) {
        const existing = await getMessage(message.id);
        if (!existing || message.timestamp > existing.timestamp) {
          await addMessage(message);
        }
      }
    }

    vaultState.lastSyncAt = Date.now();
    saveVaultSettings();
    log.debug('[Vault] Sync from vault complete');
  } catch (err) {
    log.error('Vault sync failed:', err);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// VAULT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────

/**
 * Enable vault sync
 */
export async function enableVault(privateKey: Uint8Array): Promise<void> {
  if (!VAULT_URL) {
    throw new Error('Vault sync is not configured on this deployment (NEXT_PUBLIC_VAULT_URL is unset)');
  }
  vaultState.enabled = true;
  saveVaultSettings();
  log.debug('[Vault] Enabled');
}

/**
 * Disable vault sync
 */
export function disableVault(): void {
  vaultState.enabled = false;
  saveVaultSettings();

  if (vaultState.autoSyncIntervalId) {
    clearInterval(vaultState.autoSyncIntervalId);
    vaultState.autoSyncIntervalId = null;
  }

  log.debug('[Vault] Disabled');
}

/**
 * Start auto-sync
 */
export function startAutoSync(
  privateKey: Uint8Array,
  intervalMs: number = 5 * 60 * 1000
): void {
  if (!vaultState.enabled) return;

  if (vaultState.autoSyncIntervalId) {
    clearInterval(vaultState.autoSyncIntervalId);
  }

  vaultState.autoSyncIntervalId = setInterval(() => {
    if (vaultState.enabled) {
      syncToVault(privateKey).catch((err) =>
        log.error('Auto-sync to vault failed:', err)
      );
    }
  }, intervalMs);

  log.debug('[Vault] Auto-sync started');
}

/**
 * Stop auto-sync
 */
export function stopAutoSync(): void {
  if (vaultState.autoSyncIntervalId) {
    clearInterval(vaultState.autoSyncIntervalId);
    vaultState.autoSyncIntervalId = null;
  }

  log.debug('[Vault] Auto-sync stopped');
}

/**
 * Delete all vault data
 */
export async function deleteVaultData(privateKey: Uint8Array): Promise<void> {
  if (!VAULT_URL) {
    throw new Error('Vault sync is not configured on this deployment');
  }
  try {
    log.debug('[Vault] Deleting vault data...');

    // Generate auth header
    const timestamp = Date.now();
    const authSignature = generateAuthHeader(privateKey, 'DELETE', '/sync', timestamp);

    // Send DELETE request
    const response = await fetch(`${VAULT_URL}/sync`, {
      method: 'DELETE',
      headers: {
        'X-Auth-Signature': authSignature,
        'X-Timestamp': timestamp.toString(),
      },
    });

    if (!response.ok) {
      throw new Error(`Delete vault failed: ${response.statusText}`);
    }

    log.debug('[Vault] Vault data deleted');
  } catch (err) {
    log.error('Failed to delete vault data:', err);
    throw err;
  }
}

// Export aliases for settings page
export const pushToVault = syncToVault;
export const pullFromVault = syncFromVault;
export const deleteVault = deleteVaultData;

/**
 * Get vault state
 */
export function getVaultState(): VaultState {
  return loadVaultSettings();
}

/**
 * Get last sync time
 */
export async function getLastSyncTime(): Promise<number | null> {
  return loadVaultSettings().lastSyncAt;
}

/**
 * Is vault enabled?
 */
export async function isVaultEnabled(): Promise<boolean> {
  return loadVaultSettings().enabled;
}
