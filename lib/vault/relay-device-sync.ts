/**
 * Relay Device Sync via QR Code
 * 
 * Enables secure device pairing through:
 * 1. QR code generation on new device (temporary X25519 keypair)
 * 2. Scanning and WebRTC data channel establishment
 * 3. Encrypted sync payload transfer (16KB chunks)
 * 4. Full history restoration on new device
 */

import { generateKeypair, computeSharedSecret, hkdfDerive } from '@/lib/crypto/relay-crypto';
import { log } from '@/lib/platform/logger';
import {
  getAllContacts,
  getAllConversations,
  getAllMessagesForConversation,
  addContact,
  getContact,
  addConversation,
  addMessage,
} from '@/lib/db/relay-store';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import * as pako from 'pako';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';

// ─────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────

export interface QRCodeData {
  transferPublicKey: string; // hex-encoded X25519 public key
  version: string; // "rsync-v1"
  issuedAt: number; // ms epoch — scanning side rejects stale/expired codes
}

const QR1_VALIDITY_MS = 5 * 60 * 1000;

export interface SyncRequest {
  type: 'sync_request';
  transferPublicKey: string;
  senderPublicKey: string;
}

export interface SyncPayloadEncrypted {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
  chunkIndex: number;
  totalChunks: number;
}

export interface SyncPayload {
  version: 1;
  timestamp: number;
  privateKeyHex: string;
  contacts: any[];
  conversations: any[];
  messages: Record<string, any[]>; // conversationId -> messages (last 200 each)
}

export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  publicKeyHex: string;
  addedAt: number;
  lastSyncAt: number;
}

// ─────────────────────────────────────────────────────────────────────────
// QR CODE GENERATION (for new device)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generate a new transfer keypair and QR code data
 * QR expires after 5 minutes
 */
export function generateQRCodeData(): {
  transferKeypair: { privateKey: Uint8Array; publicKey: Uint8Array };
  qrCodeData: QRCodeData;
  expiresAt: number;
} {
  const transferKeypair = generateKeypair();
  const publicKeyHex = toHex(transferKeypair.publicKey);
  const issuedAt = Date.now();

  const qrCodeData: QRCodeData = {
    transferPublicKey: publicKeyHex,
    version: 'rsync-v1',
    issuedAt,
  };

  const expiresAt = issuedAt + QR1_VALIDITY_MS;

  return {
    transferKeypair,
    qrCodeData,
    expiresAt,
  };
}

/** True if a scanned QR1 payload is within its validity window. */
export function isQR1Fresh(issuedAt: unknown): boolean {
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  return age >= 0 && age <= QR1_VALIDITY_MS;
}

const VERIFICATION_CODE_WINDOW_MS = 30_000;

/**
 * Short human-verifiable code derived from the new device's transfer public
 * key AND the current 30s time window. Shown on BOTH the new device (right
 * under its QR1, re-derived every 30s) and the existing device (computed at
 * scan time, before it releases the encrypted identity) — the existing
 * device's user must confirm the two match before pairing proceeds.
 *
 * The code rotates like a TOTP so it cannot be a permanently-valid,
 * pre-printed value: deriving it purely from the (static) public key would
 * let an attacker precompute the matching code once and display it
 * alongside a planted/opportunistic QR (sticker, poster, phishing screen)
 * forever, defeating the whole point of a human comparing "two screens".
 * Rotation forces that attack to use an actively-updating display instead
 * of a static print — it does NOT defend against a live, actively-updating
 * malicious device performing the exchange in real time; that residual TOFU
 * limitation is inherent to any code derived only from data the pairing
 * parties themselves control, without a trusted out-of-band channel.
 */
export function deriveVerificationCode(transferPublicKeyHex: string, at: number = Date.now()): string {
  const window = Math.floor(at / VERIFICATION_CODE_WINDOW_MS);
  const windowBytes = new Uint8Array(8);
  new DataView(windowBytes.buffer).setBigUint64(0, BigInt(window), false);
  const hash = sha256(new Uint8Array([...fromHex(transferPublicKeyHex), ...windowBytes]));
  // 6 digits from the first 4 bytes, same look-and-feel as the app's TOTP codes.
  const num = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
  return String(num % 1_000_000).padStart(6, '0');
}

// ─────────────────────────────────────────────────────────────────────────
// SYNC PAYLOAD PREPARATION (existing device)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Prepare sync payload with private key and recent data
 * Includes last 200 messages per conversation
 */
export async function prepareSyncPayload(
  privateKeyHex: string
): Promise<SyncPayload> {
  const contacts = await getAllContacts();
  const conversations = await getAllConversations();

  const messages: Record<string, any[]> = {};
  const now = Date.now();

  // Ghost-mode messages (`ghost: true`) and any message whose `expiresAt`
  // has already passed are deliberately excluded. Device sync exists to
  // mirror durable history onto a new device — it must not resurrect
  // self-destructing messages on hardware the user never had them on, or
  // reveal messages that already expired locally but hadn't been swept
  // from IndexedDB yet.
  for (const conv of conversations) {
    const msgs = await getAllMessagesForConversation(conv.id);
    const durable = msgs.filter((m: any) => {
      if (m.ghost) return false;
      if (typeof m.expiresAt === 'number' && m.expiresAt <= now) return false;
      return true;
    });
    // Keep last 200 messages
    messages[conv.id] = durable.slice(-200);
  }

  return {
    version: 1,
    timestamp: Date.now(),
    privateKeyHex,
    contacts,
    conversations,
    messages,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ENCRYPTION / DECRYPTION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Encrypt sync payload using shared secret
 * Serializes -> compresses -> encrypts
 */
export async function encryptSyncPayload(
  payload: SyncPayload,
  sharedSecret: Uint8Array
): Promise<Uint8Array> {
  // Serialize to JSON
  const json = JSON.stringify(payload);
  const serialized = new TextEncoder().encode(json);

  // Compress
  const compressed = pako.deflateRaw(serialized);

  // Derive encryption key from shared secret
  const encryptionKey = hkdfDerive(
    sharedSecret,
    new Uint8Array(0),
    'sync-payload-v1',
    32
  );

  // Encrypt with ChaCha20-Poly1305
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const cipher = chacha20poly1305(encryptionKey, nonce);
  const ctWithTag = cipher.encrypt(new Uint8Array(compressed));

  // Combine: nonce + ciphertext + tag
  const result = new Uint8Array(12 + ctWithTag.length);
  result.set(nonce);
  result.set(ctWithTag, 12);

  return result;
}

/**
 * Decrypt sync payload using shared secret
 */
export async function decryptSyncPayload(
  encryptedData: Uint8Array,
  sharedSecret: Uint8Array
): Promise<SyncPayload> {
  if (encryptedData.length < 28) {
    throw new Error('Encrypted data too short');
  }

  const nonce = encryptedData.slice(0, 12);
  const ctWithTag = encryptedData.slice(12);

  // Derive encryption key from shared secret
  const encryptionKey = hkdfDerive(
    sharedSecret,
    new Uint8Array(0),
    'sync-payload-v1',
    32
  );

  // Decrypt
  const cipher = chacha20poly1305(encryptionKey, nonce);
  const compressed = cipher.decrypt(ctWithTag);

  if (!compressed) {
    throw new Error('Decryption failed: authentication tag mismatch');
  }

  // Decompress
  const decompressed = pako.inflateRaw(compressed);

  // Parse JSON
  const json = new TextDecoder().decode(decompressed);
  return JSON.parse(json) as SyncPayload;
}

// ─────────────────────────────────────────────────────────────────────────
// CHUNKED TRANSFER (16KB chunks with sequence numbers)
// ─────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 16384; // 16 KB — default, e.g. for a byte-oriented channel

/**
 * QR codes carry far less data than a 16KB chunk. This is the chunk size
 * used when the sync payload rides over the same camera-scan "transport" as
 * the identity QR handshake (see buildSyncQRFrames below) — small enough
 * that base64(chunk) plus JSON framing still renders as a reliably
 * scannable QR at error-correction level 'L'.
 */
export const QR_SYNC_CHUNK_SIZE = 900;

/**
 * Split encrypted payload into fixed-size chunks (16KB by default)
 */
export function chunkSyncPayload(
  encryptedPayload: Uint8Array,
  chunkSize: number = CHUNK_SIZE
): Array<{ data: Uint8Array; chunkIndex: number; totalChunks: number }> {
  const chunks: Array<{ data: Uint8Array; chunkIndex: number; totalChunks: number }> = [];
  const totalChunks = Math.max(1, Math.ceil(encryptedPayload.length / chunkSize));

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, encryptedPayload.length);
    const chunkData = encryptedPayload.slice(start, end);

    chunks.push({
      data: chunkData,
      chunkIndex: i,
      totalChunks,
    });
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────
// SYNC PAYLOAD OVER QR FRAMES
// ─────────────────────────────────────────────────────────────────────────

/** Marker embedded in each animated-QR sync-chunk frame. */
const SYNC_QR_MARKER = 'rss1';

export interface SyncQRFrame {
  v: typeof SYNC_QR_MARKER;
  i: number; // chunk index
  n: number; // total chunks
  d: string; // base64-encoded chunk bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunk the String.fromCharCode call to stay well under engine argument
  // limits — irrelevant at QR chunk sizes but keeps this safe for reuse.
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Turn an encrypted sync payload into a sequence of small JSON strings, each
 * suitable as the `value` of one QR code frame. The receiving device (still
 * scanning after it captured the identity QR2) collects these by index and
 * reassembles + decrypts once every index has been seen — see
 * parseSyncQRFrame + reassembleChunks + decryptSyncPayload.
 */
export function buildSyncQRFrames(
  encryptedPayload: Uint8Array,
  chunkSize: number = QR_SYNC_CHUNK_SIZE
): string[] {
  const chunks = chunkSyncPayload(encryptedPayload, chunkSize);
  return chunks.map(({ data, chunkIndex, totalChunks }) => {
    const frame: SyncQRFrame = {
      v: SYNC_QR_MARKER,
      i: chunkIndex,
      n: totalChunks,
      d: bytesToBase64(data),
    };
    return JSON.stringify(frame);
  });
}

/**
 * Parse one scanned QR frame's raw string. Returns null if it isn't a sync
 * chunk frame (e.g. it's an unrelated QR, or the identity QR2 itself) so
 * callers can keep scanning without treating malformed input as fatal.
 */
/**
 * Upper bound on totalChunks a scanned frame may claim. At QR_SYNC_CHUNK_SIZE
 * bytes/chunk this is a generous multi-megabyte ceiling — well above what
 * syncToVault's own 500-messages-per-conversation cap would ever produce —
 * while still rejecting a malformed/spoofed frame (e.g. a stray unrelated QR
 * code the camera catches mid-scan that happens to parse as this shape)
 * claiming an absurd chunk count.
 */
const MAX_SYNC_QR_CHUNKS = 4096;

export function parseSyncQRFrame(
  raw: string
): { chunkIndex: number; totalChunks: number; data: Uint8Array } | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.v !== SYNC_QR_MARKER ||
      !Number.isInteger(parsed.i) ||
      !Number.isInteger(parsed.n) ||
      typeof parsed.d !== 'string'
    ) {
      return null;
    }
    if (parsed.n < 1 || parsed.n > MAX_SYNC_QR_CHUNKS) return null;
    if (parsed.i < 0 || parsed.i >= parsed.n) return null;
    return {
      chunkIndex: parsed.i,
      totalChunks: parsed.n,
      data: base64ToBytes(parsed.d),
    };
  } catch {
    return null;
  }
}

/**
 * Reassemble chunks back into complete payload
 */
export function reassembleChunks(
  chunks: Map<number, Uint8Array>,
  totalChunks: number
): Uint8Array {
  let totalSize = 0;

  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks.get(i);
    if (!chunk) {
      throw new Error(`Missing chunk ${i}`);
    }
    totalSize += chunk.length;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;

  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks.get(i)!;
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// IMPORT ON NEW DEVICE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Import sync payload into new device
 * Restores all contacts, conversations, and message history
 */
export async function importSyncPayload(payload: SyncPayload): Promise<void> {
  // Import contacts — but never blindly clobber a contact that already
  // exists locally. This same import path runs both for a brand-new device
  // (nothing exists locally, so every contact is new) and for a re-pair of
  // a device that already has some of its own locally-added contacts. The
  // sync payload is a snapshot from the OTHER device at some point in the
  // past and carries no last-modified timestamp, so there is no reliable
  // way to tell whether the synced copy or the local copy is newer — the
  // only safe default is to keep whatever is already on this device (it's
  // at least as recent as this device's own edits) and only add contacts
  // this device doesn't know about yet.
  for (const contact of payload.contacts) {
    const existing = await getContact(contact.relayId);
    if (existing) {
      log.debug(`[DeviceSync] Skipping import of ${contact.relayId} — already present locally`);
      continue;
    }
    await addContact(contact);
  }

  // Import conversations
  for (const conversation of payload.conversations) {
    await addConversation(conversation);
  }

  // Import messages
  for (const conversationId in payload.messages) {
    for (const message of payload.messages[conversationId]) {
      await addMessage(message);
    }
  }

  log.debug('[DeviceSync] Sync payload imported successfully');
}

// ─────────────────────────────────────────────────────────────────────────
// IDENTITY QR TRANSFER (2-QR secure handshake)
// ─────────────────────────────────────────────────────────────────────────

export interface IdentityTransferPayload {
  privateKeyHex: string; // X25519 private key
  relayId: string;
  publicKeyHex: string; // X25519 public key
  // Post-quantum (ML-KEM768) keypair — optional only for accounts created
  // before PQ support existed. Without these, a paired device has no PQ
  // key material at all and permanently takes the classical-only branch in
  // every key exchange it does, with no warning — the exact silent
  // downgrade this app's own anti-downgrade protections exist to prevent
  // for the analogous relay-MITM case.
  pqPrivateKeyHex?: string;
  pqPublicKeyHex?: string;
}

/**
 * Encrypt the caller's identity for transfer to a new device.
 *
 * ECDH(senderPrivateKey, newDeviceTransferPublicKey) → shared secret →
 * HKDF → ChaCha20-Poly1305 encrypted identity JSON.
 *
 * Returns base64(nonce[12] + ciphertext+tag).
 */
export function encryptIdentityForQR(
  identity: IdentityTransferPayload,
  transferPublicKeyHex: string,
  senderPrivateKey: Uint8Array,
): string {
  const transferPublicKey = fromHex(transferPublicKeyHex);
  const sharedSecret = computeSharedSecret(senderPrivateKey, transferPublicKey);
  const encKey = hkdfDerive(sharedSecret, new Uint8Array(0), 'qr-id-transfer-v1', 32);

  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(identity));
  const cipher = chacha20poly1305(encKey, nonce);
  const ct = cipher.encrypt(plaintext);

  const combined = new Uint8Array(12 + ct.length);
  combined.set(nonce);
  combined.set(ct, 12);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt the identity blob received as QR2 on the new device.
 *
 * ECDH(newDeviceTransferPrivateKey, senderPublicKey) → same shared secret.
 */
export function decryptIdentityFromQR(
  encoded: string,
  transferPrivateKey: Uint8Array,
  senderPublicKeyHex: string,
): IdentityTransferPayload {
  const senderPublicKey = fromHex(senderPublicKeyHex);
  const sharedSecret = computeSharedSecret(transferPrivateKey, senderPublicKey);
  const encKey = hkdfDerive(sharedSecret, new Uint8Array(0), 'qr-id-transfer-v1', 32);

  const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const nonce = raw.slice(0, 12);
  const ct = raw.slice(12);
  const cipher = chacha20poly1305(encKey, nonce);
  const plaintext = cipher.decrypt(ct);
  if (!plaintext) throw new Error('Identity QR decryption failed — invalid key or tampered data');
  return JSON.parse(new TextDecoder().decode(plaintext)) as IdentityTransferPayload;
}

// ─────────────────────────────────────────────────────────────────────────
// DEVICE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────

/**
 * Register a paired device locally
 */
export async function registerPairedDevice(
  deviceId: string,
  deviceName: string,
  publicKeyHex: string
): Promise<PairedDevice> {
  const device: PairedDevice = {
    deviceId,
    deviceName,
    publicKeyHex,
    addedAt: Date.now(),
    lastSyncAt: Date.now(),
  };

  // Store in local storage
  localStorage.setItem(`paired-device:${deviceId}`, JSON.stringify(device));

  return device;
}

/**
 * Get all paired devices
 */
export function getPairedDevices(): PairedDevice[] {
  if (typeof window === 'undefined') return [];

  const devices: PairedDevice[] = [];
  const prefix = 'paired-device:';

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      const data = localStorage.getItem(key);
      if (data) {
        devices.push(JSON.parse(data));
      }
    }
  }

  return devices;
}

/**
 * Update last sync time for a device
 */
export function updateDeviceSyncTime(deviceId: string): void {
  if (typeof window === 'undefined') return;

  const data = localStorage.getItem(`paired-device:${deviceId}`);
  if (data) {
    const device = JSON.parse(data) as PairedDevice;
    device.lastSyncAt = Date.now();
    localStorage.setItem(`paired-device:${deviceId}`, JSON.stringify(device));
  }
}

/**
 * Revoke a paired device
 */
export function revokePairedDevice(deviceId: string): void {
  if (typeof window === 'undefined') return;

  localStorage.removeItem(`paired-device:${deviceId}`);
  log.debug(`[DeviceSync] Device ${deviceId} revoked`);
}
