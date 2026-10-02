'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRelayAuthStoreV2, pinAttemptsRemainingMessage } from '@/lib/crypto/relay-auth-store-v2';
import { RelayLogo } from '@/components/RelayLogo';
import { motion } from 'framer-motion';
import { log } from '@/lib/platform/logger';

export default function RecoveryCompletePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { flow, selectUserForLogin, attemptLogin } = useRelayAuthStoreV2();

  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [relayId, setRelayId] = useState<string | null>(null);

  useEffect(() => {
    if (flow === 'authenticated') router.replace('/app');
  }, [flow, router]);

  useEffect(() => {
    const id = searchParams.get('relayId');
    if (id) {
      setRelayId(id);
      selectUserForLogin(id);
    } else {
      router.replace('/auth/login');
    }
  }, [searchParams, selectUserForLogin, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (pinEntry.length !== 6) {
      setPinError('PIN must be 6 digits');
      return;
    }

    setIsSubmitting(true);
    try {
      const success = await attemptLogin(pinEntry);
      if (success) {
        setPinEntry('');
        await new Promise(resolve => setTimeout(resolve, 100));
        log.debug('[Recovery Complete] PIN verified, redirecting to /app');
        router.replace('/app');
      } else {
        // Read fresh from the store rather than a destructured hook value —
        // attemptLogin() already incremented pinAttempts synchronously before
        // resolving, but this closure's own render may not have caught up yet.
        const warning = pinAttemptsRemainingMessage(useRelayAuthStoreV2.getState().pinAttempts);
        setPinError(warning ? `Invalid PIN. ${warning}` : 'Invalid PIN. Try again.');
        setPinEntry('');
      }
    } catch (error) {
      setPinError('PIN verification failed. Try again.');
      setPinEntry('');
      log.error('Recovery completion error:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-relay-bg flex flex-col items-center justify-center p-4">
      <motion.div
        className="w-full max-w-sm space-y-8"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
      >
        <div className="text-center space-y-4">
          <RelayLogo size="lg" className="text-relay-accent mx-auto" />
          <h1 className="text-2xl font-bold text-white">Complete Account Recovery</h1>
          <p className="text-sm text-relay-text-secondary">
            Your recovery code was verified. Enter your PIN to decrypt and access your account.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="recovery-pin" className="block text-sm font-medium text-relay-text-secondary mb-2">
              6-Digit PIN
            </label>
            <input
              id="recovery-pin"
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
              aria-invalid={!!pinError}
              aria-describedby={pinError ? 'recovery-pin-error' : undefined}
              className={`w-full px-4 py-3 bg-relay-surface-hover border rounded-lg text-center font-mono text-2xl text-white placeholder-relay-text-muted focus:outline-none transition-all disabled:opacity-50 ${
                pinError
                  ? 'border-red-500/50 focus:border-red-500'
                  : 'border-relay-border-light focus:border-relay-accent'
              }`}
              autoFocus
            />
            {pinError && (
              <motion.div
                id="recovery-pin-error"
                role="alert"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-sm text-red-600 dark:text-red-400 mt-1"
              >
                {pinError}
              </motion.div>
            )}
          </div>

          <button
            type="submit"
            disabled={pinEntry.length !== 6 || isSubmitting}
            className={`w-full px-6 py-3 rounded-lg font-medium transition-all ${
              pinEntry.length === 6 && !isSubmitting
                ? 'bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground cursor-pointer'
                : 'bg-relay-surface-hover text-relay-text-muted cursor-not-allowed'
            }`}
          >
            {isSubmitting ? 'Verifying PIN...' : 'Unlock Account'}
          </button>

          <button
            type="button"
            onClick={() => {
              setPinEntry('');
              router.replace('/auth/login');
            }}
            disabled={isSubmitting}
            className="w-full px-6 py-3 bg-relay-surface-hover hover:bg-relay-surface-hover text-relay-text-secondary hover:text-white rounded-lg font-medium transition-all border border-relay-border-light disabled:opacity-50"
          >
            Back to Login
          </button>
        </form>

        <div className="text-center text-xs text-relay-text-muted">
          <p>Enter your 6-digit PIN to complete account recovery</p>
          <p className="mt-1">Your PIN was set during account creation</p>
        </div>
      </motion.div>
    </div>
  );
}
