'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Loader2, MessageSquare } from 'lucide-react';
import { searchMessages, type SearchResult } from '@/lib/features/message-search';
import { log } from '@/lib/platform/logger';

interface MessageSearchModalProps {
  open: boolean;
  onClose: () => void;
  onResultClick: (conversationId: string, messageId: string) => void;
}

/**
 * Render a snippet with the matched query substring bolded.
 * Case-insensitive, highlights the first occurrence.
 */
function HighlightedSnippet({ snippet, query }: { snippet: string; query: string }) {
  const trimmed = query.trim();
  if (!trimmed) return <>{snippet}</>;

  const lower = snippet.toLowerCase();
  const needle = trimmed.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return <>{snippet}</>;

  const before = snippet.slice(0, idx);
  const match = snippet.slice(idx, idx + trimmed.length);
  const after = snippet.slice(idx + trimmed.length);
  return (
    <>
      {before}
      <strong className="text-relay-accent font-semibold">{match}</strong>
      {after}
    </>
  );
}

function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const oneDay = 24 * 60 * 60 * 1000;
  const d = new Date(ts);
  if (diff < oneDay && d.getDate() === new Date(now).getDate()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 7 * oneDay) {
    return d.toLocaleDateString([], { weekday: 'short' }) +
      ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function MessageSearchModal({ open, onClose, onResultClick }: MessageSearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchedQuery, setSearchedQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTokenRef = useRef(0);

  // Focus the input when opened
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSearchedQuery('');
      setLoading(false);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Debounced live search
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const token = ++searchTokenRef.current;

    debounceRef.current = setTimeout(async () => {
      try {
        const r = await searchMessages(q, { limit: 50 });
        if (searchTokenRef.current === token) {
          setResults(r);
          setSearchedQuery(q);
        }
      } catch (err) {
        log.warn('[MessageSearchModal] Search failed:', err);
        if (searchTokenRef.current === token) {
          setResults([]);
          setSearchedQuery(q);
        }
      } finally {
        if (searchTokenRef.current === token) {
          setLoading(false);
        }
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  const hasQuery = query.trim().length > 0;

  const handleResultClick = (result: SearchResult) => {
    onResultClick(result.conversationId, result.messageId);
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 pt-[10vh]"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -10 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Search messages"
            className="w-full max-w-xl bg-relay-surface border border-relay-border rounded-relay-card overflow-hidden flex flex-col"
          >
            {/* Search header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-relay-border">
              <Search className="w-4.5 h-4.5 text-relay-text-muted flex-shrink-0" aria-hidden="true" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search messages..."
                aria-label="Search messages"
                className="flex-1 bg-transparent text-relay-text-primary placeholder-relay-text-muted text-sm focus:outline-none"
              />
              {loading && (
                <Loader2
                  className="w-4 h-4 text-relay-accent animate-spin flex-shrink-0"
                  aria-hidden="true"
                />
              )}
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1 rounded-relay-sm hover:bg-relay-surface-hover transition-colors text-relay-text-muted hover:text-relay-text-primary outline-none focus-visible:ring-2 focus-visible:ring-relay-accent/60"
                title="Close (Esc)"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {/* Results */}
            <div className="max-h-[60vh] overflow-y-auto">
              {!hasQuery && (
                <div className="px-6 py-12 text-center">
                  <MessageSquare className="w-8 h-8 text-relay-text-muted/50 mx-auto mb-3" aria-hidden="true" />
                  <p className="text-sm text-relay-text-secondary">Search your encrypted messages</p>
                  <p className="text-xs text-relay-text-muted mt-1">
                    Matches are case-insensitive and searched across all conversations.
                  </p>
                </div>
              )}

              {hasQuery && !loading && results.length === 0 && (
                <div className="px-6 py-12 text-center">
                  <p className="text-sm text-relay-text-secondary">No matches found</p>
                  <p className="text-xs text-relay-text-muted mt-1">
                    Try a different search term.
                  </p>
                </div>
              )}

              {results.length > 0 && (
                <ul className="divide-y divide-relay-border">
                  {results.map((r) => (
                    <li key={`${r.conversationId}:${r.messageId}`}>
                      <button
                        onClick={() => handleResultClick(r)}
                        className="w-full text-left px-4 py-3 hover:bg-relay-surface-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-relay-accent/60 focus:bg-relay-surface-hover"
                      >
                        <div className="flex items-baseline justify-between gap-3 mb-1">
                          <span className="text-xs font-semibold text-relay-text-primary truncate">
                            {r.conversationName || 'Conversation'}
                          </span>
                          <span className="text-[11px] font-mono text-relay-text-muted flex-shrink-0">
                            {formatTimestamp(r.timestamp)}
                          </span>
                        </div>
                        <p className="text-xs text-relay-text-secondary leading-relaxed break-words">
                          <HighlightedSnippet snippet={r.snippet} query={searchedQuery} />
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2 border-t border-relay-border bg-relay-bg/50 flex items-center justify-between text-[11px] text-relay-text-muted">
              <span aria-live="polite">
                {results.length > 0
                  ? `${results.length} result${results.length === 1 ? '' : 's'}`
                  : 'Ctrl+F to open · Esc to close'}
              </span>
              <span className="font-mono opacity-70">Relay Search</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
