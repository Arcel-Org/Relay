'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check, ShieldOff, Shield, MessageCircle, UserX, Key, Eye, EyeOff, Pencil, Flag } from 'lucide-react';
import { sha256 } from '@noble/hashes/sha2.js';
import { lookupUserProfile, type UserProfileData } from '@/lib/messaging/username-lookup';
import { copyToClipboard } from '@/lib/utils';
import { UserAvatar } from './UserAvatar';
import { log } from '@/lib/platform/logger';

interface ContactProfileViewerProps {
  relayId: string;
  displayName?: string;
  isOpen: boolean;
  onClose: () => void;
  isBlocked?: boolean;
  onBlock?: (relayId: string) => void;
  onUnblock?: (relayId: string) => void;
  /** Optional public key (hex) of this contact — if provided, fingerprint section renders. */
  publicKeyHex?: string;
  /** When true, render as self-profile (no block/remove actions, show Edit profile button). */
  isSelf?: boolean;
  /** Optional contact metadata for the compact footer list. */
  addedAt?: number;
  messageCount?: number;
  isOnline?: boolean;
  onMessage?: (relayId: string) => void;
  onRemove?: (relayId: string) => void;
  onEditProfile?: () => void;
  onVerifySafetyNumbers?: (relayId: string) => void;
}

// Must match REPORT_CATEGORIES in lib/db/abuse-reports-db.ts (a server-only
// module — not imported here directly since it pulls in @libsql/client).
const REPORT_CATEGORIES = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'csam', label: 'Child sexual abuse material' },
  { value: 'other', label: 'Other' },
] as const;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').replace(/\s+/g, '');
  if (clean.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function computeFingerprint(publicKeyHex?: string): string | null {
  if (!publicKeyHex) return null;
  try {
    const bytes = hexToBytes(publicKeyHex);
    if (!bytes.length) return null;
    const hash = sha256(bytes);
    let hex = '';
    for (let i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
    return hex.toUpperCase().slice(0, 32).match(/.{1,4}/g)?.join(' ') || null;
  } catch {
    return null;
  }
}

export const ContactProfileViewer = ({
  relayId,
  displayName,
  isOpen,
  onClose,
  isBlocked = false,
  onBlock,
  onUnblock,
  publicKeyHex,
  isSelf = false,
  addedAt,
  messageCount,
  isOnline,
  onMessage,
  onRemove,
  onEditProfile,
  onVerifySafetyNumbers,
}: ContactProfileViewerProps) => {
  const [profile, setProfile] = useState<UserProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'id' | 'key' | null>(null);
  const [showFullKey, setShowFullKey] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState<(typeof REPORT_CATEGORIES)[number]['value']>('spam');
  const [reportNote, setReportNote] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportResult, setReportResult] = useState<'success' | 'error' | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const fingerprint = useMemo(() => computeFingerprint(publicKeyHex), [publicKeyHex]);

  useEffect(() => {
    setReportOpen(false);
    setReportNote('');
    setReportResult(null);
    setReportCategory('spam');
  }, [isOpen, relayId]);

  useEffect(() => {
    if (!isOpen) return;
    // `cancelled` prevents a slow lookup for a previously-viewed relayId from
    // overwriting the profile once the viewer has moved on to another
    // contact — without it, a stale response could attribute the wrong
    // displayName/bio/avatar to the relayId currently shown in the header.
    let cancelled = false;
    const loadProfile = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await lookupUserProfile(relayId);
        if (!cancelled) setProfile(data);
      } catch (err) {
        log.error('Failed to load profile:', err);
        if (!cancelled) setError('Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadProfile();
    return () => { cancelled = true; };
  }, [isOpen, relayId]);

  // Escape closes the modal, matching the backdrop-click behavior;
  // Tab/Shift+Tab are trapped inside the dialog so focus can't leak into
  // the page behind it (same pattern as AddContactModal.tsx).
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  // Restore focus to whatever triggered the modal once it closes.
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
    } else {
      previousFocusRef.current?.focus?.();
    }
  }, [isOpen]);

  const handleCopy = async (value: string, kind: 'id' | 'key') => {
    await copyToClipboard(value);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1800);
  };

  // No evidence/attachment upload here, deliberately — a report is a
  // category + optional note only, reviewed by the operator. See
  // app/api/reports/route.ts and lib/db/abuse-reports-db.ts.
  const submitReport = async () => {
    setReportSubmitting(true);
    setReportResult(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRelayId: relayId, category: reportCategory, note: reportNote || undefined }),
      });
      if (!res.ok) throw new Error('Report failed');
      setReportResult('success');
      setReportNote('');
      setTimeout(() => { setReportOpen(false); setReportResult(null); }, 1600);
    } catch (err) {
      log.error('Failed to submit report:', err);
      setReportResult('error');
    } finally {
      setReportSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const addedStr = addedAt ? new Date(addedAt).toLocaleDateString() : null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        onClick={onClose}
      >
        <motion.div
          ref={dialogRef}
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          className="relay-panel rounded-xl max-w-md w-full overflow-hidden flex flex-col max-h-[90vh]"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="contact-profile-title"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-relay-border">
            <h2 id="contact-profile-title" className="text-sm font-semibold text-relay-text-primary">
              {isSelf ? 'Your profile' : 'Contact profile'}
            </h2>
            <button onClick={onClose} className="relay-icon-btn" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-5 overflow-y-auto flex-1">
            {loading ? (
              <div className="text-center py-10">
                <div className="inline-block w-7 h-7 border-2 border-relay-accent border-t-transparent rounded-full animate-spin" />
                <p className="text-relay-text-secondary text-sm mt-3">Loading profile…</p>
              </div>
            ) : (
              <>
                {/* Avatar */}
                <div className="flex flex-col items-center gap-3">
                  <div style={{ filter: 'saturate(0.7) brightness(0.92)' }}>
                    <UserAvatar
                      emoji={profile?.avatarEmoji}
                      color={profile?.avatarColor}
                      size={88}
                    />
                  </div>
                  <div className="text-center">
                    {(profile?.displayName || displayName) && (
                      <p className="text-lg font-semibold text-relay-text-primary">
                        {profile?.displayName || displayName}
                      </p>
                    )}
                    {profile?.username && (
                      <p className="text-sm text-relay-text-muted font-mono">@{profile.username}</p>
                    )}
                  </div>
                </div>

                {error && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-600 dark:text-rose-400 text-xs">
                    {error}
                  </div>
                )}

                {/* Relay ID */}
                <div>
                  <p className="relay-section-label mb-1.5">Relay ID</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2.5 py-1.5 bg-relay-surface-hover text-relay-text-muted rounded-md font-mono text-xs break-all">
                      {relayId}
                    </code>
                    <button
                      onClick={() => handleCopy(relayId, 'id')}
                      className="relay-icon-btn"
                      title="Copy ID"
                      aria-label="Copy ID"
                    >
                      {copied === 'id' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                  <span className="sr-only" aria-live="polite">{copied === 'id' ? 'Copied to clipboard' : ''}</span>
                </div>

                {/* Bio */}
                {profile?.bio && (
                  <div>
                    <p className="relay-section-label mb-1.5">Bio</p>
                    <p className="text-sm text-relay-text-secondary leading-relaxed whitespace-pre-wrap">
                      {profile.bio}
                    </p>
                  </div>
                )}

                {/* Public key — ALWAYS present when we have one */}
                {publicKeyHex && (
                  <div>
                    <p className="relay-section-label mb-1.5 flex items-center gap-1.5">
                      <Key className="w-3 h-3" /> Public key
                    </p>
                    {fingerprint && (
                      <div className="flex items-center gap-2 mb-2">
                        <code className="flex-1 px-2.5 py-1.5 bg-relay-surface-hover text-relay-text-primary rounded-md font-mono text-[11px] tracking-wider">
                          {fingerprint}
                        </code>
                        <span className="text-[10px] text-relay-text-muted">fingerprint</span>
                      </div>
                    )}
                    <button
                      onClick={() => setShowFullKey((v) => !v)}
                      className="text-xs text-relay-accent hover:underline inline-flex items-center gap-1"
                      aria-expanded={showFullKey}
                    >
                      {showFullKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                      {showFullKey ? 'Hide full key' : 'Show full key'}
                    </button>
                    {showFullKey && (
                      <div className="mt-2 flex items-start gap-2">
                        <code className="flex-1 px-2.5 py-1.5 bg-relay-surface-hover text-relay-text-muted rounded-md font-mono text-[10px] break-all max-h-32 overflow-auto">
                          {publicKeyHex}
                        </code>
                        <button
                          onClick={() => handleCopy(publicKeyHex, 'key')}
                          className="relay-icon-btn"
                          title="Copy public key"
                          aria-label="Copy public key"
                        >
                          {copied === 'key' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <span className="sr-only" aria-live="polite">{copied === 'key' ? 'Copied to clipboard' : ''}</span>
                      </div>
                    )}
                    {!isSelf && onVerifySafetyNumbers && (
                      <button
                        onClick={() => onVerifySafetyNumbers(relayId)}
                        className="relay-btn-secondary text-xs px-3 py-1.5 mt-3 inline-flex items-center gap-1.5"
                      >
                        <Shield className="w-3 h-3" /> Verify safety numbers
                      </button>
                    )}
                  </div>
                )}

                {/* Compact facts */}
                <div className="grid grid-cols-3 gap-2 text-center pt-2 border-t border-relay-border">
                  <div>
                    <p className="text-[10px] text-relay-text-muted uppercase tracking-wider">Added</p>
                    <p className="text-xs text-relay-text-primary font-medium mt-0.5">{addedStr || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-relay-text-muted uppercase tracking-wider">Messages</p>
                    <p className="text-xs text-relay-text-primary font-medium mt-0.5">{messageCount ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-relay-text-muted uppercase tracking-wider">Status</p>
                    <p className={`text-xs font-medium mt-0.5 ${isOnline ? 'text-emerald-500' : 'text-relay-text-muted'}`}>
                      {isOnline ? 'Online' : 'Offline'}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Report panel — replaces the action bar while open */}
          {!isSelf && reportOpen && (
            <div className="border-t border-relay-border px-5 py-3 space-y-2.5">
              <p className="relay-section-label">Report this Relay ID</p>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Report category">
                {REPORT_CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setReportCategory(c.value)}
                    role="radio"
                    aria-checked={reportCategory === c.value}
                    className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                      reportCategory === c.value
                        ? 'bg-relay-accent text-white border-relay-accent'
                        : 'border-relay-border text-relay-text-secondary hover:bg-relay-surface-hover'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <textarea
                value={reportNote}
                onChange={(e) => setReportNote(e.target.value.slice(0, 500))}
                placeholder="Optional context (no message content — we can't see it)"
                aria-label="Optional context for report"
                rows={2}
                className="w-full text-xs px-2.5 py-1.5 bg-relay-surface-hover border border-relay-border rounded-md text-relay-text-primary placeholder:text-relay-text-muted resize-none"
              />
              <div aria-live="polite">
                {reportResult === 'success' && (
                  <p className="text-xs text-emerald-500">Reported. Thank you.</p>
                )}
                {reportResult === 'error' && (
                  <p className="text-xs text-rose-500">Failed to send report — try again.</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={submitReport}
                  disabled={reportSubmitting}
                  className="relay-btn-primary text-xs px-3 py-1.5 flex-1"
                >
                  {reportSubmitting ? 'Sending…' : 'Submit report'}
                </button>
                <button
                  onClick={() => { setReportOpen(false); setReportResult(null); }}
                  className="relay-btn-secondary text-xs px-3 py-1.5"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Action bar */}
          {!(reportOpen && !isSelf) && (
            <div className="border-t border-relay-border px-5 py-3 flex items-center gap-2">
              {isSelf ? (
                <button
                  onClick={() => { onEditProfile?.(); }}
                  className="relay-btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 flex-1 justify-center"
                >
                  <Pencil className="w-3 h-3" /> Edit profile
                </button>
              ) : (
                <>
                  {onMessage && (
                    <button
                      onClick={() => { onMessage(relayId); onClose(); }}
                      className="relay-btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 flex-1 justify-center"
                    >
                      <MessageCircle className="w-3 h-3" /> Message
                    </button>
                  )}
                  {(onBlock || onUnblock) && (
                    <button
                      onClick={() => (isBlocked ? onUnblock?.(relayId) : onBlock?.(relayId))}
                      className="relay-btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
                      title={isBlocked ? 'Unblock' : 'Block'}
                    >
                      {isBlocked ? <Shield className="w-3 h-3" /> : <ShieldOff className="w-3 h-3" />}
                      {isBlocked ? 'Unblock' : 'Block'}
                    </button>
                  )}
                  {onRemove && (
                    <button
                      onClick={() => onRemove(relayId)}
                      className="relay-btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 text-rose-500 dark:text-rose-400"
                      title="Remove contact"
                    >
                      <UserX className="w-3 h-3" /> Remove
                    </button>
                  )}
                  <button
                    onClick={() => setReportOpen(true)}
                    className="relay-icon-btn"
                    title="Report"
                    aria-label="Report this Relay ID"
                  >
                    <Flag className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
