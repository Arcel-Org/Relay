'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { SetupLayout } from '@/components/SetupLayout';
import { motion } from 'framer-motion';
import { Copy, Check, AlertCircle } from 'lucide-react';
import { copyToClipboard } from '@/lib/utils';
import { log } from '@/lib/platform/logger';

export default function SignupRecoveryCode() {
  const router = useRouter();
  const { flow, signupStep, signupRecoveryCode, completeRecoverCodeAcknowledgement } = useRelayAuthStoreV2();
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (flow === 'authenticated') {
      router.push('/app');
    } else if (flow === 'landing') {
      router.push('/auth/signup');
    } else if (signupStep !== 3 || !signupRecoveryCode) {
      router.push('/auth/signup');
    }
  }, [flow, signupStep, signupRecoveryCode, router]);

  const handleCopyCode = async () => {
    if (!signupRecoveryCode) return;
    try {
      await copyToClipboard(signupRecoveryCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      log.error('Failed to copy recovery code:', err);
    }
  };

  const handleComplete = () => {
    if (acknowledged) {
      completeRecoverCodeAcknowledgement();
      router.push('/app');
    }
  };

  if (!signupRecoveryCode) {
    return null;
  }

  return (
    <SetupLayout
      step={3}
      totalSteps={3}
      title="Save Your Recovery Code"
      subtitle="Your way back in if you lose access"
    >
      <motion.div
        className="space-y-8"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        {/* Warning */}
        <motion.div
          className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 flex gap-3"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-yellow-200">
              This is your only way to recover your account
            </p>
            <p className="text-xs text-yellow-100/80">
              We don't store this code - only you have it. Save it securely now.
            </p>
          </div>
        </motion.div>

        {/* Recovery Code Display */}
        <motion.div
          className="bg-relay-surface-hover border border-relay-border-light rounded-lg p-6 space-y-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <p className="text-sm text-relay-text-secondary">Your Recovery Code</p>
          <div data-testid="recovery-code" className="bg-relay-surface/50 border border-relay-border-light rounded p-4 font-mono text-sm text-relay-text-primary break-all select-all">
            {signupRecoveryCode}
          </div>

          <motion.button
            onClick={handleCopyCode}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="w-full px-4 py-3 bg-relay-surface-hover hover:bg-relay-surface-hover text-white rounded-lg font-medium transition-all flex items-center justify-center gap-2"
          >
            {copied ? (
              <>
                <Check className="w-4 h-4" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                Copy Code
              </>
            )}
          </motion.button>
        </motion.div>

        {/* Suggestions */}
        <div className="bg-relay-surface rounded-lg p-4 space-y-2">
          <p className="text-xs font-medium text-relay-text-secondary mb-3">Where to save it:</p>
          <ul className="space-y-2 text-xs text-relay-text-secondary">
            <li>✓ Password manager (encrypted)</li>
            <li>✓ Physical notebook in a safe place</li>
            <li>✓ Secure note app (encrypted)</li>
            <li>✗ Don't email it or message it</li>
          </ul>
        </div>

        {/* Acknowledgement */}
        <motion.div
          className="space-y-3"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="w-5 h-5 rounded border-2 border-relay-border-light checked:bg-relay-accent checked:border-relay-accent cursor-pointer"
            />
            <span className="text-sm text-relay-text-secondary group-hover:text-white transition-colors">
              I have saved my recovery code in a secure location
            </span>
          </label>

          <motion.button
            onClick={handleComplete}
            disabled={!acknowledged}
            whileHover={acknowledged ? { scale: 1.02 } : {}}
            whileTap={acknowledged ? { scale: 0.98 } : {}}
            className="w-full px-6 py-3 bg-relay-accent hover:bg-relay-accent/90 disabled:bg-relay-surface-hover disabled:opacity-50 text-relay-accent-foreground rounded-lg font-medium transition-all disabled:cursor-not-allowed"
          >
            Continue to App
          </motion.button>
        </motion.div>
      </motion.div>
    </SetupLayout>
  );
}
