/**
 * Relay Store V2
 * Manages signup/login flow with database persistence
 */

import { create } from 'zustand';
import { useEffect } from 'react';
import { TOTP } from 'otpauth';
import {
  RelayIdentity,
  generateRelayIdentity,
  createTOTPFromKey,
  createTOTPFromSecret,
  getCurrentTOTPCode,
  getTimeUntilNextTOTP,
  createStoredIdentity,
  recoverIdentity,
  verifyPIN,
  StoredIdentity,
  deriveTOTPSecret,
  toBase32,
  verifyTOTPCode,
  encryptTOTPSecretForRecovery,
  hashDuressPin,
  verifyDuressPin,
} from '@/lib/crypto/relay-auth';
import { clearAllStorage } from '@/lib/db/relay-store';
import { clearEphemeralContacts } from '@/lib/messaging/ephemeral-contacts';
import {
  initDB,
  saveUser,
  getUserByRelayId,
  getAllUsers,
  deleteUser,
  RelayUser,
} from '@/lib/db/relay-db';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { normalizeRelayId } from '@/lib/crypto/relay-id';
import { saveSession, loadSession, loadSessionAsync, isSessionValid, clearSession, updateSessionActivity, obfuscateForStorage, deobfuscateFromStorage } from '@/lib/auth/session-persistence';
import { generateRecoveryCode, hashRecoveryCode, formatRecoveryCode } from '@/lib/crypto/recovery-code';
import { log } from '@/lib/platform/logger';

/**
 * Best-effort server-side account deletion for the duress-PIN and
 * 5-failed-attempt wipe flows below. Previously those wipes only cleared
 * local IndexedDB/localStorage — the relayId, public key, WebAuthn
 * credentials, and push token all stayed live on the server forever,
 * defeating the entire point of a panic-wipe feature.
 *
 * lock() (see below) does NOT clear the httpOnly session cookie — only the
 * in-memory private key and the key material cached in sessionStorage —
 * so a session created before the device was locked is very likely still
 * live server-side at the moment a wrong/duress PIN is entered on the lock
 * screen. `credentials: 'include'` sends it along; /api/auth/delete-account
 * is session-authenticated and only ever deletes the account the request
 * is authenticated as. If no valid session exists (e.g. this device was
 * never actually logged in — restoring an identity from a backup that
 * skipped straight to the PIN screen), this 401s and is swallowed: no
 * worse than before this existed, just not improved for that case.
 */
async function deleteAccountOnServerBestEffort(): Promise<void> {
  try {
    await fetch('/api/auth/delete-account', { method: 'POST', credentials: 'include' });
  } catch {
    /* best-effort — network failure here must never block the local wipe */
  }
}

interface AuthState {
  // Flow state
  flow: 'landing' | 'signup' | 'login' | 'authenticated';
  
  // Current session
  currentUserId: string | null;
  currentRelayId: string | null;
  currentUsername: string | null;
  isUnlocked: boolean;

  // Available users for login
  availableUsers: RelayUser[];

  // Setup progress (for signup)
  signupStep: number;
  signupIdentity: RelayIdentity | null;
  signupPin: string;
  signupTOTPSecret: Uint8Array | null;
  signupRecoveryCode: string | null; // Recovery code to show user after signup
  // Second-factor method chosen at signup. 'webauthn' still derives a TOTP
  // secret internally (used for recovery-login only), it just isn't shown
  // to the user or used as the primary login factor.
  signupTwoFactorMethod: 'totp' | 'webauthn';
  // Signed ticket from a completed hardware-key registration ceremony —
  // consumed by the final signup POST. Null until registration succeeds.
  signupWebauthnTicket: string | null;

  // Current user TOTP
  currentTOTP: string | null;
  timeUntilNextTOTP: number;

  // PIN attempts
  pinAttempts: number;

  // Actions - Signup
  startSignup: () => Promise<void>;
  completeSignupStep1: () => void; // After generating identity
  chooseTwoFactorMethod: (method: 'totp' | 'webauthn') => void;
  completeSignupStep2: (totpVerificationCode: string) => Promise<boolean>; // Verify TOTP code
  completeSignupWebAuthnRegistration: () => Promise<{ success: boolean; error?: string }>; // Hardware key ceremony
  completeSignupStep3: (pin: string, confirmPin: string) => Promise<boolean>; // Set PIN
  completeRecoverCodeAcknowledgement: () => void; // User saved recovery code, proceed to app
  cancelSignup: () => void;

  // Actions - Login
  loadAvailableUsers: () => Promise<void>;
  selectUserForLogin: (relayId: string) => void;
  resolveUserInput: (input: string) => Promise<string | null>;
  attemptLogin: (pin: string) => Promise<boolean>;
  completeApiLogin: (privateKeyHex: string, publicKeyHex: string, userId: string, relayId: string, username: string | null, pqPrivateKeyHex?: string, pqPublicKeyHex?: string) => void;
  logout: () => void;
  /** Permanently delete the account, server-side and local. A live second factor is required (see /api/auth/delete-account's step-up auth). Resolves { success: false } (and does NOT wipe locally) if the server call fails, so the user can retry rather than being silently stranded. */
  deleteAccount: (stepUp: { totpCode?: string; webauthnAssertion?: unknown }) => Promise<{ success: boolean; error?: string }>;

  // Actions - Session
  refreshTOTP: () => void;
  lock: () => void;
  // Requires the PIN to authorize the wipe — the previous no-auth version let
  // anyone with a moment of unattended access to an already-open tab (or a
  // XSS/malware code path with access to the store) permanently delete a
  // stored identity with nothing more than its relayId, no proof they were
  // ever the owner.
  wipIdentity: (relayId: string, pin: string) => Promise<{ success: boolean; error?: string }>;

  // Duress PIN — set/clear the secret wipe-on-unlock PIN for the current identity.
  // Requires the real PIN to authorize the change (proves the caller can already unlock).
  setDuressPin: (realPin: string, duressPin: string) => Promise<{ success: boolean; error?: string }>;
  clearDuressPin: (realPin: string) => Promise<{ success: boolean; error?: string }>;

  // Getters
  getPrivateKey: () => Uint8Array | null;
  getPqPrivateKey: () => Uint8Array | null;
  getTOTPSecret: () => Uint8Array | null;
}

let privateKeyRef: Uint8Array | null = null;
let pqPrivateKeyRef: Uint8Array | null = null;
let totpSecretRef: Uint8Array | null = null;
let totpRef: TOTP | null = null;
let lockTimeoutRef: NodeJS.Timeout | null = null;

const LOCK_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours — user can manually lock via lock button

/** Consecutive wrong-PIN guesses before this device's local identity is wiped. */
export const MAX_PIN_ATTEMPTS = 5;

/**
 * A user-facing "N attempts remaining" warning for the PIN entry screen, or
 * null when none should be shown. `attemptNumber` is the 1-based count this
 * guess would be (i.e. pinAttempts + 1) — including the one that would
 * trigger the wipe.
 *
 * Deliberately returns null once `attemptNumber >= MAX_PIN_ATTEMPTS`: the
 * wipe itself (whether triggered by genuinely exhausting attempts, or by the
 * separate covert duress-PIN check) must never be visibly distinguishable
 * from an ordinary wrong-PIN guess (see the duress-PIN comments throughout
 * this file and app/auth/login/page.tsx) — showing "0 attempts remaining,
 * data wiped" on that exact guess would be exactly the kind of tell a
 * coercer could notice. Callers must show the same generic "Incorrect PIN"
 * text with no count on that guess and every one after, regardless of which
 * of the two wipe paths actually fired.
 */
export function pinAttemptsRemainingMessage(attemptNumber: number): string | null {
  const remaining = MAX_PIN_ATTEMPTS - attemptNumber;
  if (remaining <= 0) return null;
  return `${remaining} attempt${remaining === 1 ? '' : 's'} remaining before this device's local data is cleared.`;
}

// ─────────────────────────────────────────────────────────────────────────
// SYNCHRONOUS SESSION RESTORATION - runs at store creation time
// ─────────────────────────────────────────────────────────────────────────

// Tab-scoped only (sessionStorage, never the IndexedDB session backup which
// persists to disk) — a signup that gets interrupted by a reload/crash on
// the recovery-code page would otherwise lose the ONLY copy of that code
// (only its hash is stored server-side), get bounced to /auth/signup by
// step3's own "signupStep !== 3" redirect guard, and silently start an
// unrelated second signup with no indication the first account already
// exists. This lets a same-tab reload recover exactly where it left off;
// closing the tab still clears it same as before (recovery code display
// was never meant to survive that).
const SIGNUP_RECOVERY_KEY = 'relay:signup-recovery';

function saveSignupRecoveryState(userId: string, relayId: string, recoveryCode: string): void {
  try {
    // The recovery code is a bearer secret — anyone holding it can decrypt
    // this account's server-held TOTP backup. Every other field session-
    // persistence.ts writes to sessionStorage goes through its per-device
    // XOR key (obfuscateForStorage); this used to write plain JSON instead,
    // the one sessionStorage write in the codebase with zero obfuscation.
    sessionStorage.setItem(SIGNUP_RECOVERY_KEY, obfuscateForStorage(JSON.stringify({ userId, relayId, recoveryCode })));
  } catch (err) {
    log.warn('[Signup] Failed to persist recovery-code display state:', err);
  }
}

function clearSignupRecoveryState(): void {
  try {
    sessionStorage.removeItem(SIGNUP_RECOVERY_KEY);
  } catch { /* noop */ }
}

function loadSignupRecoveryState(userId: string, relayId: string): string | null {
  try {
    const raw = sessionStorage.getItem(SIGNUP_RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(deobfuscateFromStorage(raw)) as { userId: string; relayId: string; recoveryCode: string };
    if (parsed.userId !== userId || parsed.relayId !== relayId) return null;
    return parsed.recoveryCode;
  } catch {
    return null;
  }
}

function restoreSessionSync(): { flow: AuthState['flow']; currentUserId: string | null; currentRelayId: string | null; currentUsername: string | null; isUnlocked: boolean; signupStep: number; signupRecoveryCode: string | null } {
  const idle = { flow: 'landing' as const, currentUserId: null, currentRelayId: null, currentUsername: null, isUnlocked: false, signupStep: 0, signupRecoveryCode: null };
  try {
    // Only attempt restoration in browser environment
    if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') {
      return idle;
    }

    const session = loadSession();

    if (session && isSessionValid(session)) {
      // If the private key is available in sessionStorage, restore it and
      // skip the PIN screen. sessionStorage is tab-scoped (cleared on tab
      // close) so the key is never written to disk.
      if (session.privateKeyHex) {
        try {
          privateKeyRef = hexToBytes(session.privateKeyHex);
          pqPrivateKeyRef = session.pqPrivateKeyHex ? hexToBytes(session.pqPrivateKeyHex) : null;
          totpSecretRef = deriveTOTPSecret(privateKeyRef);
          totpRef = createTOTPFromKey(privateKeyRef);
          log.debug('[Store Init] Restored session + private key -- skipping PIN');
          return { flow: 'authenticated', currentUserId: session.userId, currentRelayId: session.relayId, currentUsername: session.username || null, isUnlocked: true, signupStep: 0, signupRecoveryCode: null };
        } catch (err) {
          log.warn('[Store Init] Failed to restore private key from session, falling back to PIN:', err);
          privateKeyRef = null;
          pqPrivateKeyRef = null;
        }
      }
      // A reload while the recovery-code screen was showing: the signup
      // actually completed (server + IndexedDB both already have the
      // account) — completeSignupStep3 deliberately does NOT put the
      // private key in this session (it's not needed again until the user
      // next locks/logs out), so session.privateKeyHex is falsy here and
      // this would otherwise fall through to "re-enter PIN," discarding
      // signupRecoveryCode entirely. Restore the recovery-code screen
      // instead — it's a read-only acknowledgment step, no key needed.
      const pendingRecoveryCode = loadSignupRecoveryState(session.userId, session.relayId);
      if (pendingRecoveryCode) {
        return { flow: 'signup', currentUserId: session.userId, currentRelayId: session.relayId, currentUsername: session.username || null, isUnlocked: false, signupStep: 3, signupRecoveryCode: pendingRecoveryCode };
      }
      // Private key not in session — user must re-enter PIN
      return { flow: 'login', currentUserId: session.userId, currentRelayId: session.relayId, currentUsername: session.username || null, isUnlocked: false, signupStep: 0, signupRecoveryCode: null };
    }

    return idle;
  } catch (err) {
    log.error('[Store Init] Session restoration error:', err);
    return idle;
  }
}

// Restore session ONCE at store creation time
const initialSessionState = restoreSessionSync();

export const useRelayAuthStoreV2 = create<AuthState>((set, get) => ({
  flow: initialSessionState.flow,
  currentUserId: initialSessionState.currentUserId,
  currentRelayId: initialSessionState.currentRelayId,
  currentUsername: initialSessionState.currentUsername,
  isUnlocked: initialSessionState.isUnlocked,
  availableUsers: [],
  signupStep: initialSessionState.signupStep,
  signupIdentity: null,
  signupPin: '',
  signupTOTPSecret: null,
  signupRecoveryCode: initialSessionState.signupRecoveryCode,
  signupTwoFactorMethod: 'totp',
  signupWebauthnTicket: null,
  currentTOTP: initialSessionState.isUnlocked && totpRef ? getCurrentTOTPCode(totpRef) : null,
  timeUntilNextTOTP: initialSessionState.isUnlocked && totpRef ? getTimeUntilNextTOTP() : 30,
  pinAttempts: 0,

  // Signup Flow
  startSignup: async () => {
    try {
      const identity = await generateRelayIdentity();
      const totpSecret = deriveTOTPSecret(identity.privateKey);

      set({
        flow: 'signup',
        signupStep: 1,
        signupIdentity: identity,
        signupTOTPSecret: totpSecret,
        signupPin: '',
      });
    } catch (error) {
      log.error('Failed to start signup:', error);
      throw error;
    }
  },

  completeSignupStep1: () => {
    set({ signupStep: 2 });
  },

  chooseTwoFactorMethod: (method: 'totp' | 'webauthn') => {
    set({ signupTwoFactorMethod: method, signupWebauthnTicket: null });
  },

  completeSignupWebAuthnRegistration: async () => {
    const { signupIdentity } = get();
    if (!signupIdentity) return { success: false, error: 'No signup identity found' };

    try {
      const { registerHardwareKeyForSignup } = await import('@/lib/crypto/webauthn-client');
      const ticket = await registerHardwareKeyForSignup(signupIdentity.relayId);
      set({ signupWebauthnTicket: ticket, signupStep: 3 });
      return { success: true };
    } catch (error) {
      log.error('Hardware key registration failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Registration failed' };
    }
  },

  completeSignupStep2: async (totpVerificationCode: string) => {
    const { signupTOTPSecret } = get();
    if (!signupTOTPSecret) return false;

    try {
      // Create TOTP instance from the already-derived secret
      // (NOT from private key - that would derive it again!)
      const totp = createTOTPFromSecret(signupTOTPSecret);
      
      // Get current code for debugging
      const currentCode = totp.generate();
      log.debug('TOTP Verification Debug:');
      log.debug('  Entered Code:', totpVerificationCode);
      log.debug('  Current Code:', currentCode);
      
      // Verify code with time window (accepts current and previous 30-sec window)
      const isValid = verifyTOTPCode(totp, totpVerificationCode);
      log.debug('  Verification Result:', isValid);

      if (!isValid) {
        log.debug('  Code mismatch - verification failed');
        return false;
      }

      set({ signupStep: 3 });
      return true;
    } catch (error) {
      log.error('Failed to verify TOTP:', error);
      return false;
    }
  },

  completeSignupStep3: async (pin: string, confirmPin: string) => {
    if (pin !== confirmPin) {
      log.error('PIN mismatch in store');
      return false;
    }

    try {
      const { signupIdentity, signupTOTPSecret, signupTwoFactorMethod, signupWebauthnTicket } = get();
      if (!signupIdentity) {
        log.error('No signup identity found');
        return false;
      }
      if (signupTwoFactorMethod === 'webauthn' && !signupWebauthnTicket) {
        log.error('Hardware key was selected but registration was not completed');
        return false;
      }

      // Generate recovery code
      const recoveryCode = generateRecoveryCode();
      const recoveryCodeHash = hashRecoveryCode(recoveryCode);

      // Use relayId as the user ID (it's unique and cryptographically derived)
      const userId = signupIdentity.relayId;
      const totpSecretToStore = signupTOTPSecret || deriveTOTPSecret(signupIdentity.privateKey);

      // Encrypt TOTP secret with recovery code for account recovery
      const encryptedTOTPSecretForRecovery = encryptTOTPSecretForRecovery(totpSecretToStore, recoveryCode);

      log.debug('Creating stored identity with PIN...');
      // Create stored identity with PIN — encrypts the classical private key,
      // the PQ private key, and the local TOTP-secret copy with the same
      // PIN-derived storage key.
      const storedIdentity = await createStoredIdentity(signupIdentity, pin, totpSecretToStore);

      // Get device fingerprint for storage (needed for PIN recovery later)
      const { getDeviceFingerprint } = await import('@/lib/crypto/relay-auth');
      const deviceFingerprint = getDeviceFingerprint();

      const user: RelayUser = {
        id: userId,
        relayId: signupIdentity.relayId,
        publicKeyHex: bytesToHex(signupIdentity.publicKey),
        encryptedPrivateKey: bytesToHex(storedIdentity.encryptedPrivateKey),
        encryptedTOTPSecret: bytesToHex(storedIdentity.encryptedTOTPSecretLocal!),
        encryptedTOTPSecretForRecovery: bytesToHex(encryptedTOTPSecretForRecovery),
        deviceFingerprint: deviceFingerprint,
        createdAt: Date.now(),
        recoveryCodeHash: recoveryCodeHash,
        // Post-quantum keys (hybrid X25519 + ML-KEM768) — private key is
        // PIN-encrypted the same way as the classical private key.
        pqPublicKeyHex: signupIdentity.pqPublicKey ? bytesToHex(signupIdentity.pqPublicKey) : undefined,
        pqPrivateKeyHex: storedIdentity.encryptedPqPrivateKey ? bytesToHex(storedIdentity.encryptedPqPrivateKey) : undefined,
        twoFactorMethod: signupTwoFactorMethod,
      };

      log.debug('Saving user to database...', { relayId: user.relayId, deviceFingerprint });
      await initDB();
      await saveUser(user);
      log.debug('User saved to IndexedDB:', user.relayId);

      // Save to server database — REQUIRED for login to work.
      // Only send public / non-sensitive fields — private key material stays in IndexedDB only.
      // The wire field name `encryptedTOTPSecret` is misleading: this value
      // is the RAW, plaintext TOTP secret, protected only by TLS in
      // transit (not by any application-layer encryption) — it is NOT the
      // PIN-encrypted `encryptedTOTPSecretLocal` stored in IndexedDB above.
      // The server encrypts it with TOTP_ENCRYPTION_KEY before persisting
      // (see app/api/auth/signup/route.ts + totp-server-encryption.ts).
      // This is inherent to server-verified TOTP (the server must hold
      // something that can generate a valid code); the field name is kept
      // for backward wire-protocol compatibility, not accuracy.
      const serverPayload = {
        id: user.id,
        relayId: user.relayId,
        publicKeyHex: user.publicKeyHex,
        encryptedTOTPSecret: bytesToHex(totpSecretToStore),
        encryptedTOTPSecretForRecovery: user.encryptedTOTPSecretForRecovery,
        recoveryCodeHash: user.recoveryCodeHash,
        pqPublicKeyHex: user.pqPublicKeyHex,
        twoFactorMethod: signupTwoFactorMethod,
        webauthnTicket: signupWebauthnTicket ?? undefined,
        // NOT sent: encryptedPrivateKey, pqPrivateKeyHex, deviceFingerprint
      };
      try {
        const response = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(serverPayload),
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: 'Unknown error' }));
          log.error('Server signup failed:', errData);
          // Roll back IndexedDB save since server sync failed
          await deleteUser(userId);
          throw new Error(`Account creation failed: ${errData.error || 'Server error'}. Please try again.`);
        }
        log.debug('User saved to server database');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Account creation failed')) {
          throw error; // Re-throw our own rollback errors
        }
        log.error('Error saving to server database:', error);
        await deleteUser(userId);
        throw new Error('Failed to create account — could not reach the server. Please try again.');
      }

      // Persist session now so the private key is available when the user
      // lands on /app after acknowledging the recovery code.
      privateKeyRef = signupIdentity.privateKey;
      pqPrivateKeyRef = signupIdentity.pqPrivateKey || null;
      totpSecretRef = totpSecretToStore;
      totpRef = createTOTPFromKey(privateKeyRef);

      saveSession({
        userId,
        relayId: signupIdentity.relayId,
        publicKeyHex: user.publicKeyHex,
        sessionToken: `${signupIdentity.relayId}-${Date.now()}`,
        loginTime: Date.now(),
        lastActivityTime: Date.now(),
      });

      const formattedRecoveryCode = formatRecoveryCode(recoveryCode);
      // Tab-scoped backup so a reload on this screen doesn't lose the only
      // copy of the recovery code — see restoreSessionSync.
      saveSignupRecoveryState(userId, signupIdentity.relayId, formattedRecoveryCode);

      set({
        flow: 'signup', // Stay in signup to show recovery code
        currentUserId: userId,
        currentRelayId: signupIdentity.relayId,
        signupStep: 3, // New step: Display recovery code
        signupRecoveryCode: formattedRecoveryCode, // Show formatted code
        signupIdentity: null,
        signupPin: '',
        signupTOTPSecret: null,
      });

      // Auto-lock disabled — user can lock manually via the lock button

      return true;
    } catch (error) {
      log.error('Failed to complete signup:', error);
      return false;
    }
  },

  cancelSignup: () => {
    clearSignupRecoveryState();
    set({
      flow: 'landing',
      signupStep: 0,
      signupIdentity: null,
      signupPin: '',
      signupTOTPSecret: null,
      signupRecoveryCode: null,
    });
  },

  completeRecoverCodeAcknowledgement: () => {
    const { currentRelayId } = get();
    
    if (!currentRelayId) {
      log.error('No relayId set');
      return;
    }

    // User has saved recovery code, now set up authenticated session
    if (!totpRef) {
      log.error('No TOTP reference available');
      return;
    }

    const totpCode = getCurrentTOTPCode(totpRef);
    const timeLeft = getTimeUntilNextTOTP();

    clearSignupRecoveryState();

    set({
      flow: 'authenticated',
      isUnlocked: true,
      currentTOTP: totpCode,
      timeUntilNextTOTP: timeLeft,
      signupStep: 0,
      signupRecoveryCode: null,
    });

    // Set auto-lock timeout
    if (lockTimeoutRef) clearTimeout(lockTimeoutRef);
    lockTimeoutRef = setTimeout(() => {
      get().lock();
    }, LOCK_TIMEOUT);
  },

  // Login Flow
  loadAvailableUsers: async () => {
    try {
      await initDB();
      const localUsers = await getAllUsers();

      // Validate each local user against the server DB (in parallel — these are
      // independent lookups, no need to serialize one round-trip per stored identity).
      // This prevents showing accounts that failed server sync.
      const checks = await Promise.all(
        localUsers.map(async (user) => {
          try {
            const res = await fetch('/api/auth/username-lookup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ input: user.relayId }),
            });
            return { user, valid: res.ok };
          } catch {
            // Network error — keep user to avoid data loss
            return { user, valid: true };
          }
        })
      );

      const validUsers: RelayUser[] = [];
      await Promise.all(
        checks.map(async ({ user, valid }) => {
          if (valid) {
            validUsers.push(user);
          } else {
            // User exists in IndexedDB but not on server — remove stale entry
            log.warn(`[Auth] Removing stale IndexedDB entry for ${user.relayId} (not found on server)`);
            await deleteUser(user.id);
          }
        })
      );
      set({ availableUsers: validUsers, flow: 'login' });
    } catch (error) {
      log.error('Failed to load users:', error);
    }
  },

  selectUserForLogin: (relayId: string) => {
    set({ currentRelayId: relayId, pinAttempts: 0 });
    // Hydrate the real persisted count once it loads. Without this, the
    // login page's duress-PIN synthetic message (which reads pinAttempts
    // directly to stay indistinguishable from a genuine guess at the same
    // position) would show attempt-#1 wording right after a reload even
    // when the real persisted count is higher — a distinguishable
    // mismatch from what a genuine guess at that position would show,
    // undermining the exact indistinguishability property
    // pinAttemptsRemainingMessage exists to preserve. Guarded on
    // currentRelayId still matching in case the user switches accounts
    // again before this resolves.
    getUserByRelayId(relayId)
      .then((user) => {
        if (user && get().currentRelayId === relayId) {
          set({ pinAttempts: user.failedPinAttempts ?? 0 });
        }
      })
      .catch(() => {});
  },

  resolveUserInput: async (input: string): Promise<string | null> => {
    const trimmed = input.trim();

    // 1. Check local IndexedDB first — works offline and for users without server usernames
    try {
      const canonical = normalizeRelayId(trimmed);
      if (canonical) {
        const localUser = await getUserByRelayId(canonical);
        if (localUser) return localUser.relayId;
      } else {
        const lower = trimmed.toLowerCase();
        const normalized = lower.replace(/^@/, '');
        const allUsers = await getAllUsers();
        const localUser = allUsers.find((u) => u.username?.toLowerCase() === normalized);
        if (localUser) return localUser.relayId;
      }
    } catch {
      // Local DB unavailable — fall through to server
    }

    // 2. Fall back to server lookup (finds users by username across all devices)
    try {
      const response = await fetch('/api/auth/username-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: trimmed }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.relayId;
      }
      return null;
    } catch (error) {
      log.error('Failed to resolve user input:', error);
      return null;
    }
  },

  attemptLogin: async (pin: string) => {
    try {
      const { currentRelayId } = get();
      if (!currentRelayId) return false;

      const user = await getUserByRelayId(currentRelayId);
      if (!user) return false;
      // Read from the persisted IndexedDB record, not Zustand's in-memory
      // pinAttempts — that field lives only in JS memory (this store has no
      // persist() middleware) and resets to 0 on any page reload, which
      // let an attacker guess indefinitely at one PIN per reload with the
      // 5-attempt wipe never actually triggering.
      const priorAttempts = user.failedPinAttempts ?? 0;

      // Decode encrypted data
      const encryptedPrivateKey = hexToBytes(user.encryptedPrivateKey);
      const publicKey = hexToBytes(user.publicKeyHex);

      // Create StoredIdentity object
      const storedIdentity: StoredIdentity = {
        encryptedPrivateKey,
        publicKey,
        relayId: user.relayId,
        version: 1,
        encryptedPqPrivateKey: user.pqPrivateKeyHex ? hexToBytes(user.pqPrivateKeyHex) : undefined,
      };

      // Try to recover identity using stored device fingerprint. The duress-PIN
      // check runs concurrently (not after) so a coercer watching timing can't
      // tell the two checks apart — both cost the same PBKDF2 200k-iteration work.
      try {
        const [identityResult, isDuress] = await Promise.all([
          recoverIdentity(storedIdentity, pin, user.deviceFingerprint).then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error })
          ),
          user.duressPinHash
            ? verifyDuressPin(pin, user.deviceFingerprint, user.duressPinHash)
            : Promise.resolve(false),
        ]);

        if (isDuress) {
          // Silent wipe: delete the identity and all local app data, but
          // return exactly like a wrong PIN below — no UI tell that this was
          // a duress trigger rather than a typo.
          await deleteUser(user.id);
          await clearAllStorage().catch(() => {});
          clearEphemeralContacts();
          void deleteAccountOnServerBestEffort();
          set({ availableUsers: get().availableUsers.filter((u) => u.id !== user.id) });
          return false;
        }

        if (!identityResult.ok) throw identityResult.error;
        const identity = identityResult.value;

        // Success! Set up session
        privateKeyRef = identity.privateKey;
        pqPrivateKeyRef = identity.pqPrivateKey || null;
        totpSecretRef = deriveTOTPSecret(identity.privateKey);
        totpRef = createTOTPFromKey(identity.privateKey);

        const totpCode = getCurrentTOTPCode(totpRef);
        const timeLeft = getTimeUntilNextTOTP();

        // Try to get username from server profile lookup
        let username: string | null = null;
        try {
          const response = await fetch(`/api/profile/lookup?relayId=${encodeURIComponent(user.relayId)}`);
          if (response.ok) {
            const profile = await response.json();
            username = profile.username || null;
          }
        } catch (err) {
          log.warn('Failed to fetch username from server:', err);
        }

        set({
          flow: 'authenticated',
          currentUserId: user.id,
          currentRelayId: user.relayId,
          currentUsername: username,
          isUnlocked: true,
          currentTOTP: totpCode,
          timeUntilNextTOTP: timeLeft,
          pinAttempts: 0,
        });

        // Clear the persisted failed-attempt count on success — mirrors the
        // server-side updateLastLogin's failedLoginAttempts reset.
        if (priorAttempts > 0) {
          await saveUser({ ...user, failedPinAttempts: 0 }).catch(() => {});
        }

        // Save session to sessionStorage for persistence across refresh
        saveSession({
          userId: user.id || user.relayId,
          relayId: user.relayId,
          privateKeyHex: bytesToHex(identity.privateKey),
          pqPrivateKeyHex: identity.pqPrivateKey ? bytesToHex(identity.pqPrivateKey) : undefined,
          publicKeyHex: bytesToHex(identity.publicKey),
          username: username || undefined,
          sessionToken: `${user.relayId}-${Date.now()}`,
          loginTime: Date.now(),
          lastActivityTime: Date.now(),
        });

        // Set auto-lock timeout
        if (lockTimeoutRef) clearTimeout(lockTimeoutRef);
        lockTimeoutRef = setTimeout(() => {
          get().lock();
        }, LOCK_TIMEOUT);

        return true;
      } catch (error) {
        // Wrong PIN
        const newAttempts = priorAttempts + 1;
        set({ pinAttempts: newAttempts });
        // Persisted durably — see priorAttempts' comment above. Written
        // before the wipe-threshold check below so the count survives even
        // if the wipe itself is interrupted (e.g. tab closed mid-wipe).
        await saveUser({ ...user, failedPinAttempts: newAttempts }).catch(() => {});

        if (newAttempts >= MAX_PIN_ATTEMPTS) {
          // Wipe identity after 5 failed attempts — same full wipe as the
          // duress-PIN path above (IndexedDB + localStorage + ephemeral
          // contacts), not just the user record, for the same reason: a
          // partial wipe leaves group rosters/messages and other
          // localStorage-persisted state fully recoverable.
          await deleteUser(user.id);
          await clearAllStorage().catch(() => {});
          clearEphemeralContacts();
          void deleteAccountOnServerBestEffort();
          set({
            availableUsers: get().availableUsers.filter((u) => u.id !== user.id),
          });
          throw new Error('Too many failed PIN attempts. Identity wiped.');
        }

        return false;
      }
    } catch (error) {
      log.error('Login error:', error);
      throw error;
    }

    return false;
  },

  completeApiLogin: (privateKeyHex: string, publicKeyHex: string, userId: string, relayId: string, username: string | null, pqPrivateKeyHex?: string, pqPublicKeyHex?: string) => {
    // Properly set all module-level refs so getPrivateKey() returns the right key.
    // The login page uses a server-API path that bypasses attemptLogin, so we must
    // update privateKeyRef here or the messaging hook will use a stale key.
    privateKeyRef = hexToBytes(privateKeyHex);
    pqPrivateKeyRef = pqPrivateKeyHex ? hexToBytes(pqPrivateKeyHex) : null;
    totpSecretRef = deriveTOTPSecret(privateKeyRef);
    totpRef = createTOTPFromKey(privateKeyRef);

    const totpCode = getCurrentTOTPCode(totpRef);
    const timeLeft = getTimeUntilNextTOTP();

    saveSession({
      userId,
      relayId,
      publicKeyHex,
      privateKeyHex,
      pqPrivateKeyHex,
      pqPublicKeyHex,
      username: username || undefined,
      sessionToken: `login-${Date.now()}`,
      loginTime: Date.now(),
      lastActivityTime: Date.now(),
    });

    if (lockTimeoutRef) clearTimeout(lockTimeoutRef);
    lockTimeoutRef = setTimeout(() => {
      get().lock();
    }, LOCK_TIMEOUT);

    set({
      flow: 'authenticated',
      currentUserId: userId,
      currentRelayId: relayId,
      currentUsername: username,
      isUnlocked: true,
      currentTOTP: totpCode,
      timeUntilNextTOTP: timeLeft,
      pinAttempts: 0,
    });
  },

  logout: () => {
    privateKeyRef = null;
    pqPrivateKeyRef = null;
    totpSecretRef = null;
    totpRef = null;
    if (lockTimeoutRef) clearTimeout(lockTimeoutRef);
    clearSession(); // Clear sessionStorage session
    clearEphemeralContacts(); // Ghost contacts from this identity must not bleed into the next login in this tab

    // Revoke the HttpOnly session cookie server-side. Fire-and-forget —
    // even if the network call fails the client state is already cleared.
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});

    set({
      flow: 'login',
      currentUserId: null,
      currentRelayId: null,
      currentUsername: null,
      isUnlocked: false,
      currentTOTP: null,
      pinAttempts: 0,
    });
  },

  /**
   * User-initiated, explicit "delete my account" action (Settings' danger
   * zone) — distinct from the duress-PIN/5-failed-attempt wipe flows above,
   * which are covert and always report success regardless of what actually
   * happened server-side. This one is a deliberate action with visible UI
   * feedback, so unlike those, a failed server call does NOT wipe local
   * state — better to let the user retry than strand them having wiped
   * their only copy of the identity while the server account still exists.
   */
  deleteAccount: async (stepUp) => {
    const userId = get().currentUserId;
    try {
      const response = await fetch('/api/auth/delete-account', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stepUp),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: err.error || 'Failed to delete account' };
      }
    } catch {
      return { success: false, error: 'Could not reach the server' };
    }

    if (userId) await deleteUser(userId).catch(() => {});
    await clearAllStorage().catch(() => {});
    clearEphemeralContacts();
    clearSession();
    if (lockTimeoutRef) clearTimeout(lockTimeoutRef);
    privateKeyRef = null;
    pqPrivateKeyRef = null;
    totpSecretRef = null;
    totpRef = null;

    set({
      flow: 'landing',
      currentUserId: null,
      currentRelayId: null,
      currentUsername: null,
      isUnlocked: false,
      currentTOTP: null,
      pinAttempts: 0,
      availableUsers: get().availableUsers.filter((u) => u.id !== userId),
    });
    return { success: true };
  },

  lock: () => {
    privateKeyRef = null;
    pqPrivateKeyRef = null;
    totpSecretRef = null;
    totpRef = null;
    if (lockTimeoutRef) clearTimeout(lockTimeoutRef);

    // Remove the private key from session so the user must re-enter PIN
    try {
      const session = loadSession();
      if (session) {
        session.privateKeyHex = undefined;
        session.pqPrivateKeyHex = undefined;
        saveSession(session);
      }
    } catch { /* best-effort */ }

    set({
      flow: 'login',
      isUnlocked: false,
      currentTOTP: null,
    });
  },

  refreshTOTP: () => {
    if (!totpRef) return;

    const totpCode = getCurrentTOTPCode(totpRef);
    const timeLeft = getTimeUntilNextTOTP();

    set({
      currentTOTP: totpCode,
      timeUntilNextTOTP: timeLeft,
    });
  },

  wipIdentity: async (relayId: string, pin: string) => {
    try {
      const user = await getUserByRelayId(relayId);
      if (!user) return { success: false, error: 'Account not found' };

      const storedIdentity: StoredIdentity = {
        encryptedPrivateKey: hexToBytes(user.encryptedPrivateKey),
        publicKey: hexToBytes(user.publicKeyHex),
        relayId: user.relayId,
        version: 1,
        encryptedPqPrivateKey: user.pqPrivateKeyHex ? hexToBytes(user.pqPrivateKeyHex) : undefined,
      };
      const pinValid = await verifyPIN(storedIdentity, pin, user.deviceFingerprint);
      if (!pinValid) return { success: false, error: 'Incorrect PIN' };

      await deleteUser(user.id);
      set({ availableUsers: get().availableUsers.filter((u) => u.relayId !== relayId) });
      if (get().currentRelayId === relayId) get().logout();
      return { success: true };
    } catch (error) {
      log.error('Failed to wipe identity:', error);
      return { success: false, error: 'Failed to wipe identity' };
    }
  },

  setDuressPin: async (realPin: string, duressPin: string) => {
    const { currentRelayId } = get();
    if (!currentRelayId) return { success: false, error: 'Not logged in' };
    if (!duressPin || duressPin === realPin) {
      return { success: false, error: 'Duress PIN must be different from your real PIN' };
    }

    const user = await getUserByRelayId(currentRelayId);
    if (!user) return { success: false, error: 'Account not found' };

    const storedIdentity: StoredIdentity = {
      encryptedPrivateKey: hexToBytes(user.encryptedPrivateKey),
      publicKey: hexToBytes(user.publicKeyHex),
      relayId: user.relayId,
      version: 1,
      encryptedPqPrivateKey: user.pqPrivateKeyHex ? hexToBytes(user.pqPrivateKeyHex) : undefined,
    };
    const realPinValid = await verifyPIN(storedIdentity, realPin, user.deviceFingerprint);
    if (!realPinValid) return { success: false, error: 'Incorrect PIN' };

    const duressPinHash = await hashDuressPin(duressPin, user.deviceFingerprint);
    await saveUser({ ...user, duressPinHash });
    return { success: true };
  },

  clearDuressPin: async (realPin: string) => {
    const { currentRelayId } = get();
    if (!currentRelayId) return { success: false, error: 'Not logged in' };

    const user = await getUserByRelayId(currentRelayId);
    if (!user) return { success: false, error: 'Account not found' };

    const storedIdentity: StoredIdentity = {
      encryptedPrivateKey: hexToBytes(user.encryptedPrivateKey),
      publicKey: hexToBytes(user.publicKeyHex),
      relayId: user.relayId,
      version: 1,
      encryptedPqPrivateKey: user.pqPrivateKeyHex ? hexToBytes(user.pqPrivateKeyHex) : undefined,
    };
    const realPinValid = await verifyPIN(storedIdentity, realPin, user.deviceFingerprint);
    if (!realPinValid) return { success: false, error: 'Incorrect PIN' };

    const { duressPinHash: _drop, ...rest } = user;
    await saveUser(rest as RelayUser);
    return { success: true };
  },

  getPrivateKey: () => privateKeyRef,
  getPqPrivateKey: () => pqPrivateKeyRef,
  getTOTPSecret: () => totpSecretRef,
}));

// If a session was restored, set up the auto-lock timeout
if (initialSessionState.isUnlocked) {
  log.debug('[Store Init] Session restored with private key -- no auto-lock');
}

/**
 * Hook for refreshing TOTP periodically
 */
export function useTOTPRefreshV2() {
  const { refreshTOTP, isUnlocked } = useRelayAuthStoreV2();

  useEffect(() => {
    if (!isUnlocked) return;

    refreshTOTP();
    const interval = setInterval(refreshTOTP, 1000);

    return () => clearInterval(interval);
  }, [isUnlocked, refreshTOTP]);
}

/**
 * Hook for auto-locking
 */
export function useAutoLockV2() {
  const { isUnlocked } = useRelayAuthStoreV2();

  // Auto-lock disabled — users lock manually via the lock button in the header.
  // We still keep the session activity timestamp fresh for session validation.
  useEffect(() => {
    if (!isUnlocked) return;

    const updateActivity = () => {
      try {
        const session = loadSession();
        if (session) {
          saveSession(updateSessionActivity(session));
        }
      } catch { /* non-critical */ }
    };

    // Update activity every 5 minutes to keep session alive
    const interval = setInterval(updateActivity, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [isUnlocked]);
}

/**
 * Hook to initialize auth on app load
 * Tries sessionStorage first (sync), then IndexedDB backup (async)
 */
export function useInitializeAuthV2() {
  const store = useRelayAuthStoreV2();

  useEffect(() => {
    const initializeAuth = async () => {
      const currentState = useRelayAuthStoreV2.getState();

      // If restoreSessionSync already authenticated (private key in session),
      // don't overwrite with 'login'. Just load the user list and move on.
      if (currentState.flow === 'authenticated' && currentState.isUnlocked) {
        log.debug('[Auth] Already authenticated from session restore -- skipping PIN');
        await store.loadAvailableUsers();
        return;
      }

      // Try sessionStorage (sync) then IndexedDB (async)
      const session = await loadSessionAsync();

      if (session && isSessionValid(session)) {
        // Check if we can restore the private key from session
        if (session.privateKeyHex && !privateKeyRef) {
          try {
            privateKeyRef = hexToBytes(session.privateKeyHex);
            pqPrivateKeyRef = session.pqPrivateKeyHex ? hexToBytes(session.pqPrivateKeyHex) : null;
            totpSecretRef = deriveTOTPSecret(privateKeyRef);
            totpRef = createTOTPFromKey(privateKeyRef);
            log.debug('[Auth] Restored private key from session -- auto-authenticating');
            useRelayAuthStoreV2.setState({
              flow: 'authenticated',
              currentUserId: session.userId,
              currentRelayId: session.relayId,
              currentUsername: session.username || null,
              isUnlocked: true,
            });
            await store.loadAvailableUsers();
            return;
          } catch (err) {
            log.warn('[Auth] Failed to restore private key:', err);
            privateKeyRef = null;
          }
        }

        // No private key available — user must re-enter PIN
        log.debug('[Auth] Valid session but no private key -- PIN required');
        useRelayAuthStoreV2.setState({
          flow: 'login',
          currentUserId: session.userId,
          currentRelayId: session.relayId,
          currentUsername: session.username || null,
          isUnlocked: false,
        });
        await store.loadAvailableUsers();
      } else {
        store.loadAvailableUsers();
      }
    };

    initializeAuth();
  }, []); // Empty dependency array - only run once on mount
}
