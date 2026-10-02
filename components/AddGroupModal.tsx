'use client';

/**
 * AddGroupModal — 2-step create-group wizard.
 * Backward-compatible: parent passes (name, memberIds) via onCreate.
 * If the parent is updated to accept the 3rd argument, avatar+description are delivered.
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Search, Check, ChevronRight, ChevronLeft, Smile, AlertTriangle, Palette } from 'lucide-react';
import type { Contact } from '@/lib/mock-data';
import { GROUP_AVATAR_COLORS, getGroupInitials } from '@/lib/messaging/group-display';
import { isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';

// Deferred — see the matching comment in ReactionBar.tsx. This modal is
// itself already lazy from the chat list's perspective, but the emoji
// picker specifically is only opened by a small fraction of group creators
// (avatar emoji is optional), so its ~800KB dataset shouldn't ship with the
// rest of the wizard.
const EmojiPickerPanel = dynamic(
  () => import('@/components/reactions/EmojiPickerPanel').then((m) => m.EmojiPickerPanel),
  { ssr: false }
);

interface GroupCreateOptions {
  avatarEmoji?: string;
  avatarColor?: string;
  description?: string;
  visibility?: 'public' | 'private';
  publicHandle?: string;
  joinPolicy?: 'open' | 'request';
}

interface AddGroupModalProps {
  isOpen: boolean;
  contacts: Contact[];
  onClose: () => void;
  /** Backward compatible: parent may accept 2 or 3 args. */
  onCreate: (name: string, memberIds: string[], options?: GroupCreateOptions) => Promise<void>;
}

const MAX_NAME = 40;
const MAX_DESC = 240;
const MEMBER_WARN_AT = 50;
const MEMBER_SOFT_LIMIT = 256;


export function AddGroupModal({ isOpen, contacts, onClose, onCreate }: AddGroupModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [avatarEmoji, setAvatarEmoji] = useState<string>('💬');
  const [avatarColor, setAvatarColor] = useState<string>(GROUP_AVATAR_COLORS[0]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [publicHandle, setPublicHandle] = useState('');
  const [joinPolicy, setJoinPolicy] = useState<'open' | 'request'>('open');
  const [handleAvailable, setHandleAvailable] = useState<boolean | null>(null);
  const [handleChecking, setHandleChecking] = useState(false);

  // Dismiss emoji picker on outside click
  useEffect(() => {
    if (!emojiPickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-emoji-picker-root]')) return;
      setEmojiPickerOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [emojiPickerOpen]);

  // Ephemeral/ghost contacts are explicitly designed to "never touch disk"
  // (see lib/ephemeral-contacts.ts) — adding one as a group member would
  // permanently persist their relayId to localStorage (group roster) and
  // send it over the wire to every other real group member the moment any
  // governance action (rename, add/remove member, etc.) fans out, defeating
  // that guarantee entirely. Exclude them from the picker.
  const options = useMemo(
    () =>
      contacts
        .filter((c) => !isEphemeralContact(c.relayId || c.id))
        .map((c) => ({ id: c.relayId || c.id, label: c.displayName || c.name })),
    [contacts],
  );

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [options, search]);

  // Debounced handle uniqueness check
  useEffect(() => {
    if (visibility !== 'public' || !publicHandle.trim()) {
      setHandleAvailable(null);
      return;
    }
    const handle = publicHandle.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_\-]{3,32}$/.test(handle)) {
      setHandleAvailable(false);
      return;
    }
    setHandleChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/groups/directory?handle=${encodeURIComponent(handle)}`);
        const data = await res.json();
        setHandleAvailable(!!data.available);
      } catch {
        setHandleAvailable(null);
      } finally {
        setHandleChecking(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [visibility, publicHandle]);

  const reset = () => {
    setStep(1);
    setName('');
    setDescription('');
    setAvatarEmoji('💬');
    setAvatarColor(GROUP_AVATAR_COLORS[0]);
    setSelected(new Set());
    setSearch('');
    setError(null);
    setSaving(false);
    setVisibility('private');
    setPublicHandle('');
    setJoinPolicy('open');
    setHandleAvailable(null);
  };

  const close = () => { reset(); onClose(); };

  // Close on Escape, matching every other modal in the app (this one was
  // missing it, along with the role="dialog"/aria-modal semantics below).
  // reset/close are plain functions (not hooks), so defining them above
  // the `if (!isOpen) return null` guard below — instead of after it, as
  // they were before this — is safe and lets this effect (which must be
  // unconditional, like every hook) reference the same close() the X
  // button and backdrop click already use.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const canAdvance = name.trim().length > 0;

  const handleCreate = async () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) { setError('Group name is required'); setStep(1); return; }
    if (selected.size < 1) { setError('Select at least one contact'); return; }
    if (visibility === 'public') {
      const handle = publicHandle.trim().replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_\-]{3,32}$/.test(handle)) { setError('Handle must be 3-32 chars (a-z, 0-9, _ or -)'); setStep(1); return; }
      if (handleAvailable === false) { setError('Handle is taken'); setStep(1); return; }
    }
    try {
      setSaving(true);
      await onCreate(trimmed, Array.from(selected), {
        avatarEmoji,
        avatarColor,
        description: description.trim() || undefined,
        visibility,
        publicHandle: visibility === 'public' ? publicHandle.trim().replace(/^@/, '').toLowerCase() : undefined,
        joinPolicy: visibility === 'public' ? joinPolicy : undefined,
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={close}
      >
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.15 }}
          className="relay-panel w-full max-w-md max-h-[85vh] rounded-xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-group-title"
        >
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-relay-border">
            <div>
              <h3 id="add-group-title" className="text-sm font-semibold text-relay-text-primary">New group</h3>
              <p className="text-[11px] text-relay-text-muted mt-0.5">Step {step} of 2</p>
            </div>
            <button onClick={close} className="relay-icon-btn" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Progress dots */}
          <div className="flex gap-1.5 px-5 pt-3">
            {[1, 2].map((s) => (
              <div
                key={s}
                className={`h-1 flex-1 rounded-full transition-colors duration-150 ${
                  step >= s ? 'bg-relay-accent' : 'bg-relay-border/60'
                }`}
              />
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {step === 1 ? (
              <div className="space-y-4">
                {/* Avatar preview + name */}
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => setEmojiPickerOpen((v) => !v)}
                    className="relative w-16 h-16 rounded-full flex items-center justify-center text-2xl shrink-0 ring-1 ring-relay-border hover:ring-relay-accent/60 transition"
                    style={{ backgroundColor: avatarColor, filter: 'saturate(0.7) brightness(0.92)' }}
                    title="Pick avatar emoji"
                  >
                    <span>{avatarEmoji || getGroupInitials(name || 'G')}</span>
                    <span className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-relay-surface border border-relay-border flex items-center justify-center">
                      <Smile className="w-3 h-3 text-relay-text-secondary" />
                    </span>
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="relay-section-label">Group name</p>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value.slice(0, MAX_NAME))}
                      placeholder="e.g. Security team"
                      className="relay-input w-full mt-1"
                      autoFocus
                    />
                    <p className="text-[10px] text-relay-text-muted mt-1 text-right">{name.length}/{MAX_NAME}</p>
                  </div>
                </div>

                {/* Emoji picker popover */}
                {emojiPickerOpen && (
                  <div data-emoji-picker-root className="relative">
                    <div className="absolute left-0 right-0 z-10 flex justify-start">
                      <EmojiPickerPanel
                        onSelect={(e) => {
                          setAvatarEmoji(e);
                          setEmojiPickerOpen(false);
                        }}
                        onClose={() => setEmojiPickerOpen(false)}
                      />
                    </div>
                    {/* Spacer so layout doesn't jump */}
                    <div className="h-[440px]" />
                  </div>
                )}

                {/* Color picker */}
                {!emojiPickerOpen && (
                  <div>
                    <p className="relay-section-label mb-1.5 flex items-center gap-1">
                      <Palette className="w-3 h-3" /> Background color
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {GROUP_AVATAR_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => setAvatarColor(c)}
                          className={`w-7 h-7 rounded-full transition-transform ${
                            avatarColor === c ? 'ring-2 ring-offset-2 ring-relay-accent ring-offset-relay-surface' : ''
                          }`}
                          style={{ backgroundColor: c, filter: 'saturate(0.7) brightness(0.92)' }}
                          aria-label={c}
                        />
                      ))}
                      {/* Custom hex */}
                      <button
                        type="button"
                        onClick={() => colorInputRef.current?.click()}
                        className="w-7 h-7 rounded-full border border-dashed border-relay-border-light flex items-center justify-center text-relay-text-muted hover:text-relay-text-primary hover:border-relay-accent transition-colors"
                        title="Custom color"
                      >
                        <Palette className="w-3.5 h-3.5" />
                      </button>
                      <input
                        ref={colorInputRef}
                        type="color"
                        value={avatarColor}
                        onChange={(e) => setAvatarColor(e.target.value)}
                        className="sr-only"
                        tabIndex={-1}
                        aria-hidden
                      />
                      <span className="font-mono text-[11px] text-relay-text-muted">{avatarColor.toUpperCase()}</span>
                    </div>
                  </div>
                )}

                {/* Description */}
                <div>
                  <p className="relay-section-label mb-1.5">Description <span className="text-relay-text-muted font-normal">(optional)</span></p>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESC))}
                    rows={2}
                    className="relay-input w-full resize-none"
                    placeholder="What's this group for?"
                  />
                  <p className="text-[10px] text-relay-text-muted mt-1 text-right">{description.length}/{MAX_DESC}</p>
                </div>

                {/* Visibility */}
                <div>
                  <p className="relay-section-label mb-1.5">Visibility</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setVisibility('private')}
                      className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                        visibility === 'private'
                          ? 'border-relay-accent bg-relay-accent/10 text-relay-text-primary'
                          : 'border-relay-border text-relay-text-secondary hover:text-relay-text-primary'
                      }`}
                    >
                      <div className="font-semibold">Private</div>
                      <div className="text-relay-text-muted mt-0.5">Invite-only, unindexed.</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setVisibility('public')}
                      className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                        visibility === 'public'
                          ? 'border-relay-accent bg-relay-accent/10 text-relay-text-primary'
                          : 'border-relay-border text-relay-text-secondary hover:text-relay-text-primary'
                      }`}
                    >
                      <div className="font-semibold">Public</div>
                      <div className="text-relay-text-muted mt-0.5">Searchable, joinable.</div>
                    </button>
                  </div>
                  {visibility === 'public' && (
                    <div className="mt-3 space-y-2">
                      <div>
                        <p className="relay-section-label mb-1">Public handle</p>
                        <div className="relative">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-relay-text-muted text-sm">@</span>
                          <input
                            value={publicHandle}
                            onChange={(e) => setPublicHandle(e.target.value.replace(/^@/, '').slice(0, 32))}
                            placeholder="yourgroup"
                            className="relay-input w-full pl-6"
                          />
                        </div>
                        <p className="text-[10px] mt-1 text-relay-text-muted">
                          {handleChecking ? 'Checking…'
                            : handleAvailable === true ? <span className="text-relay-success">Available</span>
                            : handleAvailable === false ? <span className="text-rose-500">Unavailable</span>
                            : '3-32 chars: a-z, 0-9, _ or -'}
                        </p>
                      </div>
                      <div>
                        <p className="relay-section-label mb-1">Join policy</p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setJoinPolicy('open')}
                            className={`rounded-md border px-2 py-1.5 text-[11px] ${joinPolicy === 'open' ? 'border-relay-accent text-relay-text-primary' : 'border-relay-border text-relay-text-secondary'}`}
                          >Open (anyone joins)</button>
                          <button
                            type="button"
                            onClick={() => setJoinPolicy('request')}
                            className={`rounded-md border px-2 py-1.5 text-[11px] ${joinPolicy === 'request' ? 'border-relay-accent text-relay-text-primary' : 'border-relay-border text-relay-text-secondary'}`}
                          >Request to join</button>
                        </div>
                      </div>
                    </div>
                  )}
                  <p className="text-[10px] text-relay-text-muted mt-2">
                    Public groups are searchable by handle or name. Private groups are invite-only and never indexed.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Selected chips */}
                {selected.size > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from(selected).map((id) => {
                      const opt = options.find((o) => o.id === id);
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-relay-accent/15 text-relay-accent text-[11px]"
                        >
                          {opt?.label || id}
                          <button onClick={() => toggle(id)} className="hover:opacity-70" aria-label="Remove">
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-relay-text-muted" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search contacts…"
                    className="relay-input w-full pl-8"
                  />
                </div>

                {/* Member count warnings */}
                {selected.size >= MEMBER_WARN_AT && (
                  <p className="flex items-center gap-1.5 text-[11px] text-amber-500 dark:text-amber-400">
                    <AlertTriangle className="w-3 h-3" /> {selected.size} members — large groups can be chatty.
                  </p>
                )}
                {selected.size > MEMBER_SOFT_LIMIT && (
                  <p className="text-[11px] text-rose-500 dark:text-rose-400">
                    Soft limit of {MEMBER_SOFT_LIMIT} members exceeded.
                  </p>
                )}

                {/* Contact list */}
                <div className="space-y-0.5 max-h-[280px] overflow-y-auto">
                  {filteredOptions.length === 0 ? (
                    <p className="text-xs text-relay-text-muted text-center py-6">No contacts</p>
                  ) : (
                    filteredOptions.map((o, i) => {
                      const isChecked = selected.has(o.id);
                      return (
                        <motion.label
                          key={o.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.15, delay: i * 0.015 }}
                          className="flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer hover:bg-relay-surface-hover/60"
                        >
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                              isChecked
                                ? 'bg-relay-accent border-relay-accent text-relay-accent-foreground'
                                : 'border-relay-border'
                            }`}
                          >
                            {isChecked && <Check className="w-3 h-3" />}
                          </div>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={isChecked}
                            onChange={() => toggle(o.id)}
                          />
                          <span className="text-sm text-relay-text-primary truncate">{o.label}</span>
                        </motion.label>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-rose-500 dark:text-rose-400 mt-3">{error}</p>}
          </div>

          <div className="flex items-center justify-between px-5 py-3 border-t border-relay-border">
            <button
              onClick={step === 1 ? close : () => setStep(1)}
              className="relay-btn-secondary text-xs px-3 py-1.5 flex items-center gap-1"
            >
              {step === 1 ? 'Cancel' : (<><ChevronLeft className="w-3 h-3" /> Back</>)}
            </button>
            {step === 1 ? (
              <button
                onClick={() => setStep(2)}
                disabled={!canAdvance}
                className="relay-btn-primary text-xs px-3 py-1.5 flex items-center gap-1 disabled:opacity-40"
              >
                Next <ChevronRight className="w-3 h-3" />
              </button>
            ) : (
              <button
                onClick={handleCreate}
                disabled={saving || selected.size === 0}
                className="relay-btn-primary text-xs px-3 py-1.5 disabled:opacity-40"
              >
                {saving ? 'Creating…' : `Create (${selected.size + 1})`}
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
