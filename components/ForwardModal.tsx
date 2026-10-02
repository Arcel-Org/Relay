'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Search, Share2, X } from 'lucide-react';
import type { Contact, Message } from '@/lib/mock-data';
import { UserAvatar } from './UserAvatar';

interface ForwardModalProps {
  isOpen: boolean;
  message: Message | null;
  contacts: Contact[];
  onClose: () => void;
  onConfirm: (contactIds: string[], message: Message) => void | Promise<void>;
}

export function ForwardModal({
  isOpen,
  message,
  contacts,
  onClose,
  onConfirm,
}: ForwardModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset state when the modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setSelected(new Set());
      setSearch('');
      setSending(false);
    }
  }, [isOpen]);

  // Focus the search input when opened
  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => searchInputRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const name = (c.displayName || c.name || '').toLowerCase();
      const username = (c.username || '').toLowerCase();
      const relayId = (c.relayId || c.id || '').toLowerCase();
      return name.includes(q) || username.includes(q) || relayId.includes(q);
    });
  }, [contacts, search]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (!message || selected.size === 0 || sending) return;
    try {
      setSending(true);
      await onConfirm(Array.from(selected), message);
      onClose();
    } finally {
      setSending(false);
    }
  };

  const previewText = message?.text?.trim() ||
    (message?.fileShare ? `📎 ${message.fileShare.filename}` : '');

  return (
    <AnimatePresence>
      {isOpen && message && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="forward-modal-title"
            className="w-full max-w-md bg-relay-surface border border-relay-border rounded-relay-card overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-relay-border">
              <Share2 className="w-4.5 h-4.5 text-relay-accent" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <h3 id="forward-modal-title" className="text-sm font-semibold text-relay-text-primary">Forward message</h3>
                <p className="text-xs text-relay-text-muted">Choose one or more contacts</p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1 rounded-relay-sm hover:bg-relay-surface-hover transition-colors text-relay-text-muted hover:text-relay-text-primary outline-none focus-visible:ring-2 focus-visible:ring-relay-accent/60"
                title="Close"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {/* Preview of the message being forwarded */}
            {previewText && (
              <div className="px-4 py-2.5 bg-relay-bg/40 border-b border-relay-border">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-relay-text-muted mb-1">
                  Forwarding
                </p>
                <p className="text-xs text-relay-text-secondary italic line-clamp-2 break-words">
                  {previewText}
                </p>
              </div>
            )}

            {/* Search */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-relay-border">
              <Search className="w-4 h-4 text-relay-text-muted" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts..."
                aria-label="Search contacts"
                className="flex-1 bg-transparent text-relay-text-primary placeholder-relay-text-muted text-sm focus:outline-none"
              />
            </div>

            {/* Contacts list */}
            <div className="max-h-[50vh] overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <p className="text-sm text-relay-text-secondary">No contacts found</p>
                </div>
              ) : (
                <ul>
                  {filtered.map((contact) => {
                    const id = contact.relayId || contact.id;
                    const isSelected = selected.has(id);
                    return (
                      <li key={id}>
                        <button
                          onClick={() => toggle(id)}
                          aria-pressed={isSelected}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-relay-accent/60 ${
                            isSelected
                              ? 'bg-relay-accent/10 hover:bg-relay-accent/15'
                              : 'hover:bg-relay-surface-hover'
                          }`}
                        >
                          <UserAvatar
                            emoji={contact.avatarEmoji}
                            color={contact.avatarColor}
                            size={32}
                          />
                          <div className="flex-1 min-w-0 text-left">
                            <p className="text-sm text-relay-text-primary truncate">
                              {contact.displayName || contact.name}
                            </p>
                            {contact.username && (
                              <p className="text-[11px] text-relay-text-muted truncate font-mono">
                                @{contact.username}
                              </p>
                            )}
                          </div>
                          <div
                            className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 transition-colors ${
                              isSelected
                                ? 'bg-relay-accent border-relay-accent'
                                : 'border-relay-border-light'
                            }`}
                          >
                            {isSelected && <Check className="w-3 h-3 text-white" aria-hidden="true" />}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-relay-border flex items-center justify-between gap-2">
              <span className="text-xs text-relay-text-muted">
                {selected.size} selected
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-xs rounded-relay-sm bg-relay-surface-hover text-relay-text-secondary hover:text-relay-text-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={selected.size === 0 || sending}
                  className="px-4 py-1.5 text-xs font-medium rounded-relay-sm bg-relay-accent text-relay-accent-foreground hover:bg-relay-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sending ? 'Forwarding...' : `Forward${selected.size > 0 ? ` (${selected.size})` : ''}`}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
