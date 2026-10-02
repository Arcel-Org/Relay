'use client';

import { Suspense, useEffect, useState, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { SetupLayout } from '@/components/SetupLayout';
import { PINPadSetup } from '@/components/PINPadSetup';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, RefreshCw } from 'lucide-react';
import { QRCodeSVG as QRCode } from 'qrcode.react';
import { toBase32, createTOTPFromSecret, getCurrentTOTPCode, getTimeUntilNextTOTP } from '@/lib/crypto/relay-auth';
import { copyToClipboard } from '@/lib/utils';
import { log } from '@/lib/platform/logger';
import { KeyRound, Smartphone } from 'lucide-react';

type SignupStage = 'method-choice' | 'totp-setup' | 'webauthn-register' | 'pin-first' | 'pin-confirm';

function SignupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNewAccount = searchParams.get('newAccount') === 'true';
  const {
    flow,
    signupIdentity,
    signupStep,
    signupTOTPSecret,
    signupTwoFactorMethod,
    chooseTwoFactorMethod,
    completeSignupStep2,
    completeSignupWebAuthnRegistration,
    completeSignupStep3,
    startSignup,
    logout,
  } = useRelayAuthStoreV2();

  const [stage, setStage] = useState<SignupStage>('method-choice');
  const [webauthnError, setWebauthnError] = useState('');
  const [webauthnRegistering, setWebauthnRegistering] = useState(false);
  const [enteredCode, setEnteredCode] = useState('');
  const [codeError, setCodError] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [timeLeft, setTimeLeft] = useState(30);
  const [refreshing, setRefreshing] = useState(false);
  const [currentTOTPCode, setCurrentTOTPCode] = useState(''); // Display current 6-digit code
  const [totpRefreshing, setTotpRefreshing] = useState(false);

  // PIN stage state
  const [pinStage, setPinStage] = useState<'first' | 'confirm'>('first');
  const [firstPin, setFirstPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const timerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const totpTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  // Initialize signup
  useEffect(() => {
    if (flow === 'authenticated' && !isNewAccount) {
      router.push('/app');
    } else if (flow === 'authenticated' && isNewAccount) {
      // Logout current session first so the new signup doesn't corrupt auth state.
      // The existing account remains in local DB and is accessible via the account switcher.
      logout();
      // After logout, flow becomes 'login', effect re-runs and falls into !signupIdentity branch
    } else if (!signupIdentity && signupStep !== 3) {
      // signupStep === 3 means completeSignupStep3 just succeeded and
      // cleared signupIdentity as part of its success payload (the
      // private key is no longer needed on this page once it's been
      // encrypted+stored) — router.push('/auth/signup/step3') is about to
      // navigate away to show the recovery code. Without this check, this
      // effect re-runs on that same signupIdentity->null transition and
      // races the navigation: it sees "no identity" and calls startSignup()
      // again, generating a brand-new identity and resetting signupStep
      // back to 1 before the recovery-code page's own "signupStep !== 3"
      // guard gets to check it — bouncing the user back to step 1 with no
      // ability to ever see the recovery code for the account that was
      // already fully registered.
      const initSignup = async () => {
        try {
          await startSignup();
          setStage('method-choice');
        } catch (error) {
          log.error('Failed to start signup:', error);
        }
      };
      initSignup();
    } else if (signupIdentity) {
      setStage('method-choice');
    }
  }, [flow, signupIdentity, signupStep, router, startSignup, isNewAccount, logout]);

  // Update current TOTP code every second
  useEffect(() => {
    if (stage !== 'totp-setup' || !signupTOTPSecret) return;

    const updateTOTPCode = () => {
      try {
        const totp = createTOTPFromSecret(signupTOTPSecret);
        const code = getCurrentTOTPCode(totp);
        setCurrentTOTPCode(code);

        // Check if we're crossing into a new time window
        const now = Math.floor(Date.now() / 1000);
        if (now % 30 === 0) {
          setTotpRefreshing(true);
          setTimeout(() => setTotpRefreshing(false), 300);
        }
      } catch (err) {
        log.error('Failed to update TOTP code:', err);
      }
    };

    updateTOTPCode();
    totpTimerRef.current = setInterval(updateTOTPCode, 1000);

    return () => {
      if (totpTimerRef.current) clearInterval(totpTimerRef.current);
    };
  }, [stage, signupTOTPSecret]);

  // Time-based TOTP timer - calculates remaining seconds in current 30-second window
  useEffect(() => {
    if (stage !== 'totp-setup') return;

    const updateTimer = () => {
      const now = Math.floor(Date.now() / 1000);
      const secondsInWindow = now % 30;
      const remaining = 30 - secondsInWindow;
      setTimeLeft(remaining);

      // Check if we're crossing into a new window
      if (secondsInWindow === 0) {
        setRefreshing(true);
        timeoutRef.current = setTimeout(() => setRefreshing(false), 300);
      }
    };

    updateTimer();
    timerRef.current = setInterval(updateTimer, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [stage]);

  const getQRData = (): string => {
    if (!signupTOTPSecret) return '';
    try {
      const base32 = toBase32(signupTOTPSecret);
      return `otpauth://totp/Relay?secret=${base32}&issuer=Relay&period=30&digits=6&algorithm=SHA1`;
    } catch (error) {
      log.error('Failed to generate QR:', error);
      return '';
    }
  };

  const getManualSecret = (): string => {
    if (!signupTOTPSecret) return '';
    try {
      return toBase32(signupTOTPSecret);
    } catch (error) {
      log.error('Failed to get manual secret:', error);
      return '';
    }
  };

  const handleCopy = async () => {
    const text = getManualSecret();
    try {
      await copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      log.error('Failed to copy:', error);
    }
  };

  const handleVerifyCode = async () => {
    if (enteredCode.length !== 6) {
      setCodError('Code must be 6 digits');
      return;
    }

    setIsVerifying(true);
    const success = await completeSignupStep2(enteredCode);

    if (success) {
      setStage('pin-first');
      setEnteredCode('');
      setCodError('');
    } else {
      setCodError('Code does not match. Try again or wait for a new code.');
      setEnteredCode('');
    }

    setIsVerifying(false);
  };

  const handleChooseMethod = (method: 'totp' | 'webauthn') => {
    chooseTwoFactorMethod(method);
    setStage(method === 'totp' ? 'totp-setup' : 'webauthn-register');
  };

  const handleRegisterHardwareKey = async () => {
    setWebauthnRegistering(true);
    setWebauthnError('');
    const result = await completeSignupWebAuthnRegistration();
    if (result.success) {
      setStage('pin-first');
    } else {
      setWebauthnError(result.error || 'Hardware key registration failed. Try again.');
    }
    setWebauthnRegistering(false);
  };

  const handleFirstPinSubmit = (pin: string) => {
    if (pin.length === 6) {
      setFirstPin(pin);
      setPinStage('confirm');
    }
  };

  const handleConfirmPinSubmit = async (pin: string) => {
    if (pin.length !== 6) return;

    if (pin !== firstPin) {
      setPinError('PINs do not match');
      setTimeout(() => {
        setPinError('');
        setConfirmPin('');
      }, 800);
      return;
    }

    setIsLoading(true);
    const success = await completeSignupStep3(firstPin, pin);

    if (success) {
      sessionStorage.setItem('relay_new_user', 'true');
      router.push('/auth/signup/step3');
    } else {
      setPinError('Failed to complete setup');
      setTimeout(() => {
        setPinError('');
        setPinStage('first');
        setFirstPin('');
        setConfirmPin('');
      }, 1500);
    }

    setIsLoading(false);
  };

  if (!signupIdentity || !signupTOTPSecret) {
    return null;
  }

  // STAGE: Choose second-factor method
  if (stage === 'method-choice') {
    return (
      <SetupLayout
        step={1}
        totalSteps={3}
        title="Choose Your Second Factor"
        subtitle="How do you want to verify it's you at login?"
      >
        <div className="space-y-4">
          <button
            onClick={() => handleChooseMethod('totp')}
            className="w-full flex items-start gap-4 p-5 bg-relay-surface-hover border border-relay-border-light rounded-lg text-left hover:border-relay-accent transition-all"
          >
            <Smartphone size={28} className="text-relay-accent shrink-0 mt-1" />
            <div>
              <div className="font-medium text-white">Authenticator App</div>
              <div className="text-sm text-relay-text-secondary mt-1">
                Use Google Authenticator, Authy, or any standard TOTP app. Works on any device.
              </div>
            </div>
          </button>

          <button
            onClick={() => handleChooseMethod('webauthn')}
            className="w-full flex items-start gap-4 p-5 bg-relay-surface-hover border border-relay-border-light rounded-lg text-left hover:border-relay-accent transition-all"
          >
            <KeyRound size={28} className="text-relay-accent shrink-0 mt-1" />
            <div>
              <div className="font-medium text-white">Hardware Security Key</div>
              <div className="text-sm text-relay-text-secondary mt-1">
                Use a YubiKey, platform passkey, or other FIDO2/WebAuthn device. Strongest option — requires physical possession of the key to log in.
              </div>
            </div>
          </button>

          <div className="p-4 bg-relay-surface/50 border border-relay-border rounded-lg">
            <p className="text-xs text-relay-text-secondary">
              Either way, PIN + this second factor protects your account. You can only choose one method now — switching later requires contacting support.
            </p>
          </div>
        </div>
      </SetupLayout>
    );
  }

  // STAGE: Register hardware key (WebAuthn)
  if (stage === 'webauthn-register') {
    return (
      <SetupLayout
        step={2}
        totalSteps={3}
        title="Register Your Hardware Key"
        subtitle="Insert or tap your security key when prompted"
      >
        <div className="space-y-8">
          <div className="flex justify-center py-8">
            <KeyRound size={64} className={webauthnRegistering ? 'text-relay-accent animate-pulse' : 'text-relay-text-secondary'} />
          </div>

          {webauthnError && (
            <div className="px-4 py-3 bg-red-950/20 border border-red-500/30 rounded-lg text-center text-sm text-red-600 dark:text-red-400">
              {webauthnError}
            </div>
          )}

          <motion.button
            onClick={handleRegisterHardwareKey}
            disabled={webauthnRegistering}
            whileHover={!webauthnRegistering ? { scale: 1.02 } : {}}
            whileTap={!webauthnRegistering ? { scale: 0.98 } : {}}
            className={`w-full px-6 py-3 rounded-lg font-medium transition-all ${
              !webauthnRegistering
                ? 'bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground cursor-pointer'
                : 'bg-relay-surface-hover text-relay-text-muted cursor-not-allowed'
            }`}
          >
            {webauthnRegistering ? (
              <>
                <RefreshCw size={16} className="inline mr-2 animate-spin" />
                Waiting for key...
              </>
            ) : (
              'Register Key'
            )}
          </motion.button>

          <button
            onClick={() => setStage('method-choice')}
            className="w-full text-sm text-relay-accent hover:text-relay-accent/80 transition-colors"
          >
            Choose a different method
          </button>
        </div>
      </SetupLayout>
    );
  }

  // STAGE: Setup & Verify Authenticator (QR + Code Input)
  if (stage === 'totp-setup') {
    return (
      <SetupLayout
        step={2}
        totalSteps={3}
        title="Set up Authenticator"
        subtitle="Scan QR code and verify with your authenticator app"
      >
        <div className="space-y-8">
          {/* QR Code */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex justify-center"
          >
            <div className="p-4 bg-white rounded-lg">
              <QRCode value={getQRData()} size={220} level="H" includeMargin={true} />
            </div>
          </motion.div>

          {/* Live TOTP Code Display */}
          {currentTOTPCode && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="text-sm text-relay-text-secondary font-medium">Your current code:</div>
              <motion.div
                animate={totpRefreshing ? { scale: [1, 1.05, 1] } : {}}
                className="relative"
              >
                <div className="px-6 py-4 bg-relay-surface/80 border border-relay-accent/40 rounded-lg font-mono text-4xl font-bold tracking-wider text-white">
                  <span>{currentTOTPCode.slice(0, 3)}</span>
                  <span className="mx-2 text-relay-accent">·</span>
                  <span>{currentTOTPCode.slice(3, 6)}</span>
                </div>
              </motion.div>
              <div className="text-xs text-relay-text-muted">Refreshes in {timeLeft}s</div>
            </motion.div>
          )}

          {/* Manual Entry */}
          {showManual && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="p-4 bg-relay-surface/50 border border-relay-border rounded-lg space-y-3"
            >
              <div className="text-sm font-medium text-white">Manual Entry Secret:</div>
              <div className="font-mono text-xs bg-relay-surface-hover px-3 py-2 rounded text-center break-all text-relay-accent font-bold">
                {getManualSecret()}
              </div>
              <button
                onClick={handleCopy}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-relay-surface-hover hover:bg-relay-surface-hover rounded text-sm text-white transition-all"
              >
                {copied ? (
                  <>
                    <Check size={16} />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy size={16} />
                    Copy Secret
                  </>
                )}
              </button>
            </motion.div>
          )}

          <button
            onClick={() => setShowManual(!showManual)}
            className="w-full text-sm text-relay-accent hover:text-relay-accent/80 transition-colors"
          >
            {showManual ? 'Hide Manual Entry' : "Can't scan? Enter manually"}
          </button>

          {/* Countdown Timer */}
          <motion.div
            animate={refreshing ? { scale: [1, 1.1, 1] } : {}}
            className="flex justify-center"
          >
            <div className="relative w-20 h-20 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="45" fill="none" stroke="#3b82f6" strokeWidth="2" opacity="0.2" />
                <motion.circle
                  cx="50"
                  cy="50"
                  r="45"
                  fill="none"
                  stroke="#a855f7"
                  strokeWidth="2"
                  strokeDasharray={`${2 * Math.PI * 45}`}
                  animate={{
                    strokeDashoffset: (1 - timeLeft / 30) * 2 * Math.PI * 45,
                  }}
                  transition={{ duration: 1, ease: 'linear' }}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute text-center">
                <div className="text-2xl font-bold text-relay-accent">{timeLeft}</div>
                <div className="text-xs text-relay-text-secondary">seconds</div>
              </div>
            </div>
          </motion.div>

          {/* Code Input */}
          <div>
            <label className="block text-sm font-medium text-white mb-2">Enter 6-digit code from your app:</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={enteredCode}
              onChange={(e) => {
                setEnteredCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                setCodError('');
              }}
              disabled={isVerifying}
              className={`w-full px-4 py-3 bg-relay-surface-hover border rounded-lg text-center font-mono text-3xl font-bold text-white placeholder-relay-text-muted focus:outline-none transition-all disabled:opacity-50 ${
                codeError
                  ? 'border-red-500/50 focus:border-red-500'
                  : 'border-relay-border-light focus:border-relay-accent'
              }`}
            />
          </div>

          {/* Error */}
          <AnimatePresence>
            {codeError && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-sm text-red-600 dark:text-red-400 text-center"
              >
                {codeError}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Info */}
          <div className="p-4 bg-blue-950/20 border border-blue-500/30 rounded-lg">
            <div className="text-sm font-medium text-blue-700 dark:text-blue-300 mb-2">How it works:</div>
            <p className="text-xs text-blue-700/80 dark:text-blue-300/80">
              Your authenticator app generates a new 6-digit code every 30 seconds. The timer shows the remaining seconds. After verifying, you'll create your 6-digit PIN.
            </p>
          </div>

          {/* Submit Button */}
          <motion.button
            onClick={handleVerifyCode}
            disabled={enteredCode.length !== 6 || isVerifying}
            whileHover={enteredCode.length === 6 && !isVerifying ? { scale: 1.02 } : {}}
            whileTap={enteredCode.length === 6 && !isVerifying ? { scale: 0.98 } : {}}
            className={`w-full px-6 py-3 rounded-lg font-medium transition-all ${
              enteredCode.length === 6 && !isVerifying
                ? 'bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground cursor-pointer'
                : 'bg-relay-surface-hover text-relay-text-muted cursor-not-allowed'
            }`}
          >
            {isVerifying ? (
              <>
                <RefreshCw size={16} className="inline mr-2 animate-spin" />
                Verifying...
              </>
            ) : (
              'Verify & Continue'
            )}
          </motion.button>
        </div>
      </SetupLayout>
    );
  }

  // STAGE: PIN Setup
  if (stage === 'pin-first' || stage === 'pin-confirm') {
    return (
      <SetupLayout
        step={3}
        totalSteps={3}
        title={pinStage === 'first' ? 'Create Your PIN' : 'Confirm Your PIN'}
        subtitle={pinStage === 'first' ? 'Choose a 6-digit PIN for login' : 'Enter it again to confirm'}
      >
        <div className="space-y-8">
          {/* PIN Pad */}
          <motion.div
            key={pinStage}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <PINPadSetup
              onSubmit={pinStage === 'first' ? handleFirstPinSubmit : handleConfirmPinSubmit}
              onPinChange={pinStage === 'first' ? setFirstPin : setConfirmPin}
              shake={!!pinError}
              isLoading={isLoading}
            />
          </motion.div>

          {/* Error */}
          <AnimatePresence>
            {pinError && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="px-4 py-3 bg-red-950/20 border border-red-500/30 rounded-lg text-center text-sm text-red-600 dark:text-red-400"
              >
                {pinError}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Info */}
          <div className="px-4 py-4 bg-relay-surface/50 border border-relay-border rounded-lg space-y-2">
            <div className="text-sm font-medium text-white">Your PIN combines with 2FA for security:</div>
            <ul className="text-xs text-relay-text-secondary space-y-1 list-disc list-inside">
              <li>Encrypts your private key locally</li>
              <li>Cannot be reset or recovered</li>
              <li>Combined with authenticator app codes</li>
              <li>Should be memorable but hard to guess</li>
            </ul>
          </div>
        </div>
      </SetupLayout>
    );
  }

  return null;
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupContent />
    </Suspense>
  );
}
