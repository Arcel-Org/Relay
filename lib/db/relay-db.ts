/**
 * Relay Database
 * Stores encrypted user identities locally in IndexedDB
 */

import { log } from '@/lib/platform/logger';

export interface RelayUser {
  id: string; // UUID
  relayId: string; // bare relay ID: xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx
  publicKeyHex: string; // hex encoded X25519 public key
  encryptedPrivateKey: string; // hex encoded, PIN-encrypted private key
  encryptedTOTPSecret: string; // hex encoded, PIN-encrypted TOTP secret (local copy only — never decrypted for use, app recomputes from privateKey)
  encryptedTOTPSecretForRecovery: string; // hex encoded TOTP secret encrypted with recovery code
  deviceFingerprint: string; // device fingerprint used for key derivation
  createdAt: number; // timestamp
  lastLogin?: number;
  username?: string; // claimed username
  displayName?: string; // display name
  recoveryCodeHash?: string; // SHA-256 hash of recovery code for account recovery
  // Post-quantum cryptography (ML-KEM768)
  pqPublicKeyHex?: string; // hex encoded ML-KEM768 public key
  pqPrivateKeyHex?: string; // hex encoded, PIN-encrypted ML-KEM768 private key
  // Second-factor method chosen at signup — determines whether login prompts
  // for a TOTP code or a hardware-key tap. Defaults to 'totp' if unset
  // (accounts created before this field existed).
  twoFactorMethod?: 'totp' | 'webauthn';
  // Duress PIN: hex PBKDF2 hash (see hashDuressPin). When set, entering this
  // PIN at login wipes the identity instead of unlocking it, while showing
  // the same UI as a wrong PIN. Never store the duress PIN itself, only its hash.
  duressPinHash?: string;
  // Consecutive wrong-PIN count, persisted (not just held in Zustand state)
  // specifically so the wipe-after-5-attempts guarantee survives a page
  // reload — see relay-auth-store-v2.ts's attemptLogin. Reset to 0 on a
  // successful login.
  failedPinAttempts?: number;
}

// NOTE: IndexedDB name kept as 'polar_auth' for backward compatibility with
// existing deployed users. Renaming would orphan their encrypted identities.
const DB_NAME = 'polar_auth';
const DB_VERSION = 2;
const STORE_NAME = 'users';

let db: IDBDatabase | null = null;

/**
 * Initialize the database
 */
export async function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open database'));
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('relayId', 'relayId', { unique: true });
      }
    };
  });
}

/**
 * Get database instance
 */
async function getDB(): Promise<IDBDatabase> {
  if (!db) {
    db = await initDB();
  }
  return db;
}

/**
 * Save a user to the database
 */
export async function saveUser(user: RelayUser): Promise<void> {
  const database = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(user);

    request.onerror = () => {
      reject(new Error('Failed to save user'));
    };

    request.onsuccess = () => {
      resolve();
    };
  });
}

/**
 * Get user by Relay ID
 */
export async function getUserByRelayId(relayId: string): Promise<RelayUser | null> {
  const database = await getDB();

  return new Promise<RelayUser | null>((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('relayId');
    const request = index.get(relayId);

    request.onerror = () => {
      reject(new Error('Failed to get user'));
    };

    request.onsuccess = () => {
      resolve(request.result || null);
    };
  });
}

/**
 * Get all users
 */
export async function getAllUsers(): Promise<RelayUser[]> {
  const database = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onerror = () => {
      reject(new Error('Failed to get users'));
    };

    request.onsuccess = () => {
      resolve((request.result || []) as RelayUser[]);
    };
  });
}

/**
 * Delete user by ID
 */
export async function deleteUser(id: string): Promise<void> {
  const database = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onerror = () => {
      reject(new Error('Failed to delete user'));
    };

    request.onsuccess = () => {
      resolve();
    };
  });
}

/**
 * Check if any users exist
 */
export async function hasUsers(): Promise<boolean> {
  const users = await getAllUsers();
  return users.length > 0;
}

/**
 * Clear all users (wipe all identities)
 */
export async function clearAllUsers(): Promise<void> {
  const database = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onerror = () => {
      reject(new Error('Failed to clear users'));
    };

    request.onsuccess = () => {
      resolve();
    };
  });
}
