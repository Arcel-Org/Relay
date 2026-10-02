/**
 * Relay Encrypted Storage Layer
 * 
 * All data is encrypted with keys derived from the user's private key.
 * The relay server stores nothing. All persistence is client-side in IndexedDB.
 * 
 * Storage encryption:
 * - storageKey = HKDF(privateKey, "", "storage-v1", 32)
 * - All values: ChaCha20-Poly1305(value, storageKey)
 */

import { set, get, getMany, del, delMany, keys, clear } from 'idb-keyval';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { log } from '@/lib/platform/logger';
import * as pako from 'pako';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';

// ─────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────

export interface StoredMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  timestamp: number;
  status: 'sending' | 'delivered' | 'received' | 'error';
  isReaction?: boolean;
  reactionTo?: string;
  reactions?: Record<string, string[]>;
  expiresAt?: number;
  pinned?: boolean;
  pinnedAt?: number;
  /** True when sent in ghost-mode — filtered into the ghost thread view. */
  ghost?: boolean;
  /**
   * True once the recipient has viewed this message (own messages are
   * always true — see message-persistence.ts's persistMessage). Absent on
   * rows written before this field existed; loadConversationMessages
   * treats a missing value as already-read rather than resurrecting old
   * history as unread.
   */
  read?: boolean;
}

export interface StoredConversation {
  id: string;
  name: string;
  members: string[]; // array of relayIds
  createdAt: number;
  lastMessageAt: number;
  isGroup: boolean;
}

export interface StoredContact {
  relayId: string;
  name: string;
  displayName?: string;  // User-friendly name (can be edited)
  username?: string;     // Claimed username (@username)
  publicKeyHex: string;
  pqPublicKeyHex?: string; // ML-KEM768 public key for hybrid key exchange
  addedAt: number;
  lastSeenAt?: number;
}

export interface ExportBackupHeader {
  magic: Uint8Array; // [0x52, 0x45, 0x4c, 0x59] = "RELY"
  version: number;
  timestamp: number;
  encryptedPrivateKey: Uint8Array; // privateKey encrypted with exportKey
  nonce: Uint8Array; // 12 bytes for ChaCha20
  tag: Uint8Array; // 16 bytes Poly1305 tag
  encryptedData: Uint8Array; // compressed JSON blob encrypted
}

// ─────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────

let storageKey: Uint8Array | null = null;
let isStorageReady = false;

// In-memory read cache — avoids repeated decrypt for frequently accessed data
const readCache = new Map<string, { value: unknown; cachedAt: number }>();
const READ_CACHE_TTL_MS = 30_000; // 30 second TTL

function getCached<T>(key: string): T | undefined {
  const entry = readCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > READ_CACHE_TTL_MS) {
    readCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function setCache(key: string, value: unknown): void {
  readCache.set(key, { value, cachedAt: Date.now() });
}

function invalidateCache(key: string): void {
  readCache.delete(key);
}

function invalidateCachePrefix(prefix: string): void {
  for (const key of readCache.keys()) {
    if (key.startsWith(prefix)) readCache.delete(key);
  }
}

/**
 * Fetch and decrypt every value whose key starts with `prefix` in one batched
 * IndexedDB read (idb-keyval's getMany), instead of one get() per key.
 *
 * Each record is decrypted independently — a single undecryptable record
 * (e.g. left over from a different local identity on the same device,
 * which uses a different derived storage key) is skipped rather than
 * rejecting the whole batch. Without this, one bad record under this
 * prefix would make every other, perfectly valid record under the same
 * prefix disappear too (see e.g. hydrateContactKeyCache/loadContacts,
 * which call this via getAllContacts and would otherwise silently lose
 * all cached ratchet state / contacts on a decrypt failure elsewhere).
 */
async function getAllByPrefix<T>(prefix: string): Promise<T[]> {
  const allKeys = (await keys()).filter((k) => (k as string).startsWith(prefix));
  if (allKeys.length === 0) return [];

  const encryptedValues = await getMany(allKeys);
  const decoded: (T | null)[] = await Promise.all(
    encryptedValues.map(async (encrypted, i): Promise<T | null> => {
      if (!encrypted) return null;
      try {
        const decrypted = await decryptValue(encrypted as Uint8Array);
        const json = new TextDecoder().decode(decrypted);
        return JSON.parse(json) as T;
      } catch (err) {
        log.warn(`Skipping undecryptable record ${allKeys[i]}:`, err);
        return null;
      }
    })
  );
  return decoded.filter((v): v is T => v !== null);
}

// ─────────────────────────────────────────────────────────────────────────
// STORAGE INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Initialize storage encryption key from private key
 * Must be called before any read/write operations
 */
export async function initStorage(privateKeyBytes: Uint8Array): Promise<void> {
  try {
    if (privateKeyBytes.length === 0) {
      throw new Error('initStorage: privateKeyBytes is empty');
    }

    // Derive storage key: HKDF(privateKey, "", "storage-v1", 32)
    const salt = new Uint8Array(0);
    const info = new TextEncoder().encode('storage-v1');
    storageKey = hkdf(sha256, privateKeyBytes, salt, info, 32);

    isStorageReady = true;
  } catch (err) {
    log.error('Failed to initialize storage:', err);
    throw err;
  }
}

export function getStorageReady(): boolean {
  return isStorageReady;
}

// ─────────────────────────────────────────────────────────────────────────
// ENCRYPTION / DECRYPTION
// ─────────────────────────────────────────────────────────────────────────

function ensureStorageKey(): void {
  if (!storageKey) {
    throw new Error('Storage not initialized. Call initStorage() first.');
  }
}

/**
 * Encrypt a value for storage
 * Returns: nonce (12 bytes) + tag (16 bytes) + ciphertext
 */
async function encryptValue(value: Uint8Array): Promise<Uint8Array> {
  ensureStorageKey();

  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const cipher = chacha20poly1305(storageKey!, nonce);
  const ctWithTag = cipher.encrypt(value);

  // Combine: nonce + ciphertext + tag
  const result = new Uint8Array(12 + ctWithTag.length);
  result.set(nonce);
  result.set(ctWithTag, 12);

  return result;
}

/**
 * Decrypt a value from storage
 */
async function decryptValue(encryptedData: Uint8Array): Promise<Uint8Array> {
  ensureStorageKey();

  if (encryptedData.length < 28) {
    throw new Error(
      `Invalid encrypted data: too short (${encryptedData.length} bytes, need at least 28)`
    );
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
// CONVERSATION MESSAGE INDEX
// Stores an encrypted list of message IDs per conversation for O(1) lookups
// Key: `conv-msgs:${conversationId}` -> encrypted JSON array of message IDs
// ─────────────────────────────────────────────────────────────────────────

async function getConversationMessageIndex(conversationId: string): Promise<string[] | null> {
  const key = `conv-msgs:${conversationId}`;
  const encrypted = await get(key);
  if (!encrypted) return null;

  try {
    const decrypted = await decryptValue(encrypted as Uint8Array);
    const json = new TextDecoder().decode(decrypted);
    return JSON.parse(json) as string[];
  } catch {
    return null;
  }
}

async function setConversationMessageIndex(conversationId: string, messageIds: string[]): Promise<void> {
  const key = `conv-msgs:${conversationId}`;
  const json = JSON.stringify(messageIds);
  const data = new TextEncoder().encode(json);
  const encrypted = await encryptValue(data);
  await set(key, encrypted);
}

// Concurrent addMessage()/deleteMessage() calls against the SAME
// conversation (e.g. two messages arriving back-to-back) each do a
// read-modify-write of the conversation's message index — without
// serializing them, the second write can be based on a read that predates
// the first write, silently dropping the first call's id from the index.
const indexLocks = new Map<string, Promise<unknown>>();

function withIndexLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prior = indexLocks.get(conversationId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const chained = run.then(() => undefined, () => undefined);
  indexLocks.set(conversationId, chained);
  chained.then(() => {
    if (indexLocks.get(conversationId) === chained) {
      indexLocks.delete(conversationId);
    }
  });
  return run;
}

async function addMessageToIndex(conversationId: string, messageId: string): Promise<void> {
  return withIndexLock(conversationId, async () => {
    const existing = await getConversationMessageIndex(conversationId);
    const ids = existing || [];
    if (!ids.includes(messageId)) {
      ids.push(messageId);
      await setConversationMessageIndex(conversationId, ids);
    }
  });
}

async function removeMessageFromIndex(conversationId: string, messageId: string): Promise<void> {
  return withIndexLock(conversationId, async () => {
    const existing = await getConversationMessageIndex(conversationId);
    if (!existing) return;
    const updated = existing.filter(id => id !== messageId);
    if (updated.length > 0) {
      await setConversationMessageIndex(conversationId, updated);
    } else {
      // No messages left — remove the index key entirely
      await del(`conv-msgs:${conversationId}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────────────────────────────

export async function addMessage(message: StoredMessage): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }
  // Invalidate cache for this message and its conversation
  invalidateCache(`msg:${message.id}`);
  invalidateCache(`conv-msgs:${message.conversationId}`);

  const json = JSON.stringify(message);
  const data = new TextEncoder().encode(json);
  const encrypted = await encryptValue(data);

  const key = `msg:${message.id}`;
  await set(key, encrypted);

  // Update the conversation message index for O(1) lookups
  await addMessageToIndex(message.conversationId, message.id);
}

export async function getMessage(messageId: string): Promise<StoredMessage | null> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  const key = `msg:${messageId}`;

  // Check in-memory cache first
  const cached = getCached<StoredMessage>(key);
  if (cached !== undefined) return cached;

  const encrypted = await get(key);
  if (!encrypted) return null;

  const decrypted = await decryptValue(encrypted as Uint8Array);
  const json = new TextDecoder().decode(decrypted);
  const msg = JSON.parse(json) as StoredMessage;
  setCache(key, msg);
  return msg;
}

export async function getAllMessagesForConversation(
  conversationId: string
): Promise<StoredMessage[]> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  // Try the conversation message index first (O(1) lookup)
  const messageIds = await getConversationMessageIndex(conversationId);

  if (messageIds !== null) {
    // Index exists — fetch only the messages in this conversation.
    // Serve cached entries directly; batch-fetch the rest in one IndexedDB
    // transaction instead of one get() per message.
    const messages: StoredMessage[] = [];
    const missingIds: string[] = [];
    for (const msgId of messageIds) {
      const cached = getCached<StoredMessage>(`msg:${msgId}`);
      if (cached !== undefined) {
        if (cached) messages.push(cached);
      } else {
        missingIds.push(msgId);
      }
    }

    if (missingIds.length > 0) {
      const encryptedValues = await getMany(missingIds.map((id) => `msg:${id}`));
      const decoded = await Promise.all(
        encryptedValues.map(async (encrypted, i) => {
          if (!encrypted) return null;
          try {
            const decrypted = await decryptValue(encrypted as Uint8Array);
            const json = new TextDecoder().decode(decrypted);
            const msg = JSON.parse(json) as StoredMessage;
            setCache(`msg:${missingIds[i]}`, msg);
            return msg;
          } catch (err) {
            // One corrupted message shouldn't blank out the rest of the
            // conversation's history — skip it and keep the others.
            log.warn(`Skipping undecryptable message msg:${missingIds[i]}:`, err);
            return null;
          }
        })
      );
      for (const msg of decoded) {
        if (msg) messages.push(msg);
      }
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages;
  }

  // Fallback: no index yet (backward compat with pre-index data).
  // Scan all keys, filter by conversationId, and build the index.
  const allKeys = await keys();
  const prefix = `msg:`;
  const messages: StoredMessage[] = [];
  const discoveredIds: string[] = [];

  for (const key of allKeys) {
    if ((key as string).startsWith(prefix)) {
      const encrypted = await get(key);
      if (encrypted) {
        try {
          const decrypted = await decryptValue(encrypted as Uint8Array);
          const json = new TextDecoder().decode(decrypted);
          const msg = JSON.parse(json) as StoredMessage;
          if (msg.conversationId === conversationId) {
            messages.push(msg);
            discoveredIds.push(msg.id);
          }
        } catch (err) {
          // A single corrupted/foreign-account message record must not
          // abort the scan — every other conversation's history would
          // otherwise come back empty too (this loop scans the whole
          // msg: keyspace, not just this conversation's messages).
          log.warn(`Skipping undecryptable record ${key}:`, err);
        }
      }
    }
  }

  // Persist the index so future lookups are O(1)
  if (discoveredIds.length > 0) {
    await setConversationMessageIndex(conversationId, discoveredIds);
  }

  messages.sort((a, b) => a.timestamp - b.timestamp);
  return messages;
}

export async function deleteMessage(messageId: string): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  // Read the message first to find its conversationId for index cleanup
  const msg = await getMessage(messageId);

  const key = `msg:${messageId}`;
  await del(key);
  // Every other mutator (addMessage, contact writes) invalidates its cache
  // entry; this one didn't. getMessage()/getAllMessagesForConversation()
  // populate readCache with a 30s TTL, so without this a message deleted by
  // the ghost-mode sweeper (or any other caller of deleteMessage) could still
  // be served from cache — e.g. pinned-messages.ts's getMessage() call — for
  // up to 30s after it was supposedly wiped from storage.
  invalidateCache(key);

  // Remove from conversation index if message was found
  if (msg) {
    await removeMessageFromIndex(msg.conversationId, messageId);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CONVERSATIONS
// ─────────────────────────────────────────────────────────────────────────

export async function addConversation(conversation: StoredConversation): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  const json = JSON.stringify(conversation);
  const data = new TextEncoder().encode(json);
  const encrypted = await encryptValue(data);

  const key = `conv:${conversation.id}`;
  await set(key, encrypted);
}

export async function getConversation(conversationId: string): Promise<StoredConversation | null> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  const key = `conv:${conversationId}`;
  const encrypted = await get(key);

  if (!encrypted) return null;

  const decrypted = await decryptValue(encrypted as Uint8Array);
  const json = new TextDecoder().decode(decrypted);
  return JSON.parse(json) as StoredConversation;
}

export async function getAllConversations(): Promise<StoredConversation[]> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  const conversations = await getAllByPrefix<StoredConversation>('conv:');
  conversations.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return conversations;
}

export async function deleteConversation(conversationId: string): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  // Delete every individual message record, not just the index pointing at
  // them — leaving `msg:<id>` entries behind meant a "burned"/deleted
  // conversation's content was still fully decryptable in IndexedDB, and
  // getAllMessagesForConversation's fallback scan (which rebuilds the index
  // from orphaned msg: keys) could even resurface it later.
  const messageIds = await getConversationMessageIndex(conversationId);
  if (messageIds && messageIds.length > 0) {
    // Batched into a single IndexedDB transaction — a sequential
    // await-per-message loop (each its own transaction) made burn/delete
    // of a large conversation take proportionally longer, serializing what
    // should feel like an instantaneous UI action.
    await delMany(messageIds.map((id) => `msg:${id}`));
    for (const messageId of messageIds) {
      invalidateCache(`msg:${messageId}`);
    }
  }

  const key = `conv:${conversationId}`;
  await del(key);

  // Also clean up the conversation message index
  await del(`conv-msgs:${conversationId}`);
  invalidateCache(`conv-msgs:${conversationId}`);
}

// ─────────────────────────────────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────────────────────────────────

export async function addContact(contact: StoredContact): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  // Keep the in-memory read cache honest — without this, a getAllContacts()
  // call made before this write (e.g. during device-sync import) would keep
  // serving a stale cached list for up to READ_CACHE_TTL_MS.
  invalidateCache(`contact:${contact.relayId}`);
  invalidateCache('all-contacts');

  const json = JSON.stringify(contact);
  const data = new TextEncoder().encode(json);
  const encrypted = await encryptValue(data);

  const key = `contact:${contact.relayId}`;
  await set(key, encrypted);
}

export async function getContact(relayId: string): Promise<StoredContact | null> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  const key = `contact:${relayId}`;
  const encrypted = await get(key);

  if (!encrypted) return null;

  const decrypted = await decryptValue(encrypted as Uint8Array);
  const json = new TextDecoder().decode(decrypted);
  return JSON.parse(json) as StoredContact;
}

export async function getAllContacts(): Promise<StoredContact[]> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  // Check cache for full contact list
  const cached = getCached<StoredContact[]>('all-contacts');
  if (cached !== undefined) return cached;

  const contacts = await getAllByPrefix<StoredContact>('contact:');
  setCache('all-contacts', contacts);
  return contacts;
}

/**
 * Upsert a contact: merge new fields with existing data
 * Useful for updating displayName, username, etc. without losing other fields
 */
export async function upsertContact(relayId: string, updates: Partial<StoredContact>): Promise<StoredContact> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  // Invalidate contacts cache on write
  invalidateCache('all-contacts');
  invalidateCache(`contact:${relayId}`);

  // Get existing contact or create a new one
  let contact = await getContact(relayId);
  
  if (!contact) {
    // Create new contact with required fields
    if (!updates.publicKeyHex) {
      throw new Error('publicKeyHex is required when creating a new contact');
    }
    
    contact = {
      relayId,
      name: updates.name || updates.displayName || relayId.slice(0, 12),
      publicKeyHex: updates.publicKeyHex,
      addedAt: updates.addedAt || Date.now(),
      ...updates,
    };
  } else {
    // Merge updates with existing contact
    contact = {
      ...contact,
      ...updates,
      relayId: contact.relayId, // Preserve relayId
      publicKeyHex: contact.publicKeyHex, // Preserve public key
    };
  }

  await addContact(contact);
  return contact;
}

// ─────────────────────────────────────────────────────────────────────────
// BACKUP/EXPORT
// ─────────────────────────────────────────────────────────────────────────

// Export-password KDF, versioned so old backups (format version 1) stay
// importable. v1 fed the raw password straight into HKDF-Extract as the
// salt — HKDF-Extract is just a single HMAC, so with the identity's
// privateKey as the (attacker-known-in-the-threat-model-that-matters-here)
// IKM, guessing the export password was as cheap as one HMAC per guess. v2
// stretches the password through scrypt first, giving it a real work factor
// independent of the privateKey.
const EXPORT_KDF_SCRYPT_OPTS = { N: 2 ** 16, r: 8, p: 1, dkLen: 32 };

export async function deriveExportKey(
  privateKey: Uint8Array,
  exportPassword: string,
  formatVersion: number
): Promise<Uint8Array> {
  const info = new TextEncoder().encode('export-v1');
  if (formatVersion === 1) {
    const passwordBytes = new TextEncoder().encode(exportPassword);
    return hkdf(sha256, privateKey, passwordBytes, info, 32);
  }
  const stretched = await scryptAsync(exportPassword, privateKey, EXPORT_KDF_SCRYPT_OPTS);
  return hkdf(sha256, privateKey, stretched, info, 32);
}

/**
 * Export encrypted backup
 *
 * Derive export key: see deriveExportKey (scrypt-stretched password, format v2)
 * Gather: all contacts, conversations, last 500 messages per conversation, private key
 * Serialize, compress, encrypt
 * Prepend magic bytes [0x52, 0x45, 0x4c, 0x59] ("RELY")
 */
export async function exportEncryptedBackup(
  privateKeyHex: string,
  exportPassword: string
): Promise<Blob> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  // Parse private key
  const privateKey = fromHex(privateKeyHex);

  // Derive export key from private key + password (format v2)
  const exportKey = await deriveExportKey(privateKey, exportPassword, 2);

  // Gather all data
  const contacts = await getAllContacts();
  const conversations = await getAllConversations();
  const allMessages: Record<string, StoredMessage[]> = {};

  for (const conv of conversations) {
    const msgs = await getAllMessagesForConversation(conv.id);
    // Keep last 500 messages per conversation
    allMessages[conv.id] = msgs.slice(-500);
  }

  // Build backup payload
  const backupData = {
    version: 1,
    timestamp: Date.now(),
    privateKey: privateKeyHex,
    contacts,
    conversations,
    messages: allMessages,
  };

  // Serialize and compress
  const json = JSON.stringify(backupData);
  const serialized = new TextEncoder().encode(json);
  const compressed = pako.deflateRaw(serialized);

  // Encrypt with ChaCha20-Poly1305
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const cipher = chacha20poly1305(exportKey, nonce);
  const ctWithTag = cipher.encrypt(new Uint8Array(compressed));

  // Extract ciphertext and tag
  const TAG_SIZE = 16;
  const ciphertext = ctWithTag.slice(0, ctWithTag.length - TAG_SIZE);
  const tag = ctWithTag.slice(ctWithTag.length - TAG_SIZE);

  // Build file format: magic + version + timestamp + nonce + tag + ciphertext
  const magic = new Uint8Array([0x52, 0x45, 0x4c, 0x59]); // "RELY"
  const version = new Uint8Array([2]); // version 2 — scrypt-stretched export password (see deriveExportKey)
  const timestampBytes = new Uint8Array(8);
  new DataView(timestampBytes.buffer).setBigInt64(0, BigInt(backupData.timestamp), false);

  const file = new Uint8Array(
    magic.length + version.length + timestampBytes.length + nonce.length + tag.length + ciphertext.length
  );

  let offset = 0;
  file.set(magic, offset);
  offset += magic.length;
  file.set(version, offset);
  offset += version.length;
  file.set(timestampBytes, offset);
  offset += timestampBytes.length;
  file.set(nonce, offset);
  offset += nonce.length;
  file.set(tag, offset);
  offset += tag.length;
  file.set(ciphertext, offset);

  return new Blob([file], { type: 'application/octet-stream' });
}

/**
 * Import encrypted backup
 * 
 * Read file, verify magic bytes, derive export key from password,
 * decrypt and decompress, import data into IndexedDB
 */
export async function importEncryptedBackup(
  file: File,
  exportPassword: string,
  privateKeyHex: string
): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  const fileBuffer = await file.arrayBuffer();
  const fileData = new Uint8Array(fileBuffer);

  // Verify magic bytes
  const magic = fileData.slice(0, 4);
  const expectedMagic = new Uint8Array([0x52, 0x45, 0x4c, 0x59]); // "RELY"
  if (!magic.every((v, i) => v === expectedMagic[i])) {
    throw new Error('Invalid backup file: magic bytes do not match');
  }

  // Parse header
  const version = fileData[4];
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported backup version: ${version}`);
  }

  const timestampBytes = fileData.slice(5, 13);
  const timestamp = Number(new DataView(timestampBytes.buffer).getBigInt64(0, false));

  const nonce = fileData.slice(13, 25);
  const tag = fileData.slice(25, 41);
  const ciphertext = fileData.slice(41);

  // Derive export key from password + private key — see deriveExportKey for
  // why this is version-gated (v1 backups predate the scrypt stretch).
  const privateKey = fromHex(privateKeyHex);
  const exportKey = await deriveExportKey(privateKey, exportPassword, version);

  // Decrypt
  const cipher = chacha20poly1305(exportKey, nonce);
  const ctWithTag = new Uint8Array(ciphertext.length + tag.length);
  ctWithTag.set(ciphertext);
  ctWithTag.set(tag, ciphertext.length);

  const compressed = cipher.decrypt(ctWithTag);
  if (!compressed) {
    throw new Error('Decryption failed: authentication tag mismatch or invalid password');
  }

  // Decompress
  const decompressed = pako.inflateRaw(compressed);
  const json = new TextDecoder().decode(decompressed);
  const backupData = JSON.parse(json);

  // Validate shape before mutating IndexedDB. The AEAD tag above proves the
  // file wasn't tampered with, but says nothing about whether its *contents*
  // match this function's expectations — an old/differently-versioned or
  // hand-crafted backup with a missing/malformed field previously threw
  // partway through the import loops below, leaving contacts/conversations
  // already written and messages half-imported: a corrupted, inconsistent
  // local DB with no rollback.
  if (!Array.isArray(backupData.contacts) || !Array.isArray(backupData.conversations)
    || typeof backupData.messages !== 'object' || backupData.messages === null || Array.isArray(backupData.messages)) {
    throw new Error('Invalid backup contents: unexpected data shape');
  }
  for (const contact of backupData.contacts) {
    if (!contact || typeof contact.relayId !== 'string') {
      throw new Error('Invalid backup contents: malformed contact entry');
    }
  }
  for (const conversation of backupData.conversations) {
    if (!conversation || typeof conversation.id !== 'string') {
      throw new Error('Invalid backup contents: malformed conversation entry');
    }
  }
  for (const conversationId in backupData.messages) {
    if (!Array.isArray(backupData.messages[conversationId])) {
      throw new Error('Invalid backup contents: malformed message list');
    }
    for (const message of backupData.messages[conversationId]) {
      if (!message || typeof message.id !== 'string') {
        throw new Error('Invalid backup contents: malformed message entry');
      }
    }
  }

  // Import into IndexedDB
  for (const contact of backupData.contacts) {
    await addContact(contact);
  }

  for (const conversation of backupData.conversations) {
    await addConversation(conversation);
  }

  for (const conversationId in backupData.messages) {
    for (const message of backupData.messages[conversationId]) {
      // Store message using addMessage which uses msg:${id} format
      await addMessage(message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ONBOARDING
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mark onboarding as complete
 */
export async function setOnboardingComplete(): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  const value = new TextEncoder().encode('true');
  const encrypted = await encryptValue(value);
  await set('meta:onboarding_complete', encrypted);
}

/**
 * Check if onboarding has been completed
 */
export async function isOnboardingComplete(): Promise<boolean> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  try {
    const encrypted = await get('meta:onboarding_complete');
    if (!encrypted) return false;

    const decrypted = await decryptValue(encrypted as Uint8Array);
    const value = new TextDecoder().decode(decrypted);
    return value === 'true';
  } catch {
    // Decryption fails when switching accounts (different storage key) — expected
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GROUP EPOCH KEYS
// ─────────────────────────────────────────────────────────────────────────

export interface StoredGroupKeyRecord {
  epoch: number;
  keyHex: string;
  previousEpochKeyHex?: string;
}

/** Persist a group's current epoch key record — see lib/messaging/group-key-cache.ts, the in-memory-cached wrapper around this. */
export async function saveGroupKey(groupId: string, record: StoredGroupKeyRecord): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }
  const value = new TextEncoder().encode(JSON.stringify(record));
  const encrypted = await encryptValue(value);
  await set(`group-key:${groupId}`, encrypted);
}

export async function loadGroupKey(groupId: string): Promise<StoredGroupKeyRecord | null> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }
  try {
    const encrypted = await get(`group-key:${groupId}`);
    if (!encrypted) return null;
    const decrypted = await decryptValue(encrypted as Uint8Array);
    return JSON.parse(new TextDecoder().decode(decrypted)) as StoredGroupKeyRecord;
  } catch {
    // Decryption fails when switching accounts (different storage key) —
    // same accepted behavior as isOnboardingComplete's identical catch.
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Save user settings to encrypted IndexedDB
 */
export async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  const json = JSON.stringify(settings);
  const data = new TextEncoder().encode(json);
  const encrypted = await encryptValue(data);
  await set('meta:settings', encrypted);
}

/**
 * Load user settings from encrypted IndexedDB
 */
export async function loadSettings(): Promise<Record<string, unknown> | null> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  try {
    const encrypted = await get('meta:settings');
    if (!encrypted) return null;

    const decrypted = await decryptValue(encrypted as Uint8Array);
    const json = new TextDecoder().decode(decrypted);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// QUOTA & SEARCH
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check available storage quota before a write operation.
 * Returns { ok, usedMB, totalMB, percentUsed } or throws if storage API unavailable.
 */
export async function checkStorageQuota(): Promise<{
  ok: boolean;
  usedMB: number;
  totalMB: number;
  percentUsed: number;
}> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { ok: true, usedMB: 0, totalMB: 0, percentUsed: 0 };
  }

  const estimate = await navigator.storage.estimate();
  const usedMB = (estimate.usage || 0) / (1024 * 1024);
  const totalMB = (estimate.quota || 0) / (1024 * 1024);
  const percentUsed = totalMB > 0 ? (usedMB / totalMB) * 100 : 0;

  // Warn at 90%, block at 95%
  return {
    ok: percentUsed < 95,
    usedMB: Math.round(usedMB * 10) / 10,
    totalMB: Math.round(totalMB * 10) / 10,
    percentUsed: Math.round(percentUsed * 10) / 10,
  };
}

/**
 * Search messages across all conversations
 * Returns messages matching the query, sorted by relevance (most recent first)
 */
export async function searchMessages(query: string, limit: number = 50): Promise<StoredMessage[]> {
  if (!isStorageReady) {
    throw new Error('Storage not ready. Call initStorage() first.');
  }

  if (!query || query.trim().length === 0) return [];

  const lowerQuery = query.toLowerCase().trim();
  const msgKeys = (await keys()).filter((k) => (k as string).startsWith('msg:'));
  const matches: StoredMessage[] = [];

  // Decrypt in parallel chunks (not one get() per key) but still stop early
  // once enough matches are found, instead of decrypting the whole store.
  const CHUNK_SIZE = 50;
  for (let i = 0; i < msgKeys.length && matches.length < limit; i += CHUNK_SIZE) {
    const chunk = msgKeys.slice(i, i + CHUNK_SIZE);
    const encryptedValues = await getMany(chunk);
    const decoded = await Promise.all(
      encryptedValues.map(async (encrypted) => {
        if (!encrypted) return null;
        try {
          const decrypted = await decryptValue(encrypted as Uint8Array);
          const json = new TextDecoder().decode(decrypted);
          return JSON.parse(json) as StoredMessage;
        } catch {
          return null; // Skip corrupted messages
        }
      })
    );
    for (const msg of decoded) {
      if (msg?.text && msg.text.toLowerCase().includes(lowerQuery)) {
        matches.push(msg);
      }
    }
  }

  // Sort by timestamp descending (most recent first)
  matches.sort((a, b) => b.timestamp - a.timestamp);
  return matches.slice(0, limit);
}

/**
 * Get storage statistics
 */
export async function getStorageStats(): Promise<{
  messageCount: number;
  contactCount: number;
  conversationCount: number;
  noteCount: number;
  totpCount: number;
}> {
  const allKeys = await keys();
  let messageCount = 0, contactCount = 0, conversationCount = 0, noteCount = 0, totpCount = 0;

  for (const key of allKeys) {
    const k = key as string;
    if (k.startsWith('msg:')) messageCount++;
    else if (k.startsWith('contact:')) contactCount++;
    else if (k.startsWith('conv:')) conversationCount++;
    else if (k.startsWith('note:')) noteCount++;
    else if (k.startsWith('totp:')) totpCount++;
  }

  return { messageCount, contactCount, conversationCount, noteCount, totpCount };
}

export async function clearAllStorage(): Promise<void> {
  await clear();
  // In-memory read cache (30s TTL) holds already-DECRYPTED values — a read
  // served from here bypasses IndexedDB entirely, so without this a
  // getContact()/getMessage() call for something read shortly before this
  // wipe could still return the pre-wipe cached object for up to 30s after
  // IndexedDB and localStorage are already empty. Same wipe this is used
  // for (duress PIN, failed-attempts lockout) — this cache surviving it
  // undermines the whole point.
  readCache.clear();
  // This is the wipe used by the duress PIN and the 5-failed-attempts
  // safeguard — clearing IndexedDB alone left everything the app persists
  // to localStorage fully recoverable (group rosters + messages under
  // relay_groups_<relayId>, ghost-mode timers, paired-device records, vault
  // entries, cached usernames, etc.), completely defeating the point of a
  // coercion wipe. Deliberately blunt (clear everything, not a curated key
  // list) so a future feature that starts writing a new localStorage key
  // doesn't silently reopen this gap by not being added to an allowlist.
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
}
