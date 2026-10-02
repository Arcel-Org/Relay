'use client';

/**
 * GroupDiscoveryModal — search for public groups and join them.
 * Joining with policy 'open' adds the user to the directory's pendingMembers
 * and the host will bootstrap an invite on their next online window.
 * Joining with policy 'request' records a pending join request only.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Search, Users, Loader2 } from 'lucide-react';

interface PublicGroupRecord {
  groupId: string;
  publicHandle: string;
  name: string;
  description?: string;
  avatarEmoji?: string;
  avatarColor?: string;
  memberCount: number;
  ownerRelayId: string;
  joinPolicy: 'open' | 'request';
}

interface Props {
  isOpen: boolean;
  relayId: string | null;
  onClose: () => void;
  onJoined?: (record: PublicGroupRecord) => void;
}

export function GroupDiscoveryModal({ isOpen, relayId, onClose, onJoined }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PublicGroupRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [joinedIds, setJoinedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    // `cancelled` guards against out-of-order responses: if the user keeps
    // typing, an earlier (slower) request could otherwise resolve after a
    // later one and clobber fresher results with stale ones.
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/groups/search?q=${encodeURIComponent(q.trim())}&limit=20`);
        const data = await res.json();
        if (!cancelled) setResults(data.results || []);
      } catch (err) {
        if (!cancelled) setError('Search failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, isOpen]);

  // Escape closes the modal, matching the backdrop-click behavior.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleJoin = async (rec: PublicGroupRecord) => {
    if (!relayId) { setError('Not authenticated'); return; }
    setJoiningId(rec.groupId);
    setError(null);
    try {
      const res = await fetch('/api/groups/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: rec.groupId, relayId }),
      });
      if (!res.ok) throw new Error('Join failed');
      setJoinedIds((prev) => new Set(prev).add(rec.groupId));
      onJoined?.(rec);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Join failed');
    } finally {
      setJoiningId(null);
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
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.15 }}
          className="relay-panel w-full max-w-lg max-h-[80vh] rounded-xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="group-discovery-title"
        >
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-relay-border">
            <div>
              <h3 id="group-discovery-title" className="text-sm font-semibold text-relay-text-primary">Discover public groups</h3>
              <p className="text-[11px] text-relay-text-muted mt-0.5">Search by handle or name</p>
            </div>
            <button onClick={onClose} className="relay-icon-btn" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-3 border-b border-relay-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-relay-text-muted" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="@handle or group name"
                aria-label="Search public groups"
                className="relay-input w-full pl-8"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2">
            {loading && (
              <div role="status" aria-live="polite" className="flex items-center justify-center py-6 text-xs text-relay-text-muted">
                <Loader2 className="w-4 h-4 animate-spin mr-2" aria-hidden="true" /> Searching…
              </div>
            )}
            {!loading && q && results.length === 0 && (
              <p role="status" aria-live="polite" className="text-xs text-relay-text-muted text-center py-6">No groups match.</p>
            )}
            {!loading && !q && (
              <p className="text-xs text-relay-text-muted text-center py-6">Type to search public groups.</p>
            )}
            {results.map((r) => {
              const joined = joinedIds.has(r.groupId);
              const joining = joiningId === r.groupId;
              return (
                <div key={r.groupId} className="flex items-center gap-3 px-2 py-2.5 rounded-md hover:bg-relay-surface-hover/60">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0"
                    style={{ backgroundColor: r.avatarColor || '#4ECDC4', filter: 'saturate(0.7) brightness(0.92)' }}
                    aria-hidden="true"
                  >
                    {r.avatarEmoji || '💬'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-relay-text-primary truncate font-medium">{r.name}</p>
                    <p className="text-[11px] text-relay-text-muted truncate">
                      @{r.publicHandle} · <Users className="inline w-3 h-3" /> {r.memberCount}
                    </p>
                    {r.description && (
                      <p className="text-[11px] text-relay-text-secondary truncate mt-0.5">{r.description}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleJoin(r)}
                    disabled={joining || joined}
                    className="relay-btn-primary text-xs px-3 py-1.5 disabled:opacity-40"
                  >
                    {joined
                      ? (r.joinPolicy === 'open' ? 'Joined' : 'Requested')
                      : joining ? 'Joining…'
                      : r.joinPolicy === 'open' ? 'Join' : 'Request'}
                  </button>
                </div>
              );
            })}
            {error && <p role="alert" className="text-xs text-rose-500 mt-2 text-center">{error}</p>}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
