'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check, AlertCircle, Loader, UserPlus, Search, AtSign, Hash, Camera, Loader2 } from 'lucide-react';
import { resolveUserInput } from '@/lib/messaging/username-lookup';
import { findContactByIdentifier } from '@/lib/messaging/contact-deduplication';
import { parseContactQRData } from '@/lib/messaging/contact-qr';
import { isValidRelayId } from '@/lib/crypto/relay-id';
import { UserAvatar } from './UserAvatar';
import type { Contact } from '@/lib/mock-data';
import { log } from '@/lib/platform/logger';

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}

interface AddContactModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (userId: string, displayName: string, options?: { ephemeral?: boolean }) => Promise<void>;
  existingContacts: Contact[];
}

export const AddContactModal = ({
  isOpen,
  onClose,
  onAdd,
  existingContacts,
}: AddContactModalProps) => {
  const [ghostContact, setGhostContact] = useState(false);
  const [tab, setTab] = useState<'manual' | 'scan'>('manual');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    relayId: string;
    displayName?: string;
    username?: string;
    bio?: string;
    avatarEmoji?: string;
    avatarColor?: string;
  } | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{
    username: string;
    relayId: string;
    displayName?: string;
    avatarEmoji?: string;
    avatarColor?: string;
  }>>([]);
  const inputDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against out-of-order async responses: a slow lookup started by an
  // earlier keystroke can otherwise resolve after a newer one and stomp its
  // result. Same pattern as searchTokenRef in MessageSearchModal.
  const requestIdRef = useRef(0);

  const fetchSuggestions = async (value: string, requestId: number) => {
    const q = value.trim().replace(/^@/, '');
    // Skip suggestions when input looks like it's turning into a Relay ID
    // (8 dash-separated hex groups) or a short code (4 letters-4 digits) —
    // partial-match so suggestions stop as soon as the shape becomes clear,
    // not just once a full id has been typed.
    if (!q || /^[0-9a-f]{1,4}(-[0-9a-f]{0,4}){0,7}$/i.test(q) || /^[a-z]{1,4}(-[0-9]{0,4})?$/i.test(q)) {
      if (requestIdRef.current === requestId) setSuggestions([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/profile/search?q=${encodeURIComponent(q)}&limit=4`,
      );
      if (requestIdRef.current !== requestId) return;
      if (!res.ok) {
        setSuggestions([]);
        return;
      }
      const data = await res.json();
      setSuggestions(Array.isArray(data.results) ? data.results : []);
    } catch {
      if (requestIdRef.current === requestId) setSuggestions([]);
    }
  };

  const handleInputChange = async (value: string) => {
    const requestId = ++requestIdRef.current;
    setInput(value);
    setError(null);
    setResult(null);
    setIsDuplicate(false);
    setSuggestions([]);

    if (!value.trim()) return;

    const suggestPromise = fetchSuggestions(value, requestId);

    try {
      setLoading(true);
      const resolvedInput = await resolveUserInput(value);
      if (requestIdRef.current !== requestId) return;

      if (!resolvedInput) {
        await suggestPromise;
        return;
      }

      const { relayId: resolved, profile } = resolvedInput;

      const existing = findContactByIdentifier(existingContacts, resolved);
      if (existing) {
        setIsDuplicate(true);
        setResult({
          relayId: resolved,
          displayName: existing.name,
          username: existing.username,
        });
        return;
      }

      if (profile) {
        setResult({
          relayId: resolved,
          displayName: profile.displayName || value,
          username: profile.username,
          bio: profile.bio,
          avatarEmoji: profile.avatarEmoji,
          avatarColor: profile.avatarColor,
        });
      } else {
        setResult({
          relayId: resolved,
          displayName: value,
        });
      }
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      log.error('Error during lookup:', err);
      setError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!result) return;

    try {
      setIsAdding(true);
      await onAdd(result.relayId, result.displayName || result.relayId, { ephemeral: ghostContact });
      setGhostContact(false);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add contact');
    } finally {
      setIsAdding(false);
    }
  };

  const handleClose = () => {
    stopCamera();
    if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    setTab('manual');
    setInput('');
    setResult(null);
    setError(null);
    setIsDuplicate(false);
    setSuggestions([]);
    onClose();
  };

  // The footer's Add button isn't gated on `tab` — it stays enabled as long
  // as `result` is set, so switching tabs without clearing it left a stale
  // manual-search result (or vice versa) sitting there, Add still enabled,
  // on whichever tab the user switched to.
  const switchTab = (next: 'manual' | 'scan') => {
    setTab(next);
    setResult(null);
    setIsDuplicate(false);
    setSuggestions([]);
  };

  const handleSuggestionClick = (s: { username: string }) => {
    if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    handleInputChange(s.username);
  };

  /**
   * Debounced entry point for the free-text input field. `handleInputChange`
   * itself fires a resolveUserInput lookup (`GET /api/profile/lookup`,
   * rate-limited at a low threshold to block enumeration) plus a profile
   * search on every call — wiring it directly to onChange meant every
   * keystroke while typing a name fired both requests with no delay, so a
   * single normal contact-add (typing ~10-15 characters, maybe backspacing
   * to fix a typo) could blow through the per-minute budget on its own and
   * get the user rate-limited for legitimate typing. Debounce so we only
   * resolve once typing pauses, matching the pattern already used in
   * GroupDiscoveryModal's search box.
   */
  const handleTextInputChange = (value: string) => {
    setInput(value);
    setError(null);
    setResult(null);
    setIsDuplicate(false);
    setSuggestions([]);

    if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    if (!value.trim()) return;

    inputDebounceRef.current = setTimeout(() => {
      handleInputChange(value);
    }, 300);
  };

  // startQRScan only needs the LATEST handleInputChange at the moment a QR
  // code is detected — not a fresh reference on every render. Routing the
  // call through a ref keeps startQRScan's own identity stable across
  // re-renders, so the QR-scan effect below (which depends on startQRScan)
  // doesn't tear down and restart the camera on every state update while
  // scanning is active.
  const handleInputChangeRef = useRef(handleInputChange);
  handleInputChangeRef.current = handleInputChange;

  // Tracks whether the in-flight scan request is still wanted. Without this,
  // a quick tab switch away from 'scan' while getUserMedia() is still
  // resolving lets the async continuation assign the stream to streamRef
  // *after* the effect's cleanup already ran (and found streamRef empty) —
  // the camera stays on with no code left holding a reference to stop it.
  const scanActiveRef = useRef(false);

  const stopCamera = useCallback(() => {
    scanActiveRef.current = false;
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  const startQRScan = useCallback(async () => {
    setScanError('');
    if (!('BarcodeDetector' in window)) {
      setScanError('QR scanning requires Chrome 83+ or Edge 83+. Use manual entry above.');
      return;
    }
    scanActiveRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (!scanActiveRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (!scanActiveRef.current) {
        stopCamera();
        return;
      }
      setScanning(true);
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const scan = async () => {
        if (!videoRef.current) return;
        try {
          const results = await detector.detect(videoRef.current);
          if (results.length > 0) {
            const raw = results[0].rawValue;
            const relayId = parseContactQRData(raw) ?? (isValidRelayId(raw) ? raw : null);
            if (relayId) {
              stopCamera();
              setTab('manual');
              handleInputChangeRef.current(relayId);
              return;
            }
          }
        } catch { /* frame not ready */ }
        rafRef.current = requestAnimationFrame(scan);
      };
      rafRef.current = requestAnimationFrame(scan);
    } catch {
      setScanError('Camera access denied. Check browser permissions.');
    }
  }, [stopCamera]);

  useEffect(() => {
    if (tab !== 'scan') { stopCamera(); return; }
    startQRScan();
    return stopCamera;
  }, [tab, startQRScan, stopCamera]);

  // Escape closes the modal, matching the backdrop-click behavior. Tab/Shift+Tab
  // are trapped inside the dialog so focus can't leak into the page behind it.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
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
  }, [isOpen, handleClose]);

  // Restore focus to whatever triggered the modal once it closes.
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
    } else {
      previousFocusRef.current?.focus?.();
    }
  }, [isOpen]);

  // Clear any pending debounced lookup if the component unmounts mid-typing.
  useEffect(() => {
    return () => {
      if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    };
  }, []);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
          className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4"
        >
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.9, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 30 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-contact-title"
            className="w-full max-w-lg bg-relay-surface rounded-xl border border-relay-border/80 overflow-hidden"
          >
            {/* Header */}
            <div className="relative px-6 pt-6 pb-4">
              <div className="flex items-center gap-3 mb-1">
                <div className="p-2 rounded-xl bg-relay-surface border border-relay-accent/30">
                  <UserPlus className="w-5 h-5 text-relay-accent" />
                </div>
                <div>
                  <h2 id="add-contact-title" className="text-lg font-bold text-relay-text-primary">
                    Add New Contact
                  </h2>
                  <p className="text-xs text-relay-text-muted">
                    Find people by username or short code
                  </p>
                </div>
              </div>
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleClose}
                aria-label="Close"
                className="absolute top-5 right-5 p-1.5 rounded-lg hover:bg-relay-surface-hover transition-colors"
              >
                <X className="w-5 h-5 text-relay-text-muted hover:text-relay-text-secondary" />
              </motion.button>
            </div>

            {/* Mode tabs */}
            <div className="flex gap-1 px-6 pb-3">
              <button
                onClick={() => switchTab('manual')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === 'manual' ? 'bg-relay-accent/15 text-relay-accent' : 'text-relay-text-muted hover:text-relay-text-primary hover:bg-relay-surface-hover'}`}
              >
                <Search className="w-3.5 h-3.5" /> Search
              </button>
              <button
                onClick={() => switchTab('scan')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === 'scan' ? 'bg-relay-accent/15 text-relay-accent' : 'text-relay-text-muted hover:text-relay-text-primary hover:bg-relay-surface-hover'}`}
              >
                <Camera className="w-3.5 h-3.5" /> Scan QR
              </button>
            </div>

            {tab === 'scan' && (
              <div className="px-6 pb-4 flex flex-col items-center gap-3">
                {scanError ? (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-relay-danger/10 border border-relay-danger/20 text-xs text-relay-danger w-full">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    {scanError}
                  </div>
                ) : scanning ? (
                  <>
                    <div className="relative w-full max-w-[260px] aspect-square rounded-xl overflow-hidden border-2 border-relay-accent">
                      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                      <div className="absolute inset-0 border-[3px] border-relay-accent/50 rounded-xl pointer-events-none" />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-relay-text-muted">
                      <Loader2 className="w-3 h-3 animate-spin" /> Point camera at contact&apos;s QR code
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-relay-text-muted py-4">
                    <Loader2 className="w-3 h-3 animate-spin" /> Starting camera…
                  </div>
                )}
              </div>
            )}

            {/* Search Input */}
            {tab === 'manual' && <div className="px-6 pb-4">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-relay-text-muted" />
                <label htmlFor="add-contact-input" className="sr-only">
                  Username or short code
                </label>
                <input
                  id="add-contact-input"
                  type="text"
                  placeholder="e.g., @alice or xoep-4910"
                  value={input}
                  onChange={(e) => handleTextInputChange(e.target.value)}
                  disabled={isAdding}
                  className="w-full pl-11 pr-12 py-3.5 bg-relay-surface-hover/70 border border-relay-border-light/60 rounded-xl text-sm text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:border-relay-accent/60 focus:ring-2 focus:ring-relay-accent/20 transition-all"
                  autoFocus
                />
                {loading && (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    className="absolute right-4 top-1/2 -translate-y-1/2"
                  >
                    <Loader className="w-4 h-4 text-relay-accent" />
                  </motion.div>
                )}
              </div>
              <div className="flex items-center gap-4 mt-2.5 px-1">
                <span className="flex items-center gap-1.5 text-xs text-relay-text-muted">
                  <AtSign className="w-3 h-3" />
                  username
                </span>
                <span className="flex items-center gap-1.5 text-xs text-relay-text-muted">
                  <Hash className="w-3 h-3" />
                  short code
                </span>
              </div>
            </div>}

            {/* Results Area */}
            <div className="px-6 min-h-[120px]">
              <AnimatePresence mode="wait">
                {isDuplicate && result && (
                  <motion.div
                    key="duplicate"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-center gap-3"
                  >
                    <div className="flex-shrink-0">
                      <UserAvatar
                        emoji={result.avatarEmoji}
                        color={result.avatarColor}
                        size={44}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-relay-text-primary truncate">
                        {result.displayName}
                      </p>
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                        Already in your contacts
                      </p>
                    </div>
                  </motion.div>
                )}

                {result && !isDuplicate && (
                  <motion.div
                    key="result"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="p-4 bg-relay-surface-hover/50 border border-relay-border-light rounded-xl"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex-shrink-0">
                        <UserAvatar
                          emoji={result.avatarEmoji}
                          color={result.avatarColor}
                          size={52}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-base font-bold text-relay-text-primary truncate">
                          {result.displayName}
                        </p>
                        {result.username && (
                          <p className="text-sm text-relay-accent font-mono">
                            @{result.username}
                          </p>
                        )}
                        {result.bio && (
                          <p className="text-xs text-relay-text-secondary mt-1 line-clamp-2">
                            {result.bio}
                          </p>
                        )}
                        <p className="text-xs text-relay-text-muted font-mono mt-1">
                          {result.relayId}
                        </p>
                      </div>
                      <div className="flex-shrink-0">
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center"
                        >
                          <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                        </motion.div>
                      </div>
                    </div>
                  </motion.div>
                )}

                {!result && !loading && input.trim() !== '' && suggestions.length > 0 && (
                  <motion.div
                    key="suggestions"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="py-2"
                  >
                    <p className="text-[11px] uppercase tracking-wide text-relay-text-muted font-semibold px-1 mb-1.5">
                      Did you mean?
                    </p>
                    <ul className="space-y-1">
                      {suggestions.map((s) => (
                        <li key={s.relayId}>
                          <button
                            type="button"
                            onClick={() => handleSuggestionClick(s)}
                            className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-relay-surface-hover/60 border border-transparent hover:border-relay-border-light/40 transition-colors text-left"
                          >
                            <UserAvatar emoji={s.avatarEmoji} color={s.avatarColor} size={32} />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-relay-accent font-mono truncate">
                                @{s.username}
                              </p>
                              {s.displayName && (
                                <p className="text-xs text-relay-text-muted truncate">
                                  {s.displayName}
                                </p>
                              )}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </motion.div>
                )}

                {!error && !result && !loading && input.trim() === '' && (
                  <motion.div
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex flex-col items-center justify-center py-6 text-center"
                  >
                    <div className="w-12 h-12 rounded-full bg-relay-surface-hover/80 flex items-center justify-center mb-3">
                      <Search className="w-5 h-5 text-relay-text-muted" />
                    </div>
                    <p className="text-sm text-relay-text-muted">
                      Search by @username or short code to find contacts
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {result && !isDuplicate && (
              <label className="flex items-start gap-2.5 mx-6 mb-2 p-3 rounded-xl bg-relay-surface-hover/40 border border-relay-border-light cursor-pointer">
                <input
                  type="checkbox"
                  checked={ghostContact}
                  onChange={(e) => setGhostContact(e.target.checked)}
                  className="mt-0.5 accent-relay-accent"
                />
                <span className="text-xs">
                  <span className="font-medium text-relay-text-primary">Ghost contact</span>
                  <span className="block text-relay-text-muted mt-0.5">
                    Never saved to disk — this contact and every message with them vanish the moment you close this tab.
                  </span>
                </span>
              </label>
            )}

            {/* Footer */}
            <div className="flex gap-3 p-6 mt-2">
              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={handleClose}
                className="flex-1 px-4 py-3 rounded-xl text-sm font-medium text-relay-text-secondary bg-relay-surface-hover/60 border border-relay-border-light hover:bg-relay-surface-hover hover:text-relay-text-secondary transition-all"
                disabled={isAdding}
              >
                Cancel
              </motion.button>
              <motion.button
                whileHover={result && !isDuplicate && !isAdding ? { scale: 1.01 } : {}}
                whileTap={result && !isDuplicate && !isAdding ? { scale: 0.99 } : {}}
                onClick={handleAdd}
                disabled={!result || isDuplicate || isAdding || loading}
                className={`
                  flex-1 px-4 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all
                  ${
                    result && !isDuplicate && !isAdding
                      ? 'bg-relay-accent text-relay-accent-foreground hover:bg-relay-accent/90'
                      : 'bg-relay-surface-hover/40 text-relay-text-muted cursor-not-allowed'
                  }
                `}
              >
                {isAdding ? (
                  <>
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    >
                      <Loader className="w-4 h-4" />
                    </motion.div>
                    Adding…
                  </>
                ) : (
                  <>
                    <UserPlus className="w-4 h-4" />
                    Add Contact
                  </>
                )}
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
