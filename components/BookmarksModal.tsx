'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Bookmark as BookmarkIcon, Search, Trash2 } from 'lucide-react';
import { getBookmarks, removeBookmark, type Bookmark } from '@/lib/features/bookmarks';

interface BookmarksModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJump?: (conversationId: string, messageId: string) => void;
}

export function BookmarksModal({ isOpen, onClose, onJump }: BookmarksModalProps) {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (isOpen) {
      setItems(getBookmarks());
      setQuery('');
    }
  }, [isOpen]);

  // Close on Escape, matching every other modal in the app.
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
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (b) =>
        b.text.toLowerCase().includes(q) ||
        (b.senderName || '').toLowerCase().includes(q)
    );
  }, [items, query]);

  const handleRemove = (id: string) => {
    setItems(removeBookmark(id));
  };

  const handleClick = (b: Bookmark) => {
    onJump?.(b.conversationId, b.id);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bookmarks-title"
            className="w-full max-w-lg bg-relay-surface rounded-xl border border-relay-border/80 overflow-hidden flex flex-col max-h-[80vh]"
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-relay-border">
              <div className="p-2 rounded-lg bg-relay-surface-hover/60">
                <BookmarkIcon className="w-4 h-4 text-relay-accent" />
              </div>
              <div className="flex-1">
                <h2 id="bookmarks-title" className="text-base font-bold text-relay-text-primary">Bookmarks</h2>
                <p className="text-xs text-relay-text-muted">
                  {items.length} saved message{items.length === 1 ? '' : 's'}
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1.5 rounded-lg hover:bg-relay-surface-hover transition-colors"
              >
                <X className="w-4 h-4 text-relay-text-muted" />
              </button>
            </div>

            <div className="px-5 py-3 border-b border-relay-border">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-relay-text-muted" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search bookmarks…"
                  aria-label="Search bookmarks"
                  className="w-full pl-9 pr-3 py-2 bg-relay-surface-hover/60 border border-relay-border-light/60 rounded-lg text-sm text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:border-relay-accent/60"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-2">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <BookmarkIcon className="w-8 h-8 text-relay-text-muted mb-2 opacity-50" />
                  <p className="text-sm text-relay-text-muted">
                    {items.length === 0 ? 'No bookmarks yet' : 'No matches'}
                  </p>
                </div>
              ) : (
                <ul className="space-y-1">
                  {filtered.map((b) => (
                    <li key={b.id}>
                      <div className="group flex items-start gap-2 p-3 rounded-lg hover:bg-relay-surface-hover/50 transition-colors">
                        <button
                          onClick={() => handleClick(b)}
                          className="flex-1 text-left min-w-0"
                        >
                          <div className="flex items-baseline gap-2 mb-0.5">
                            <span className="text-xs font-semibold text-relay-accent truncate">
                              {b.senderName || 'Unknown'}
                            </span>
                            <span className="text-[10px] text-relay-text-muted font-mono">
                              {new Date(b.timestamp).toLocaleDateString()}
                            </span>
                          </div>
                          <p className="text-sm text-relay-text-primary line-clamp-2 break-words">
                            {b.text || '(no text)'}
                          </p>
                        </button>
                        <button
                          onClick={() => handleRemove(b.id)}
                          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 p-1.5 rounded hover:bg-rose-500/10 text-rose-500 transition-all"
                          title="Remove bookmark"
                          aria-label="Remove bookmark"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
