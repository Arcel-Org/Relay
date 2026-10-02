'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useRelayAuthStoreV2, pinAttemptsRemainingMessage, MAX_PIN_ATTEMPTS } from '@/lib/crypto/relay-auth-store-v2';
import { recoverIdentity, verifyDuressPin, verifyTOTPCode, createTOTPFromSecret, deriveTOTPSecret } from '@/lib/crypto/relay-auth';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { getUserByRelayId, deleteUser, type RelayUser } from '@/lib/db/relay-db';
import { clearAllStorage } from '@/lib/db/relay-store';
import { clearEphemeralContacts } from '@/lib/messaging/ephemeral-contacts';
import { authenticateWithHardwareKey } from '@/lib/crypto/webauthn-client';
import { KeyRound } from 'lucide-react';
import { RelayLogo } from '@/components/RelayLogo';
import { motion } from 'framer-motion';
import { log } from '@/lib/platform/logger';

export default function LoginPage() {
  const router = useRouter();
  const { currentRelayId, availableUsers, loadAvailableUsers, selectUserForLogin, resolveUserInput, attemptLogin, completeApiLogin, pinAttempts } = useRelayAuthStoreV2();
  const [userInput, setUserInput] = useState(''); // For username or relayId input
  const [inputError, setInputError] = useState('');
  const [isResolvingInput, setIsResolvingInput] = useState(false);
  const [showDirectInput, setShowDirectInput] = useState(false);
  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState('');
  const [recoveryCodeEntry, setRecoveryCodeEntry] = useState('');
  const [recoveryCodeError, setRecoveryCodeError] = useState('');
  // Optional — see the duress check in handleLogin's isRecoveryMode branch.
  // The PIN toggle isn't shown/required here: the recovery-code path exists
  // specifically for "I forgot my PIN," so requiring one would defeat its
  // purpose. But leaving Recovery Code as an unconditional duress bypass
  // (any coerced user just picks this tab instead of PIN) defeats the
  // duress feature's purpose just as badly — this field lets a user who
  // still remembers their duress PIN trigger the same wipe here too,
  // without forcing everyone through PIN entry to use this recovery path.
  const [recoveryPinEntry, setRecoveryPinEntry] = useState('');
  const [isRecoveryMode, setIsRecoveryMode] = useState(false);
  const [totpEntry, setTotpEntry] = useState('');
  const [totpError, setTotpError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [localUser, setLocalUser] = useState<RelayUser | null>(null);
  const [webauthnError, setWebauthnError] = useState('');

  useEffect(() => {
    const load = async () => {
      await loadAvailableUsers();
      setIsLoading(false);
    };
    load();
  }, [loadAvailableUsers]);

  // Look up the selected account locally to know which second-factor method
  // to show — determined per-account at signup, defaults to 'totp' for
  // accounts created before this field existed.
  useEffect(() => {
    if (!currentRelayId) {
      setLocalUser(null);
      return;
    }
    getUserByRelayId(currentRelayId).then(setLocalUser).catch(() => setLocalUser(null));
  }, [currentRelayId]);

  const loginMethod: 'totp' | 'webauthn' = localUser?.twoFactorMethod === 'webauthn' ? 'webauthn' : 'totp';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    let hasError = false;

    if (isRecoveryMode) {
      // Recovery code login: requires recovery code + TOTP
      if (recoveryCodeEntry.length === 0) {
        setRecoveryCodeError('Recovery code is required');
        hasError = true;
      } else {
        setRecoveryCodeError('');
      }

      if (totpEntry.length !== 6) {
        setTotpError('Authenticator code must be 6 digits');
        hasError = true;
      } else {
        setTotpError('');
      }
    } else {
      // Normal login: requires PIN always. TOTP code only for 'totp' accounts —
      // 'webauthn' accounts prove the second factor via a hardware-key tap instead.
      if (loginMethod === 'totp' && totpEntry.length !== 6) {
        setTotpError('Authenticator code must be 6 digits');
        hasError = true;
      } else {
        setTotpError('');
      }

      if (pinEntry.length !== 6) {
        setPinError('PIN must be 6 digits');
        hasError = true;
      } else {
        setPinError('');
      }
    }

    if (hasError) return;

    setIsSubmitting(true);
    try {
      if (!currentRelayId) {
        setPinError('No user selected. Please select a user first.');
        return;
      }

      if (isRecoveryMode) {
        // Duress check, mirroring the normal-PIN branch below: if this
        // device has a local record with a duress PIN configured and the
        // (optional) field here matches it, wipe silently instead of
        // proceeding — the same "Incorrect PIN" UI as a genuine failure,
        // so there's no visible tell that a wipe happened vs. a real error.
        //
        // Fetched fresh here rather than reading the `localUser` component
        // state (which is populated by an async effect keyed on
        // currentRelayId) — a fast submit right after account selection can
        // race that effect and see it still null/stale, silently skipping
        // the wipe at exactly the moment a coerced user is relying on it.
        const duressCheckUser = await getUserByRelayId(currentRelayId);
        if (recoveryPinEntry && duressCheckUser?.duressPinHash) {
          const isDuress = await verifyDuressPin(recoveryPinEntry, duressCheckUser.deviceFingerprint, duressCheckUser.duressPinHash);
          if (isDuress) {
            await deleteUser(duressCheckUser.id);
            await clearAllStorage().catch(() => {});
            clearEphemeralContacts();
            loadAvailableUsers().catch(() => {});
            setRecoveryCodeError('Recovery code is incorrect');
            setRecoveryCodeEntry('');
            setRecoveryPinEntry('');
            return;
          }
        }

        // Recovery mode: server verifies recovery code + TOTP, sets session cookie
        const response = await fetch('/api/auth/recovery-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            relayId: currentRelayId,
            recoveryCode: recoveryCodeEntry,
            totpCode: totpEntry,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          const errorMsg = data.error || 'Login failed. Try again.';
          setRecoveryCodeError(errorMsg);
          setRecoveryCodeEntry('');
          setTotpEntry('');
        } else {
          // Session cookie set by server. Private key is NOT returned — it lives
          // only in IndexedDB. User gets into the app but message history requires
          // an imported backup file.
          log.debug('[Login] Recovery authentication successful for relayId:', currentRelayId);
          router.push('/app');
        }
      } else {
        // Normal PIN login — local-first:
        // 1. Decrypt private key from IndexedDB with PIN
        // 2. Prove second factor (TOTP verified locally, or a hardware-key tap)
        // 3. Call server only to obtain a session cookie

        // Step 1: Read local user from IndexedDB.
        // NOTE: intentionally shows the exact same "Incorrect PIN" error as a
        // wrong-PIN guess below (not a distinct "no local key" message) — a
        // missing record is also what a duress-PIN wipe leaves behind, and
        // the whole point of that feature is that retrying after a wipe must
        // look identical to a normal wrong guess, not reveal that data is gone.
        const dbUser = await getUserByRelayId(currentRelayId);
        if (!dbUser) {
          setPinError('Incorrect PIN');
          setPinEntry('');
          return;
        }
        const localUser = dbUser;

        // Step 2: Decrypt private key locally using PIN + stored device fingerprint.
        // The duress-PIN check runs concurrently with the real decrypt attempt (not
        // after) so timing can't distinguish a duress trigger from a normal wrong PIN.
        let identity;
        try {
          const storedIdentity = {
            encryptedPrivateKey: hexToBytes(localUser.encryptedPrivateKey),
            publicKey: hexToBytes(localUser.publicKeyHex),
            relayId: localUser.relayId,
            version: 1 as const,
            encryptedPqPrivateKey: localUser.pqPrivateKeyHex ? hexToBytes(localUser.pqPrivateKeyHex) : undefined,
          };
          const [identityResult, isDuress] = await Promise.all([
            recoverIdentity(storedIdentity, pinEntry, localUser.deviceFingerprint).then(
              (value) => ({ ok: true as const, value }),
              (error) => ({ ok: false as const, error })
            ),
            localUser.duressPinHash
              ? verifyDuressPin(pinEntry, localUser.deviceFingerprint, localUser.duressPinHash)
              : Promise.resolve(false),
          ]);

          if (isDuress) {
            // Silent wipe — fall through to the exact same "Incorrect PIN" UI a
            // genuine wrong guess at this same attempt count would show (see
            // pinAttemptsRemainingMessage's doc comment), so there's no visible
            // tell. pinAttempts itself is deliberately NOT incremented here —
            // the account is about to be deleted and a fresh account-selection
            // resets the counter anyway (see selectUserForLogin).
            await deleteUser(localUser.id);
            await clearAllStorage().catch(() => {});
            clearEphemeralContacts();
            // Keep the account picker consistent with the store's own attemptLogin
            // path, which already filters the deleted user out of availableUsers.
            loadAvailableUsers().catch(() => {});
            const syntheticAttempt = pinAttempts + 1;
            const warning = pinAttemptsRemainingMessage(syntheticAttempt);
            setPinError(warning ? `Incorrect PIN. ${warning}` : 'Incorrect PIN');
            setPinEntry('');
            return;
          }

          if (!identityResult.ok) throw identityResult.error;
          identity = identityResult.value;
          useRelayAuthStoreV2.setState({ pinAttempts: 0 });
        } catch {
          // Second line of defense alongside the duress PIN: the store's
          // own attemptLogin() (used by the separate device-recovery flow)
          // already wipes after 5 consecutive wrong guesses, but this page
          // is the actual primary sign-in path and previously reimplemented
          // decrypt+duress inline without that safeguard — leaving offline
          // PIN brute-forcing here effectively unrated.
          const newAttempts = pinAttempts + 1;
          useRelayAuthStoreV2.setState({ pinAttempts: newAttempts });
          if (newAttempts >= MAX_PIN_ATTEMPTS) {
            await deleteUser(localUser.id);
            await clearAllStorage().catch(() => {});
            clearEphemeralContacts();
            loadAvailableUsers().catch(() => {});
          }
          const warning = pinAttemptsRemainingMessage(newAttempts);
          setPinError(warning ? `Incorrect PIN. ${warning}` : 'Incorrect PIN');
          setPinEntry('');
          return;
        }

        // Step 3: Prove the second factor, then call the server for a session cookie.
        let loginBody: { relayId: string; totpCode?: string; webauthnAssertion?: unknown };
        if (localUser.twoFactorMethod === 'webauthn') {
          setWebauthnError('');
          try {
            const assertion = await authenticateWithHardwareKey(currentRelayId);
            loginBody = { relayId: currentRelayId, webauthnAssertion: assertion };
          } catch (err) {
            setWebauthnError(err instanceof Error ? err.message : 'Hardware key authentication failed');
            return;
          }
        } else {
          // Verify TOTP locally first — the server re-verifies independently,
          // this just avoids a round-trip for an obviously-wrong code.
          const totpSecret = deriveTOTPSecret(identity.privateKey);
          const totp = createTOTPFromSecret(totpSecret);
          const validTotp = verifyTOTPCode(totp, totpEntry);
          if (!validTotp) {
            setTotpError('Invalid authenticator code');
            setTotpEntry('');
            return;
          }
          loginBody = { relayId: currentRelayId, totpCode: totpEntry };
        }

        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(loginBody),
        });

        const data = await response.json();

        if (!response.ok) {
          const errorMsg = data.error || 'Login failed. Try again.';
          if (localUser.twoFactorMethod === 'webauthn') {
            setWebauthnError(errorMsg);
          } else {
            const isTotpError =
              errorMsg.toLowerCase().includes('authenticator') ||
              errorMsg.toLowerCase().includes('totp') ||
              errorMsg.toLowerCase().includes('2fa') ||
              errorMsg.toLowerCase().includes('invalid credentials');
            if (isTotpError) {
              setTotpError(errorMsg);
            } else {
              setPinError(errorMsg);
            }
            setTotpEntry('');
          }
        } else {
          // Session cookie set. Activate the private key in the client store.
          log.debug('[Login] API authentication successful for relayId:', currentRelayId);
          completeApiLogin(
            bytesToHex(identity.privateKey),
            localUser.publicKeyHex,
            localUser.id,
            localUser.relayId,
            localUser.username || null,
            identity.pqPrivateKey ? bytesToHex(identity.pqPrivateKey) : undefined,
          );
          log.debug('[Login] Session saved successfully, redirecting to /app');
          router.push('/app');
        }
      }
    } catch (error) {
      setPinError('Login failed. Try again.');
      log.error('Login error:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBackToAccounts = () => {
    selectUserForLogin('');
    setPinEntry('');
    setRecoveryCodeEntry('');
    setTotpEntry('');
    setPinError('');
    setRecoveryCodeError('');
    setTotpError('');
    setIsRecoveryMode(false);
  };

  const handleResolveUserInput = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim()) {
      setInputError('Please enter a username or Relay ID');
      return;
    }

    setIsResolvingInput(true);
    setInputError('');

    try {
      const resolvedRelayId = await resolveUserInput(userInput);
      if (resolvedRelayId) {
        selectUserForLogin(resolvedRelayId);
        setShowDirectInput(false);
        setUserInput('');
      } else {
        setInputError('User not found. Check your username or ID and try again.');
      }
    } catch (error) {
      setInputError('Failed to search for user. Please try again.');
      log.error('Resolve user error:', error);
    } finally {
      setIsResolvingInput(false);
    }
  };

  if (isLoading) {
    return (
      <div className="mk-marketing min-h-screen bg-relay-bg flex items-center justify-center">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          className="w-8 h-8 border-2 border-relay-accent border-t-transparent rounded-full"
        />
      </div>
    );
  }

  // If no user selected, show user selection screen or direct input
  if (!currentRelayId) {
    // If no users available, show message OR direct input if requested
    if (availableUsers.length === 0) {
      if (showDirectInput) {
        // Show direct input form
        return (
          <div className="mk-marketing min-h-screen bg-relay-bg flex flex-col items-center justify-center p-4">
            <motion.div
              className="w-full max-w-sm space-y-6"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <div className="text-center space-y-2">
                <RelayLogo size="lg" className="text-relay-accent mx-auto" />
                <h1 className="text-2xl font-bold text-white">Enter Username or ID</h1>
                <p className="text-xs text-relay-text-muted">Arcel Relay</p>
                <p className="text-sm text-relay-text-secondary">Use @username or short code</p>
              </div>

              <form onSubmit={handleResolveUserInput} className="space-y-4">
                <div>
                  <input
                    type="text"
                    placeholder="@username or short code"
                    value={userInput}
                    onChange={(e) => {
                      setUserInput(e.target.value);
                      setInputError('');
                    }}
                    disabled={isResolvingInput}
                    className={`w-full px-4 py-3 bg-relay-surface-hover border rounded-lg text-white placeholder-relay-text-muted focus:outline-none transition-all disabled:opacity-50 ${
                      inputError
                        ? 'border-red-500/50 focus:border-red-500'
                        : 'border-relay-border-light focus:border-relay-accent'
                    }`}
                    autoFocus
                  />
                  {inputError && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-sm text-red-600 dark:text-red-400 mt-2"
                    >
                      {inputError}
                    </motion.div>
                  )}
                </div>

                <motion.button
                  type="submit"
                  disabled={isResolvingInput}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="w-full px-6 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-medium transition-all disabled:opacity-50"
                >
                  {isResolvingInput ? 'Searching...' : 'Continue'}
                </motion.button>

                <button
                  type="button"
                  onClick={() => {
                    setShowDirectInput(false);
                    setUserInput('');
                    setInputError('');
                  }}
                  className="w-full px-6 py-3 bg-relay-surface-hover hover:bg-relay-surface-hover text-white rounded-lg font-medium transition-all border border-relay-border-light"
                >
                  Back
                </button>
              </form>
            </motion.div>
          </div>
        );
      }

      // Show "No Accounts Found" screen
      return (
        <div className="mk-marketing min-h-screen bg-relay-bg flex flex-col items-center justify-center p-4">
          <motion.div
            className="w-full max-w-sm space-y-8 text-center"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
          >
            <div>
              <RelayLogo size="lg" className="text-relay-accent mx-auto mb-4" />
              <h1 className="text-2xl font-bold text-white">No Accounts Found</h1>
              <p className="text-xs text-relay-text-muted mb-2">Arcel Relay</p>
              <p className="text-relay-text-secondary mt-2">You don't have any saved accounts on this device.</p>
            </div>
            <div className="space-y-3">
              <button
                onClick={() => setShowDirectInput(true)}
                className="w-full px-6 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-medium transition-all"
              >
                Sign in with Username or ID
              </button>
              <button
                onClick={() => router.push('/auth/signup')}
                className="w-full px-6 py-3 bg-relay-surface-hover hover:bg-relay-surface-hover text-white rounded-lg font-medium transition-all border border-relay-border-light"
              >
                Create Account
              </button>
            </div>
          </motion.div>
        </div>
      );
    }
    return (
      <div className="mk-marketing min-h-screen bg-relay-bg flex flex-col items-center justify-center p-4">
        <motion.div
          className="w-full max-w-sm space-y-6"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          <div className="text-center space-y-2">
            <RelayLogo size="lg" className="text-relay-accent mx-auto" />
            <h1 className="text-2xl font-bold text-white">
              {showDirectInput ? 'Enter Username or ID' : 'Select Account'}
            </h1>
            <p className="text-xs text-relay-text-muted">Arcel Relay</p>
            <p className="text-sm text-relay-text-secondary">
              {showDirectInput
                ? 'Use @username or short code'
                : 'Choose an account to sign in'}
            </p>
          </div>

          {showDirectInput ? (
            // Direct input form
            <form onSubmit={handleResolveUserInput} className="space-y-4">
              <div>
                <input
                  type="text"
                  placeholder="@username or short code"
                  value={userInput}
                  onChange={(e) => {
                    setUserInput(e.target.value);
                    setInputError('');
                  }}
                  disabled={isResolvingInput}
                  className={`w-full px-4 py-3 bg-relay-surface-hover border rounded-lg text-white placeholder-relay-text-muted focus:outline-none transition-all disabled:opacity-50 ${
                    inputError
                      ? 'border-red-500/50 focus:border-red-500'
                      : 'border-relay-border-light focus:border-relay-accent'
                  }`}
                  autoFocus
                />
                {inputError && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-sm text-red-600 dark:text-red-400 mt-2"
                  >
                    {inputError}
                  </motion.div>
                )}
              </div>

              <motion.button
                type="submit"
                disabled={isResolvingInput}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="w-full px-6 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-medium transition-all disabled:opacity-50"
              >
                {isResolvingInput ? 'Searching...' : 'Continue'}
              </motion.button>

              <button
                type="button"
                onClick={() => {
                  setShowDirectInput(false);
                  setUserInput('');
                  setInputError('');
                }}
                className="w-full px-6 py-3 bg-relay-surface-hover hover:bg-relay-surface-hover text-white rounded-lg font-medium transition-all border border-relay-border-light"
              >
                Back to Accounts
              </button>
            </form>
          ) : (
            // Account selection
            <>
              <div className="space-y-3">
                {availableUsers.map((user) => (
                  <motion.button
                    key={user.relayId}
                    onClick={() => selectUserForLogin(user.relayId)}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full p-4 bg-relay-surface-hover hover:bg-relay-surface-hover border border-relay-border-light hover:border-relay-accent rounded-lg text-left transition-all"
                  >
                    <div className="text-sm font-medium text-white truncate">{user.relayId}</div>
                    <div className="text-xs text-relay-text-muted mt-1">
                      Created {new Date(user.createdAt).toLocaleDateString()}
                    </div>
                  </motion.button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setShowDirectInput(true)}
                className="w-full px-6 py-3 bg-relay-surface-hover hover:bg-relay-surface-hover text-white rounded-lg font-medium transition-all border border-relay-border-light"
              >
                Sign in with Username or ID
              </button>

              <button
                onClick={() => router.push('/auth/signup')}
                className="w-full px-6 py-3 bg-relay-surface-hover hover:bg-relay-surface-hover text-white rounded-lg font-medium transition-all border border-relay-border-light"
              >
                Create New Account
              </button>
            </>
          )}
        </motion.div>
      </div>
    );
  }

  // Login form: TOTP + PIN
  return (
    <div className="mk-marketing min-h-screen bg-relay-bg flex flex-col items-center justify-center p-4">
      <motion.div
        className="w-full max-w-sm space-y-8"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
      >
        <div className="text-center space-y-2">
          <RelayLogo size="lg" className="text-relay-accent mx-auto" />
          <h1 className="text-2xl font-bold text-white">Sign In</h1>
          <p className="text-sm text-relay-text-secondary">Enter your 2FA code and PIN</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          {/* Second factor: TOTP input, or hardware-key status for webauthn accounts.
              Recovery mode always uses TOTP (derived from the recovery code), regardless
              of the account's normal-login method. */}
          {(isRecoveryMode || loginMethod === 'totp') ? (
            <div>
              <label className="block text-sm font-medium text-relay-text-secondary mb-2">
                Authenticator Code
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={totpEntry}
                onChange={(e) => {
                  setTotpEntry(e.target.value.replace(/\D/g, '').slice(0, 6));
                  setTotpError('');
                }}
                disabled={isSubmitting}
                className={`w-full px-4 py-3 bg-relay-surface-hover border rounded-lg text-center font-mono text-2xl text-white placeholder-relay-text-muted focus:outline-none transition-all disabled:opacity-50 ${
                  totpError
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-relay-border-light focus:border-relay-accent'
                }`}
              />
              {totpError && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-red-600 dark:text-red-400 mt-1"
                >
                  {totpError}
                </motion.div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 px-4 py-3 bg-relay-surface-hover border border-relay-border-light rounded-lg">
              <KeyRound size={20} className="text-relay-accent shrink-0" />
              <div className="text-sm text-relay-text-secondary">
                Enter your PIN and submit — you'll be prompted to tap your hardware key.
              </div>
            </div>
          )}
          {!isRecoveryMode && loginMethod === 'webauthn' && webauthnError && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-sm text-red-600 dark:text-red-400"
            >
              {webauthnError}
            </motion.div>
          )}

          {/* PIN/Recovery Code Toggle */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setIsRecoveryMode(false);
                setRecoveryCodeEntry('');
                setRecoveryCodeError('');
                setPinError('');
              }}
              className={`flex-1 px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                !isRecoveryMode
                  ? 'bg-relay-accent text-relay-accent-foreground'
                  : 'bg-relay-surface-hover text-relay-text-secondary hover:text-relay-accent-foreground'
              }`}
            >
              PIN
            </button>
            <button
              type="button"
              onClick={() => {
                setIsRecoveryMode(true);
                setPinEntry('');
                setPinError('');
                setRecoveryCodeError('');
              }}
              className={`flex-1 px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                isRecoveryMode
                  ? 'bg-relay-accent text-relay-accent-foreground'
                  : 'bg-relay-surface-hover text-relay-text-secondary hover:text-relay-accent-foreground'
              }`}
            >
              Recovery Code
            </button>
          </div>

          {/* PIN or Recovery Code Input */}
          {isRecoveryMode ? (
            <div>
              <label className="block text-sm font-medium text-relay-text-secondary mb-2">
                Recovery Code
              </label>
              <input
                type="text"
                placeholder="XXXX-XXXX-XXXX-XXXX..."
                value={recoveryCodeEntry}
                onChange={(e) => {
                  setRecoveryCodeEntry(e.target.value.toUpperCase());
                  setRecoveryCodeError('');
                }}
                disabled={isSubmitting}
                className={`w-full px-4 py-3 bg-relay-surface-hover border rounded-lg text-center font-mono text-sm text-white placeholder-relay-text-muted focus:outline-none transition-all disabled:opacity-50 ${
                  recoveryCodeError
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-relay-border-light focus:border-relay-accent'
                }`}
              />
              {recoveryCodeError && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-red-600 dark:text-red-400 mt-1"
                >
                  {recoveryCodeError}
                </motion.div>
              )}
              <label className="block text-sm font-medium text-relay-text-secondary mb-2 mt-4">
                PIN (optional)
              </label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="Leave blank if you don't remember it"
                value={recoveryPinEntry}
                onChange={(e) => setRecoveryPinEntry(e.target.value.replace(/\D/g, ''))}
                disabled={isSubmitting}
                className="w-full px-4 py-3 bg-relay-surface-hover border border-relay-border-light rounded-lg text-center font-mono text-sm text-white placeholder-relay-text-muted focus:outline-none focus:border-relay-accent transition-all disabled:opacity-50"
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-relay-text-secondary mb-2">
                PIN
              </label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="••••••"
                value={pinEntry}
                onChange={(e) => {
                  setPinEntry(e.target.value.replace(/\D/g, '').slice(0, 6));
                  setPinError('');
                }}
                disabled={isSubmitting}
                className={`w-full px-4 py-3 bg-relay-surface-hover border rounded-lg text-center font-mono text-2xl text-white placeholder-relay-text-muted focus:outline-none transition-all disabled:opacity-50 ${
                  pinError
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-relay-border-light focus:border-relay-accent'
                }`}
              />
              {pinError && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-red-600 dark:text-red-400 mt-1"
                >
                  {pinError}
                </motion.div>
              )}
            </div>
          )}

          {/* Submit Button */}
        {(() => {
          const totpSatisfied = (isRecoveryMode || loginMethod === 'totp') ? totpEntry.length === 6 : true;
          const secretSatisfied = isRecoveryMode ? recoveryCodeEntry.length > 0 : pinEntry.length === 6;
          const canSubmit = totpSatisfied && secretSatisfied && !isSubmitting;
          return (
            <button
              type="submit"
              disabled={!canSubmit}
              className={`w-full px-6 py-3 rounded-lg font-medium transition-all ${
                canSubmit
                  ? 'bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground cursor-pointer'
                  : 'bg-relay-surface-hover text-relay-text-muted cursor-not-allowed'
              }`}
            >
              {isSubmitting
                ? (!isRecoveryMode && loginMethod === 'webauthn' ? 'Waiting for key...' : 'Signing in...')
                : 'Sign In'}
            </button>
          );
        })()}

        {/* Back Button */}
        <button
          type="button"
          onClick={handleBackToAccounts}
          disabled={isSubmitting}
          className="w-full px-6 py-3 bg-relay-surface-hover hover:bg-relay-surface-hover text-relay-text-secondary hover:text-white rounded-lg font-medium transition-all border border-relay-border-light disabled:opacity-50"
        >
          Back to Accounts
        </button>
      </form>

        {/* Helper text */}
        <div className="text-center text-xs text-relay-text-muted">
          <p>Enter your 6-digit 2FA code from your authenticator app</p>
          <p>and your {isRecoveryMode ? 'recovery code' : '6-digit PIN'} to continue</p>
        </div>
      </motion.div>
    </div>
  );
}
