/**
 * Safety Number Verification Modal
 *
 * Displays the safety number (12 BIP39 words + 5 groups of 6 digits,
 * lib/features/safety-numbers.ts) for a contact so it can be compared
 * out-of-band (in person, voice call, or a separate trusted channel) to
 * confirm there's no MITM sitting between the two identities. Lets the
 * user mark it verified (persisted locally, encrypted, via
 * lib/features/features-store.ts) and clearly flags when a previously
 * verified number is stale because the contact's key changed since.
 */

'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, ShieldCheck, ShieldAlert, Loader2 } from 'lucide-react';
import {
  createSafetyNumber,
  verifySafetyNumber,
  hasSafetyNumberChanged,
  formatSafetyNumberFull,
  formatSafetyNumberDigits,
  type SafetyNumber,
} from '@/lib/features/safety-numbers';
import { getSafetyNumber, storeSafetyNumber } from '@/lib/features/features-store';

interface SafetyNumberModalProps {
  myPublicKeyHex: string;
  myRelayId: string;
  contactPublicKeyHex: string;
  contactRelayId: string;
  contactName: string;
  onClose: () => void;
}

export function SafetyNumberModal({
  myPublicKeyHex,
  myRelayId,
  contactPublicKeyHex,
  contactRelayId,
  contactName,
  onClose,
}: SafetyNumberModalProps) {
  const [safetyNumber, setSafetyNumber] = useState<SafetyNumber | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await getSafetyNumber(contactRelayId).catch(() => null);
      const fresh = createSafetyNumber(myPublicKeyHex, contactPublicKeyHex, myRelayId, contactRelayId);

      if (cancelled) return;

      if (stored && stored.hashHex === fresh.hashHex) {
        // Same key as last time we computed/verified this contact — keep
        // the existing verified state and previousHash as-is (use-relay-
        // messaging.ts already recomputes+invalidates this record the
        // moment it detects a key change, so a matching hashHex here means
        // that's already reflected).
        setSafetyNumber(stored);
      } else {
        // First time seeing this contact, or the modal was opened before
        // the key-change invalidation path ran (e.g. right after a key
        // rotation, before the next message triggers it) — carry the old
        // stored hash forward as previousHash so the "changed" banner
        // still shows immediately rather than waiting for that path.
        setSafetyNumber({ ...fresh, previousHash: stored?.hashHex });
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [myPublicKeyHex, myRelayId, contactPublicKeyHex, contactRelayId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleMarkVerified = async () => {
    if (!safetyNumber) return;
    const verified = verifySafetyNumber({ ...safetyNumber, previousHash: undefined });
    await storeSafetyNumber(verified);
    setSafetyNumber(verified);
  };

  const changed = safetyNumber ? hasSafetyNumberChanged(safetyNumber) : false;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.15 }}
          className="relay-panel w-full max-w-[420px] rounded-xl flex flex-col"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="safety-number-modal-title"
        >
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-relay-border">
            <h3 id="safety-number-modal-title" className="text-sm font-semibold text-relay-text-primary">Verify safety number</h3>
            <button onClick={onClose} className="relay-icon-btn" aria-label="Close">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          <div className="flex flex-col gap-4 p-5">
            <p className="text-xs text-relay-text-secondary">
              Compare this safety number with {contactName} over a trusted channel (in person, a
              voice call, or another verified app) to confirm you're really talking to them and
              not someone in the middle.
            </p>

            {loading || !safetyNumber ? (
              <div className="flex items-center gap-2 text-xs text-relay-text-muted py-6 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Computing…
              </div>
            ) : (
              <>
                {changed && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-relay-danger/40 bg-relay-danger/10 px-3 py-2"
                  >
                    <ShieldAlert className="w-4 h-4 text-relay-danger shrink-0 mt-0.5" aria-hidden="true" />
                    <p className="text-xs text-relay-danger">
                      This contact's key changed since you last verified them. Re-verify before
                      trusting new messages.
                    </p>
                  </div>
                )}

                <div className="rounded-lg border border-relay-border bg-relay-surface-hover px-4 py-3">
                  <p className="text-[11px] text-relay-text-muted mb-2">12-word safety number</p>
                  <p className="font-mono text-sm text-relay-text-primary whitespace-pre-line leading-relaxed">
                    {formatSafetyNumberFull(safetyNumber)}
                  </p>
                </div>

                <div className="rounded-lg border border-relay-border bg-relay-surface-hover px-4 py-3">
                  <p className="text-[11px] text-relay-text-muted mb-2">For voice verification</p>
                  <p className="font-mono text-sm text-relay-text-primary tracking-wide">
                    {formatSafetyNumberDigits(safetyNumber)}
                  </p>
                </div>

                {safetyNumber.verified ? (
                  <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
                    <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                    Verified{safetyNumber.verifiedAt ? ` on ${new Date(safetyNumber.verifiedAt).toLocaleDateString()}` : ''}
                  </div>
                ) : (
                  <button onClick={handleMarkVerified} className="relay-btn-primary w-full">
                    <ShieldCheck className="w-4 h-4" aria-hidden="true" /> Numbers match — mark verified
                  </button>
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
