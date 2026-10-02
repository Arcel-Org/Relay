/**
 * Session Persistence Manager
 * 
 * Maintains authentication session across page refreshes
 * - Grace period: 24 hours (see GRACE_PERIOD_MS) — user can manually lock via the lock button
 * - Dual storage: sessionStorage (primary) + IndexedDB (backup)
 * - Validates session expiration
 */

import { log } from '@/lib/platform/logger';

export interface SessionData {
  userId: string;
  relayId: string;
  publicKeyHex: string;
  sessionToken: string;
  loginTime: number;
  lastActivityTime: number;
  displayName?: string;
  username?: string;
  /** Hex-encoded private key — kept in sessionStorage so the user doesn't
   *  need to re-enter PIN on every HMR reload or tab navigation.
   *  sessionStorage is tab-scoped and cleared on tab close, so the key
   *  is never persisted to disk. */
  privateKeyHex?: string;
  /** Hex-encoded post-quantum (ML-KEM768) private key — same tab-scoped-only
   *  rule as privateKeyHex applies; must never reach the IndexedDB backup. */
  pqPrivateKeyHex?: string;
  /** Hex-encoded post-quantum (ML-KEM768) PUBLIC key — unlike the private
   *  key above, this carries no secrecy requirement and is safe in the
   *  IndexedDB backup. Exists here specifically so a device that was
   *  QR-paired-in (and therefore has no local IndexedDB `users` row to
   *  read pqPublicKeyHex from — see identity.ts) still has somewhere to
   *  find its own PQ public key to advertise during key exchange. */
  pqPublicKeyHex?: string;
}

const SESSION_KEY = 'relay:session';
// NOTE: IndexedDB name kept as 'polar-session-backup' for backward compatibility
// with existing deployed users. Renaming would force re-login on next visit.
const IDB_DB_NAME = 'polar-session-backup';
const IDB_STORE_NAME = 'sessions';
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours — user can manually lock via the lock button

// ─────────────────────────────────────────────────────────────────────────
// IndexedDB Session Backup
// ─────────────────────────────────────────────────────────────────────────

function openSessionIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const IDB_KEY_RECORD = '__enc_key';

/**
 * The IndexedDB backup persists to disk (unlike sessionStorage), so unlike
 * the tab-scoped XOR obfuscation below it gets a real per-device AES-GCM
 * key — generated once with the Web Crypto RNG and stored alongside the
 * ciphertext, not a constant baked into the shipped JS. Doesn't defend
 * against an attacker who already has arbitrary JS execution in the page
 * (nothing client-side can), but stops the data from being recoverable by
 * simply reading the bundle's source.
 */
async function getOrCreateIdbEncryptionKey(store: IDBObjectStore): Promise<CryptoKey> {
  const existing = await new Promise<string | undefined>((resolve, reject) => {
    const req = store.get(IDB_KEY_RECORD);
    req.onsuccess = () => resolve(req.result as string | undefined);
    req.onerror = () => reject(req.error);
  });
  if (existing) {
    const raw = Uint8Array.from(atob(existing), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...raw));
  store.put(b64, IDB_KEY_RECORD);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptForIdb(store: IDBObjectStore, plaintext: string): Promise<string> {
  const key = await getOrCreateIdbEncryptionKey(store);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return `v2:${btoa(String.fromCharCode(...combined))}`;
}

async function decryptFromIdb(store: IDBObjectStore, blob: string): Promise<string> {
  if (!blob.startsWith('v2:')) {
    // Pre-existing session written before this AES-GCM upgrade — decode with
    // the old obfuscation once so the user isn't logged out, then the next
    // save re-encrypts it under the new per-device key.
    return deobfuscateFromStorage(blob);
  }
  const key = await getOrCreateIdbEncryptionKey(store);
  const combined = Uint8Array.from(atob(blob.slice(3)), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function saveSessionToIDB(data: SessionData): Promise<void> {
  try {
    const db = await openSessionIDB();
    // Guard: if the object store doesn't exist (DB was created by an older
    // version without the upgrade path), close and skip silently.
    if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
      db.close();
      // Delete the broken DB so next open triggers onupgradeneeded
      indexedDB.deleteDatabase(IDB_DB_NAME);
      return;
    }
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IDB_STORE_NAME);
    // Strip privateKeyHex/pqPrivateKeyHex — IndexedDB persists to disk; raw
    // private key material must never leave sessionStorage (tab-scoped). User
    // will need to re-enter PIN if they close and reopen the tab rather than
    // navigating within it.
    const { privateKeyHex: _stripped, pqPrivateKeyHex: _pqStripped, ...safeData } = data;
    const encrypted = await encryptForIdb(store, JSON.stringify(safeData));
    store.put(encrypted, SESSION_KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    // Non-critical — sessionStorage is the primary store
  }
}

async function loadSessionFromIDB(): Promise<SessionData | null> {
  try {
    const session = await new Promise<SessionData | null>((resolve) => {
      const req = indexedDB.open(IDB_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.close(); resolve(null); };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(IDB_STORE_NAME)) {
          database.close();
          return resolve(null);
        }
        const tx = database.transaction(IDB_STORE_NAME, 'readonly');
        const store = tx.objectStore(IDB_STORE_NAME);
        const getReq = store.get(SESSION_KEY);
        getReq.onsuccess = () => {
          if (getReq.result) {
            decryptFromIdb(store, getReq.result as string)
              .then((decrypted) => {
                database.close();
                resolve(JSON.parse(decrypted) as SessionData);
              })
              .catch(() => {
                database.close();
                resolve(null);
              });
          } else {
            database.close();
            resolve(null);
          }
        };
        getReq.onerror = () => {
          database.close();
          resolve(null);
        };
      };
    });
    return session;
  } catch {
    return null;
  }
}

async function clearSessionFromIDB(): Promise<void> {
  try {
    const db = await openSessionIDB();
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    tx.objectStore(IDB_STORE_NAME).delete(SESSION_KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    log.warn('[Session] IndexedDB backup clear failed:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public API — Dual-write to sessionStorage + IndexedDB
// ─────────────────────────────────────────────────────────────────────────

/**
 * Save session to sessionStorage + IndexedDB backup
 */
export function saveSession(sessionData: SessionData): void {
  try {
    const encrypted = obfuscateForStorage(JSON.stringify(sessionData));
    sessionStorage.setItem(SESSION_KEY, encrypted);
    // Fire-and-forget IndexedDB backup
    saveSessionToIDB(sessionData).catch(() => {});
    log.debug('Session saved (sessionStorage + IndexedDB)');
  } catch (err) {
    log.error('Failed to save session:', err);
  }
}

/**
 * Load session from sessionStorage, fallback to IndexedDB
 */
export function loadSession(): SessionData | null {
  try {
    if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') {
      log.debug('[Session] sessionStorage not available (SSR)');
      return null;
    }

    // Try the current key
    const encrypted = sessionStorage.getItem(SESSION_KEY);
    if (encrypted) {
      try {
        const decrypted = deobfuscateFromStorage(encrypted);
        return JSON.parse(decrypted) as SessionData;
      } catch {
        // Invalid session data under this key
      }
    }

    log.debug('[Session] sessionStorage empty, will try IndexedDB async');
    return null;
  } catch (err) {
    log.error('[Session] Failed to load session:', err);
    clearSession();
    return null;
  }
}

/**
 * Async load — tries sessionStorage first, then IndexedDB backup
 */
export async function loadSessionAsync(): Promise<SessionData | null> {
  // Try sessionStorage first (synchronous)
  const sync = loadSession();
  if (sync) return sync;

  // Fallback to IndexedDB
  try {
    const idbSession = await loadSessionFromIDB();
    if (idbSession) {
      log.debug('[Session] Restored from IndexedDB backup:', { relayId: idbSession.relayId });
      // Re-populate sessionStorage for next synchronous load
      const encrypted = obfuscateForStorage(JSON.stringify(idbSession));
      sessionStorage.setItem(SESSION_KEY, encrypted);
      return idbSession;
    }
  } catch (err) {
    log.warn('[Session] IndexedDB fallback failed:', err);
  }

  return null;
}

/**
 * Check if session is still valid (within grace period)
 */
export function isSessionValid(session: SessionData | null): boolean {
  if (!session) return false;

  // Use the most recent activity timestamp so active sessions stay alive.
  // Fall back to loginTime for sessions created before lastActivityTime was added.
  const lastActive = session.lastActivityTime || session.loginTime;
  const elapsed = Date.now() - lastActive;
  const withinGracePeriod = elapsed < GRACE_PERIOD_MS;

  log.debug('[Session] Validity check:', {
    lastActive,
    now: Date.now(),
    elapsed,
    gracePeriod: GRACE_PERIOD_MS,
    valid: withinGracePeriod,
  });

  if (!withinGracePeriod) {
    log.debug('[Session] Grace period expired');
  }

  return withinGracePeriod;
}

/**
 * Check if PIN should be shown again
 */
export function shouldShowPINAgain(session: SessionData | null): boolean {
  return !isSessionValid(session);
}

/**
 * Update last activity time (keep session alive if within grace period)
 */
export function updateSessionActivity(session: SessionData): SessionData {
  return {
    ...session,
    lastActivityTime: Date.now(),
  };
}

/**
 * Clear session from both sessionStorage and IndexedDB
 */
export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    clearSessionFromIDB().catch(() => {});
    log.debug('Session cleared (sessionStorage + IndexedDB)');
  } catch (err) {
    log.error('Failed to clear session:', err);
  }
}

/**
 * Get session duration
 */
export function getSessionDuration(session: SessionData): number {
  return Date.now() - session.loginTime;
}

/**
 * Format session grace period for display
 */
export function formatGracePeriod(session: SessionData): string {
  // Match isSessionValid's basis (last activity, falling back to loginTime)
  // so this doesn't report "Expired" for a session that's actually still valid.
  const lastActive = session.lastActivityTime || session.loginTime;
  const remaining = GRACE_PERIOD_MS - (Date.now() - lastActive);
  if (remaining <= 0) return 'Expired';

  const seconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${secs}s remaining`;
  }
  return `${secs}s remaining`;
}

// ─────────────────────────────────────────────────────────────────────────
// SIMPLE OBFUSCATION (NOT CRYPTOGRAPHIC - just to prevent accidental reads)
// ─────────────────────────────────────────────────────────────────────────

const DEVICE_OBFUSCATION_KEY_STORAGE = 'relay:session-obf-key';

/**
 * Per-device random key for the sessionStorage XOR below — replaces the
 * previous scheme's hardcoded 'relay-session-v1' literal, which was baked
 * directly into the shipped JS bundle: anyone who could read the app's
 * public source (no access to any user's actual browser at all) had the
 * "key" for every single user's session at once. This key is generated
 * once via a real CSPRNG and persisted in localStorage (device-scoped,
 * survives tab close unlike sessionStorage itself) so the XOR stays
 * synchronous — loadSession() below is a sync API real callers depend on
 * for initial render, and WebCrypto's AES is Promise-only, so swapping to
 * real AES-GCM here (like the IndexedDB backup already does) would be a
 * breaking API change, not just a hardening one.
 *
 * This still doesn't defend against an attacker with equal read access to
 * this device's storage (localStorage + sessionStorage together) — nothing
 * purely client-side can. What it removes is decrypting every user's
 * session from the public bundle alone, with zero device access needed.
 */
function getOrCreateDeviceObfuscationKey(): Uint8Array {
  try {
    const existing = localStorage.getItem(DEVICE_OBFUSCATION_KEY_STORAGE);
    if (existing) return Uint8Array.from(atob(existing), (c) => c.charCodeAt(0));
  } catch {
    // localStorage unavailable (SSR, privacy mode) — fall through to an
    // ephemeral key; obfuscation still works within this page load.
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  try {
    localStorage.setItem(DEVICE_OBFUSCATION_KEY_STORAGE, btoa(String.fromCharCode(...key)));
  } catch {
    // Storage full/unavailable — won't persist across reloads, but this
    // session's own obfuscate/deobfuscate calls still match.
  }
  return key;
}

function xorWithKey(bytes: Uint8Array, keyBytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return out;
}

/**
 * Simple obfuscation with base64 + XOR
 * NOT cryptographically secure, just prevents casual reading
 *
 * Exported so other sessionStorage writers in this codebase (e.g.
 * relay-auth-store-v2.ts's signup-recovery-code display state) can reuse
 * the same per-device key instead of writing plaintext JSON, without each
 * needing to reimplement key management.
 */
export function obfuscateForStorage(data: string): string {
  const keyBytes = getOrCreateDeviceObfuscationKey();
  const dataBytes = new TextEncoder().encode(data);
  const xored = xorWithKey(dataBytes, keyBytes);
  const base64 = btoa(String.fromCharCode.apply(null, Array.from(xored)));
  return `v2:${base64}`;
}

export function deobfuscateFromStorage(encrypted: string): string {
  try {
    const [version, base64] = encrypted.split(':');
    const rawBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

    if (version === 'v2') {
      const decoded = xorWithKey(rawBytes, getOrCreateDeviceObfuscationKey());
      const result = new TextDecoder().decode(decoded);
      JSON.parse(result); // validate it's really JSON before trusting it
      return result;
    }

    if (version === 'v1') {
      // Legacy sessions written before the per-device key existed — try the
      // old hardcoded keys once so the user isn't force-logged-out. Every
      // call site re-saves under v2 immediately after a successful decode
      // here (see loadSession/loadSessionAsync), so this path is only ever
      // hit once per pre-existing session.
      const legacyKeys = ['relay-session-v1'];
      for (const key of legacyKeys) {
        try {
          const decoded = xorWithKey(rawBytes, new TextEncoder().encode(key));
          const result = new TextDecoder().decode(decoded);
          JSON.parse(result);
          return result;
        } catch {
          // Try next key
        }
      }
    }

    throw new Error('Failed to decrypt with any known key');
  } catch (err) {
    log.error('[Session] Decryption failed:', err);
    throw err;
  }
}

