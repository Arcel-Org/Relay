'use client';

import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RelayLogo } from './RelayLogo';
import { ChevronRight, Copy, Share2, Check } from 'lucide-react';
import { QRCodeSVG as QRCode } from 'qrcode.react';
import { copyToClipboard } from '@/lib/utils';
import { log } from '@/lib/platform/logger';
import { generateShortCode } from '@/lib/auth/account-manager';

export interface OnboardingProps {
  relayId: string;
  publicKeyHex: string;
  onComplete: () => void;
}

export function OnboardingFlow({ relayId, publicKeyHex, onComplete }: OnboardingProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const [shortCode, setShortCode] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [shortCodeError, setShortCodeError] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);

  const handleCopyId = useCallback(async () => {
    try {
      await copyToClipboard(relayId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      log.error('Failed to copy:', err);
    }
  }, [relayId]);

  const handleGenerateShortCode = useCallback(async () => {
    setGeneratingCode(true);
    setShortCodeError('');
    const result = await generateShortCode(relayId);
    setGeneratingCode(false);
    if (result.success && result.shortCode) {
      setShortCode(result.shortCode);
    } else {
      setShortCodeError(result.error || 'Failed to generate a short code');
    }
  }, [relayId]);

  const handleCopyShortCode = useCallback(async () => {
    if (!shortCode) return;
    try {
      await copyToClipboard(shortCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch (err) {
      log.error('Failed to copy:', err);
    }
  }, [shortCode]);

  const handleShare = useCallback(() => {
    if (navigator.share) {
      navigator.share({
        title: 'My Relay ID',
        // Prefer the short code once generated — much more practical to
        // read out loud or paste somewhere than the full Relay ID.
        text: shortCode ? `Add me on Relay: ${shortCode}` : `Add me on Relay: ${relayId}`,
      }).catch((err) => {
        if (err?.name !== 'AbortError') {
          log.error('Failed to share:', err);
        }
      });
    }
  }, [relayId, shortCode]);

  const steps = [
    // Step 1: Welcome
    <motion.div
      key="step-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="space-y-8 flex flex-col items-center justify-center"
    >
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
        className="mb-4"
      >
        <RelayLogo size="xl" className="text-relay-accent" />
      </motion.div>

      <div className="space-y-4 text-center max-w-md">
        <h1 className="text-4xl font-bold text-white">Welcome to Relay</h1>
        <p className="text-relay-text-secondary">End-to-end encrypted messaging, only you hold the keys</p>
        <p className="text-xs text-relay-text-muted mt-1">by Arcel</p>
      </div>

      <div className="space-y-4 w-full max-w-md">
        {[
          { icon: '', title: 'Your messages stay private', desc: 'Live on your device, never our servers' },
          { icon: '', title: 'You control the keys', desc: 'End-to-end encrypted with keys only you hold' },
          { icon: '⏲️', title: 'Messages expire', desc: 'Delivered messages disappear in 20 minutes' },
        ].map((item, idx) => (
          <motion.div
            key={idx}
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: idx * 0.1 }}
            className="flex gap-3 p-4 rounded-lg bg-relay-surface/50 border border-relay-border"
          >
            <div className="text-2xl">{item.icon}</div>
            <div className="text-left">
              <p className="font-semibold text-white">{item.title}</p>
              <p className="text-sm text-relay-text-secondary">{item.desc}</p>
            </div>
          </motion.div>
        ))}
      </div>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setCurrentStep(1)}
        className="mt-8 px-8 py-3 bg-relay-surface text-white font-semibold rounded-lg flex items-center gap-2 transition-all"
      >
        Get started
        <ChevronRight size={20} />
      </motion.button>
    </motion.div>,

    // Step 2: Relay ID
    <motion.div
      key="step-1"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="space-y-6 flex flex-col items-center justify-center"
    >
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-white">Your Relay ID</h2>
        <p className="text-relay-text-secondary">Share this to receive messages</p>
      </div>

      <div className="p-6 rounded-lg bg-relay-surface/80 border border-relay-border-light w-full max-w-md space-y-4">
        {/* ID Display */}
        <div className="font-mono text-sm text-relay-text-secondary bg-black/50 p-4 rounded-lg break-all select-all">
          {relayId}
        </div>

        {/* QR Code */}
        <div className="flex justify-center p-4 bg-white rounded-lg">
          <QRCode value={relayId} size={200} level="H" />
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleCopyId}
            className="flex-1 px-4 py-2 bg-relay-surface-hover hover:bg-relay-surface-hover rounded-lg flex items-center justify-center gap-2 transition-colors"
          >
            {copied ? (
              <>
                <Check size={18} className="text-emerald-600 dark:text-emerald-400" />
                <span className="text-sm">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={18} />
                <span className="text-sm">Copy</span>
              </>
            )}
          </motion.button>

          {typeof navigator !== 'undefined' && 'share' in navigator && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleShare}
              className="flex-1 px-4 py-2 bg-relay-surface-hover hover:bg-relay-surface-hover rounded-lg flex items-center justify-center gap-2 transition-colors"
            >
              <Share2 size={18} />
              <span className="text-sm">Share</span>
            </motion.button>
          )}
        </div>
      </div>

      {/* Opt-in short code — the full Relay ID above is long and secure by
          obscurity on purpose; this is the short, human-shareable
          alternative for anyone who wants to be easy to add. Entirely
          optional, and can be generated/removed later in settings either
          way. */}
      <div className="p-6 rounded-lg bg-relay-surface/80 border border-relay-border-light w-full max-w-md space-y-3">
        <div>
          <p className="text-sm font-semibold text-white">Want a short code too?</p>
          <p className="text-xs text-relay-text-muted mt-0.5">
            A short, easy-to-share code (like <span className="font-mono">xoep-4910</span>) so people can add you without typing your full Relay ID. Optional — you can add or remove this anytime in settings.
          </p>
        </div>

        {shortCode ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 font-mono text-sm text-relay-text-secondary bg-black/50 px-4 py-2.5 rounded-lg select-all">
              {shortCode}
            </div>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleCopyShortCode}
              className="px-3 py-2.5 bg-relay-surface-hover hover:bg-relay-surface-hover rounded-lg flex items-center justify-center transition-colors"
              aria-label="Copy short code"
            >
              {codeCopied ? <Check size={18} className="text-emerald-600 dark:text-emerald-400" /> : <Copy size={18} />}
            </motion.button>
          </div>
        ) : (
          <>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleGenerateShortCode}
              disabled={generatingCode}
              className="w-full px-4 py-2.5 bg-relay-surface-hover hover:bg-relay-surface-hover rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {generatingCode ? 'Generating…' : 'Generate a short code'}
            </motion.button>
            {shortCodeError && <p className="text-xs text-red-400">{shortCodeError}</p>}
          </>
        )}
      </div>

      <div className="space-y-2 w-full max-w-md">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => setCurrentStep(2)}
          className="w-full px-6 py-3 bg-relay-surface text-white font-semibold rounded-lg transition-all"
        >
          Next
        </motion.button>

        <p className="text-xs text-center text-relay-text-muted">
          You can claim a username later in settings
        </p>
      </div>
    </motion.div>,

    // Step 3: Ready
    // (The real, server-registered recovery code was already shown and
    // acknowledged in app/auth/signup/step3/page.tsx before this component
    // ever mounts — a second, unrelated Math.random()-generated "recovery
    // code" used to be shown here too, which was never persisted or tied
    // to the account in any way. A user who trusted this decoy and
    // discarded the real code would be permanently locked out believing
    // they had a working backup. Removed rather than fixed in place: there
    // is no legitimate reason for a second recovery code to exist.
    <motion.div
      key="step-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="space-y-8 flex flex-col items-center justify-center"
    >
      <motion.div
        animate={{ scale: [1, 1.1, 1] }}
        transition={{ duration: 2, repeat: Infinity }}
        className="text-6xl"
      >
        ✓
      </motion.div>

      <div className="text-center space-y-3 max-w-md">
        <h2 className="text-3xl font-bold text-white">You're all set!</h2>
        <p className="text-relay-text-secondary">
          Your encrypted chat is ready. Add a contact to start messaging.
        </p>
      </div>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onComplete}
        className="px-8 py-3 bg-relay-surface text-white font-semibold rounded-lg transition-all"
      >
        Open Messenger
      </motion.button>

      <p className="text-xs text-center text-relay-text-muted max-w-md">
        Relay stores everything locally on your device. No cloud sync yet, but we're working on it.
      </p>
    </motion.div>,
  ];

  return (
    <div className="fixed inset-0 bg-relay-bg flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <AnimatePresence mode="wait">{steps[currentStep]}</AnimatePresence>

        {/* Progress Indicator */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-12 flex justify-center gap-2"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={currentStep + 1}
          aria-label={`Step ${currentStep + 1} of ${steps.length}`}
        >
          {steps.map((_, idx) => (
            <motion.div
              key={idx}
              className={`h-1 rounded-full transition-all ${
                idx === currentStep
                  ? 'w-6 bg-relay-accent'
                  : 'w-2 bg-relay-surface-hover'
              }`}
              animate={{
                width: idx === currentStep ? 24 : 8,
              }}
            />
          ))}
        </motion.div>
      </div>
    </div>
  );
}
