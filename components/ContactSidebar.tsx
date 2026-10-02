'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, MessageCircle, Archive, ArchiveRestore, MoreHorizontal, Users, Pin, PinOff, Search, X } from 'lucide-react';
import { searchMessages, type SearchResult } from '@/lib/features/message-search';
import type { Contact } from '@/lib/mock-data';
import type { GroupConversation } from '@/lib/hooks/messaging-types';
import { ContactProfileViewer } from './ContactProfileViewer';
import { UserAvatar } from './UserAvatar';
import { archiveContact, unarchiveContact } from '@/lib/features/archive';
import { blockContact, unblockContact } from '@/lib/features/block';
import { log } from '@/lib/platform/logger';
import { FolderTabs } from './chats/FolderTabs';
import { FolderEditModal } from './chats/FolderEditModal';
import {
  ALL_FOLDER,
  ALL_FOLDER_ID,
  type ChatFolder,
  type ChatSummary,
  getFolders,
  getPinnedSet,
  setPinned,
  getMutedSet,
  matchesFolder,
} from '@/lib/features/chat-folders';
import { getGroupInitials } from '@/lib/messaging/group-display';

interface ContactSidebarProps {
  contacts: Contact[];
  groups?: GroupConversation[];
  onSelectContact: (contactId: string) => void;
  onSelectGroup?: (groupId: string) => void;
  selectedContactId?: string | null;
  selectedGroupId?: string | null;
  displayName?: string;
  userInitials?: string;
  userAvatarEmoji?: string;
  userAvatarColor?: string;
  onNewContact?: () => void;
  onNewGroup?: () => void;
  onManageGroup?: (groupId: string) => void;
  /** Called after a contact is archived or unarchived so the parent can refresh */
  onArchiveChange?: () => void;
  /** Render a compact icon rail instead of the full list. */
  compact?: boolean;
}

type ChatRow =
  | { kind: 'dm'; id: string; sortKey: number; pinned: boolean; muted: boolean; unread: number; contact: Contact }
  | { kind: 'group'; id: string; sortKey: number; pinned: boolean; muted: boolean; unread: number; group: GroupConversation };

const ACTIVE_FOLDER_KEY = 'relay:active-folder';

export const ContactSidebar = React.memo(function ContactSidebarInner({
  contacts,
  groups = [],
  onSelectContact,
  onSelectGroup,
  selectedContactId,
  selectedGroupId,
  onNewContact,
  onNewGroup,
  onManageGroup,
  onArchiveChange,
  compact = false,
}: ContactSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!q.trim()) { setSearchResults([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const results = await searchMessages(q, { limit: 30 });
        setSearchResults(results);
      } catch { setSearchResults([]); }
      finally { setSearchLoading(false); }
    }, 300);
  }, []);

  const [selectedProfile, setSelectedProfile] = useState<{
    relayId: string;
    displayName?: string;
    publicKeyHex?: string;
  } | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [localArchived, setLocalArchived] = useState<Record<string, boolean>>({});

  // Escape closes the per-contact context menu — previously only
  // onMouseLeave dismissed it (mouse-only), leaving keyboard users with no
  // way to back out once it was open.
  useEffect(() => {
    if (!contextMenuId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenuId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contextMenuId]);

  // Folders
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [foldersTick, setFoldersTick] = useState(0);
  // Start with the default so SSR and first client render match; hydrate
  // from localStorage in an effect to avoid hydration mismatch errors.
  const [activeFolderId, setActiveFolderId] = useState<string>(ALL_FOLDER_ID);
  const folderHydratedRef = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem(ACTIVE_FOLDER_KEY);
    if (stored) setActiveFolderId(stored);
    folderHydratedRef.current = true;
  }, []);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderBeingEdited, setFolderBeingEdited] = useState<ChatFolder | null>(null);

  useEffect(() => {
    setFolders(getFolders());
  }, [foldersTick]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Avoid writing the default back over a stored value before hydration.
    if (!folderHydratedRef.current) return;
    localStorage.setItem(ACTIVE_FOLDER_KEY, activeFolderId);
  }, [activeFolderId]);

  const pinnedSet = useMemo(() => getPinnedSet(), [foldersTick]);
  const mutedSet = useMemo(() => getMutedSet(), [foldersTick]);

  const isArchived = (c: Contact): boolean => {
    const key = c.relayId || c.id;
    if (key in localArchived) return localArchived[key];
    return !!c.archived;
  };

  const togglePinned = (chatId: string) => {
    const pinned = pinnedSet.has(chatId);
    setPinned(chatId, !pinned);
    setContextMenuId(null);
    setFoldersTick((n) => n + 1);
  };

  const toggleArchive = async (c: Contact) => {
    const relayId = c.relayId || c.id;
    const nextArchived = !isArchived(c);
    setLocalArchived((prev) => ({ ...prev, [relayId]: nextArchived }));
    setContextMenuId(null);
    try {
      if (nextArchived) await archiveContact(relayId);
      else await unarchiveContact(relayId);
      onArchiveChange?.();
    } catch (err) {
      log.error('Failed to toggle archive:', err);
      setLocalArchived((prev) => ({ ...prev, [relayId]: !nextArchived }));
    }
  };

  const handleBlock = async (relayId: string) => {
    try {
      await blockContact(relayId);
      // Reuses onArchiveChange's "a contact's local metadata flag changed,
      // please refresh" contract rather than adding a near-duplicate prop.
      onArchiveChange?.();
    } catch (err) {
      log.error('Failed to block contact:', err);
    }
  };

  const handleUnblock = async (relayId: string) => {
    try {
      await unblockContact(relayId);
      onArchiveChange?.();
    } catch (err) {
      log.error('Failed to unblock contact:', err);
    }
  };

  const getUnreadCountContact = (contact: Contact) =>
    contact.messages.filter((m) => !m.isOwn && !m.read).length;

  const getUnreadCountGroup = (g: GroupConversation) =>
    g.messages.filter((m) => !m.isOwn && !m.read).length;

  const lastContactTime = (contact: Contact): number => {
    if (contact.messages.length === 0) return 0;
    const t = contact.messages[contact.messages.length - 1].timestamp;
    return t instanceof Date ? t.getTime() : Number(t) || 0;
  };

  const lastGroupTime = (g: GroupConversation): number => {
    if (g.messages.length === 0) return g.createdAt || 0;
    const t = g.messages[g.messages.length - 1].timestamp;
    return t instanceof Date ? t.getTime() : Number(t) || 0;
  };

  // Build unified list
  const allRows = useMemo<ChatRow[]>(() => {
    const rows: ChatRow[] = [];

    for (const c of contacts) {
      const archived = isArchived(c);
      if (tab === 'active' && archived) continue;
      if (tab === 'archived' && !archived) continue;
      const id = c.relayId || c.id;
      rows.push({
        kind: 'dm',
        id,
        sortKey: lastContactTime(c),
        pinned: pinnedSet.has(id),
        muted: mutedSet.has(id),
        unread: getUnreadCountContact(c),
        contact: c,
      });
    }

    if (tab === 'active') {
      for (const g of groups) {
        rows.push({
          kind: 'group',
          id: g.id,
          sortKey: lastGroupTime(g),
          pinned: pinnedSet.has(g.id),
          muted: mutedSet.has(g.id),
          unread: getUnreadCountGroup(g),
          group: g,
        });
      }
    }

    // Sort: pinned first, then sortKey desc
    rows.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.sortKey - a.sortKey;
    });

    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, groups, tab, localArchived, pinnedSet, mutedSet]);

  // Filter by active folder
  const activeFolder = activeFolderId === ALL_FOLDER_ID
    ? ALL_FOLDER
    : folders.find((f) => f.id === activeFolderId) || ALL_FOLDER;

  const filteredRows = useMemo(() => {
    if (activeFolder.id === ALL_FOLDER_ID) return allRows;
    return allRows.filter((r) =>
      matchesFolder(activeFolder, {
        id: r.id,
        type: r.kind,
        unread: r.unread,
        pinned: r.pinned,
        muted: r.muted,
      }),
    );
  }, [allRows, activeFolder]);

  // For each row, pick the first USER folder (skipping "All") whose filters match.
  const rowFolderColor = (row: ChatRow): string | undefined => {
    const summary: ChatSummary = {
      id: row.id,
      type: row.kind,
      unread: row.unread,
      pinned: row.pinned,
      muted: row.muted,
    };
    for (const f of folders) {
      if (f.id === ALL_FOLDER_ID) continue;
      if (matchesFolder(f, summary)) {
        return f.color;
      }
    }
    return undefined;
  };

  // Summaries for folder tab badges
  const allSummaries: ChatSummary[] = useMemo(
    () => allRows.map((r) => ({ id: r.id, type: r.kind, unread: r.unread, pinned: r.pinned, muted: r.muted })),
    [allRows],
  );

  const formatTime = (t: number) => {
    if (!t) return '';
    const time = new Date(t);
    const now = new Date();
    if (time.toDateString() === now.toDateString()) {
      return time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (time.toDateString() === y.toDateString()) return 'Yesterday';
    return time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const dmPreview = (c: Contact) => {
    if (c.messages.length === 0) return 'No messages';
    const last = c.messages[c.messages.length - 1];
    return last.text.substring(0, 40) + (last.text.length > 40 ? '…' : '');
  };

  const groupPreview = (g: GroupConversation) => {
    if (g.messages.length === 0) return 'No messages yet';
    const m = g.messages[g.messages.length - 1];
    const sender = m.senderName ? `${m.senderName}: ` : '';
    const text = m.text || (m.fileShare ? 'Sent a file' : '');
    const full = `${sender}${text}`;
    return full.length > 48 ? full.slice(0, 48) + '…' : full;
  };

  const openCreateFolder = () => {
    setFolderBeingEdited(null);
    setFolderModalOpen(true);
  };
  const openEditFolder = (f: ChatFolder) => {
    setFolderBeingEdited(f);
    setFolderModalOpen(true);
  };
  const handleFoldersChanged = () => setFoldersTick((n) => n + 1);

  if (compact) {
    return (
      <div className="flex flex-col h-full bg-relay-surface items-center py-2 gap-1 overflow-y-auto">
        {onNewContact && (
          <button
            onClick={onNewContact}
            className="relay-icon-btn"
            title="New conversation"
            aria-label="New conversation"
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
        <div className="w-8 h-px bg-relay-border/50 my-1" />
        {allRows.slice(0, 20).map((row) => {
          if (row.kind === 'dm') {
            const contact = row.contact;
            const isSelected = selectedContactId === contact.id;
            return (
              <button
                key={`rail-dm-${contact.id}`}
                onClick={() => onSelectContact(contact.id)}
                aria-current={isSelected ? 'true' : undefined}
                className={`relative p-0.5 rounded-full transition-colors ${
                  isSelected ? 'ring-2 ring-relay-accent' : 'hover:ring-1 hover:ring-relay-border'
                }`}
                title={contact.name}
                aria-label={contact.name}
              >
                <UserAvatar
                  emoji={contact.avatarEmoji}
                  color={contact.avatarColor}
                  size={36}
                  online={!!contact.isOnline}
                  selected={isSelected}
                />
                {row.unread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-relay-accent text-[9px] font-bold text-white flex items-center justify-center">
                    {row.unread > 9 ? '9+' : row.unread}
                  </span>
                )}
              </button>
            );
          }
          const g = row.group;
          const isSelected = selectedGroupId === g.id;
          return (
            <button
              key={`rail-g-${g.id}`}
              onClick={() => onSelectGroup?.(g.id)}
              aria-current={isSelected ? 'true' : undefined}
              className={`relative w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                isSelected
                  ? 'bg-relay-accent/20 text-relay-accent ring-2 ring-relay-accent'
                  : 'bg-relay-surface-hover text-relay-text-secondary hover:bg-relay-surface-hover/80'
              }`}
              title={g.name}
              aria-label={g.name}
            >
              {getGroupInitials(g.name)}
              {row.unread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-relay-accent text-[9px] font-bold text-white flex items-center justify-center">
                  {row.unread > 9 ? '9+' : row.unread}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-full bg-relay-surface">
        {/* Folder tab strip */}
        <FolderTabs
          folders={folders}
          chats={allSummaries}
          activeFolderId={activeFolderId}
          onChange={setActiveFolderId}
          onCreate={openCreateFolder}
          onEdit={openEditFolder}
          onFoldersChanged={handleFoldersChanged}
        />

        {/* Messages label + new chat/group buttons */}
        <div className="px-4 py-2 flex items-center justify-between">
          <h2 className="relay-section-label">Messages</h2>
          <div className="flex items-center gap-1">
            {onNewGroup && (
              <button
                onClick={onNewGroup}
                className="relay-icon-btn"
                title="New group"
                aria-label="New group"
              >
                <Users className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onNewContact}
              className="relay-icon-btn"
              title="Start new conversation"
              aria-label="Start new conversation"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Active / Archived tab toggle */}
        <div className="px-3 pt-2 pb-2 flex items-center gap-1">
          <button
            onClick={() => setTab('active')}
            className={`flex-1 px-3 py-1.5 rounded-relay-sm text-xs font-medium transition-colors ${
              tab === 'active'
                ? 'bg-relay-accent/15 text-relay-accent'
                : 'text-relay-text-muted hover:text-relay-text-primary hover:bg-relay-surface-hover'
            }`}
          >
            Active
          </button>
          <button
            onClick={() => setTab('archived')}
            className={`flex-1 px-3 py-1.5 rounded-relay-sm text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
              tab === 'archived'
                ? 'bg-relay-accent/15 text-relay-accent'
                : 'text-relay-text-muted hover:text-relay-text-primary hover:bg-relay-surface-hover'
            }`}
          >
            <Archive className="w-3 h-3" />
            Archived
          </button>
        </div>

        {/* Search bar */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-relay-text-muted pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search messages…"
              aria-label="Search messages"
              className="w-full pl-9 pr-8 py-2 text-xs bg-relay-surface-hover/60 border border-relay-border-light/40 rounded-lg text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:border-relay-accent/40 focus:ring-1 focus:ring-relay-accent/20 transition-all"
            />
            {searchQuery && (
              <button onClick={() => handleSearchChange('')} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-relay-surface text-relay-text-muted hover:text-relay-text-primary transition-colors">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Search results overlay */}
        {searchQuery && (
          <div className="flex-1 overflow-y-auto">
            {searchLoading ? (
              <div className="flex items-center justify-center py-8 text-xs text-relay-text-muted gap-2">
                <div className="w-3 h-3 border border-relay-accent/40 border-t-relay-accent rounded-full animate-spin" />
                Searching…
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center px-4">
                <Search className="w-8 h-8 text-relay-text-muted/40 mb-2" />
                <p className="text-xs text-relay-text-muted">No messages found for &quot;{searchQuery}&quot;</p>
              </div>
            ) : (
              <div className="space-y-0.5 p-2">
                {searchResults.map((r) => (
                  <button
                    key={r.messageId}
                    onClick={() => { onSelectContact(r.conversationId); handleSearchChange(''); }}
                    className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-relay-surface-hover transition-colors"
                  >
                    <p className="text-xs font-semibold text-relay-text-primary truncate">{r.conversationName || r.conversationId}</p>
                    <p className="text-[11px] text-relay-text-secondary mt-0.5 truncate leading-snug">{r.snippet}</p>
                    <p className="text-[10px] text-relay-text-muted mt-0.5">{new Date(r.timestamp).toLocaleDateString()}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Unified list */}
        {!searchQuery && <div className="flex-1 overflow-y-auto">
          <AnimatePresence mode="popLayout">
            {filteredRows.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center h-full py-16 text-center px-6"
              >
                <>
                  <div className="w-14 h-14 rounded-full bg-relay-accent/10 flex items-center justify-center mb-4">
                    <MessageCircle className="w-7 h-7 text-relay-accent" />
                  </div>
                  <h3 className="text-base font-semibold text-relay-text-primary mb-1">
                    {activeFolder.id === ALL_FOLDER_ID ? 'Start a conversation' : 'No chats in this folder'}
                  </h3>
                  <p className="text-sm text-relay-text-muted mb-5">
                    {activeFolder.id === ALL_FOLDER_ID
                      ? 'Add a contact or create a group to begin.'
                      : 'Adjust this folder or pick another.'}
                  </p>
                  {activeFolder.id === ALL_FOLDER_ID && (
                    <motion.button
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={onNewContact}
                      className="px-5 py-2.5 rounded-relay-sm bg-relay-accent text-relay-accent-foreground text-sm font-medium hover:bg-relay-accent/90 transition-colors flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      New conversation
                    </motion.button>
                  )}
                </>
              </motion.div>
            ) : (
              <div className="space-y-0.5 p-2">
                {filteredRows.map((row, idx) => {
                  const folderColor = rowFolderColor(row);
                  if (row.kind === 'dm') {
                    const contact = row.contact;
                    const unreadCount = row.unread;
                    const isSelected = selectedContactId === contact.id;
                    const online = !!contact.isOnline;
                    const archived = isArchived(contact);
                    const menuOpen = contextMenuId === contact.id;
                    return (
                      <motion.div
                        key={`dm-${contact.id}`}
                        layoutId={`contact-${contact.id}`}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={{ duration: 0.15, delay: idx * 0.015 }}
                        className="relative"
                      >
                        {folderColor && (
                          <span
                            aria-hidden
                            className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
                            style={{ backgroundColor: folderColor }}
                          />
                        )}
                        <button
                          onClick={() => onSelectContact(contact.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setContextMenuId(menuOpen ? null : contact.id);
                          }}
                          aria-current={isSelected ? 'true' : undefined}
                          className={`w-full px-3 py-2.5 rounded-relay-sm text-left transition-colors ${
                            isSelected ? 'bg-relay-surface-hover' : 'hover:bg-relay-surface-hover'
                          } ${archived ? 'opacity-60' : ''}`}
                        >
                          <div className="flex items-start gap-3">
                            <motion.div animate={isSelected ? { scale: 1.05 } : { scale: 1 }}>
                              <UserAvatar
                                emoji={contact.avatarEmoji}
                                color={contact.avatarColor}
                                size={40}
                                online={online}
                                selected={isSelected}
                              />
                            </motion.div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline justify-between gap-2 mb-1">
                                <p className={`text-sm font-medium truncate flex items-center gap-1.5 ${archived ? 'text-relay-text-muted italic' : 'text-relay-text-primary'}`}>
                                  {row.pinned && (
                                    <>
                                      <Pin className="w-3 h-3 text-relay-accent flex-shrink-0" aria-hidden />
                                      <span className="sr-only">Pinned</span>
                                    </>
                                  )}
                                  <span className="truncate">{contact.name}</span>
                                </p>
                                <span className="text-xs text-relay-text-muted flex-shrink-0">
                                  {formatTime(row.sortKey)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs text-relay-text-muted line-clamp-1">{dmPreview(contact)}</p>
                                {unreadCount > 0 && (
                                  <motion.div
                                    initial={{ scale: 0.8, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    className="flex-shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-relay-accent flex items-center justify-center"
                                  >
                                    <span className="text-[10px] font-semibold tabular-nums text-white">
                                      {unreadCount}
                                    </span>
                                  </motion.div>
                                )}
                              </div>
                            </div>
                          </div>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setContextMenuId(menuOpen ? null : contact.id);
                          }}
                          className="absolute top-2 right-2 p-1 rounded hover:bg-relay-surface text-relay-text-muted hover:text-relay-text-primary opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          title="More options"
                          aria-label="Contact options"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                        {menuOpen && (
                          <div
                            role="menu"
                            className="absolute z-30 right-2 top-9 w-44 bg-relay-surface border border-relay-border rounded-relay-sm shadow-lg overflow-hidden"
                            onMouseLeave={() => setContextMenuId(null)}
                          >
                            <button
                              role="menuitem"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePinned(contact.relayId || contact.id);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-relay-text-primary hover:bg-relay-surface-hover text-left"
                            >
                              {row.pinned ? (
                                <>
                                  <PinOff className="w-4 h-4 text-relay-text-secondary" />
                                  Unpin
                                </>
                              ) : (
                                <>
                                  <Pin className="w-4 h-4 text-relay-accent" />
                                  Pin
                                </>
                              )}
                            </button>
                            <button
                              role="menuitem"
                              onClick={(e) => {
                                e.stopPropagation();
                                void toggleArchive(contact);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-relay-text-primary hover:bg-relay-surface-hover text-left"
                            >
                              {archived ? (
                                <>
                                  <ArchiveRestore className="w-4 h-4 text-relay-accent" />
                                  Unarchive
                                </>
                              ) : (
                                <>
                                  <Archive className="w-4 h-4 text-relay-text-secondary" />
                                  Archive
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </motion.div>
                    );
                  }

                  // Group row
                  const g = row.group;
                  const isSelected = selectedGroupId === g.id;
                  const unread = row.unread;
                  return (
                    <motion.div
                      key={`g-${g.id}`}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.15, delay: idx * 0.015 }}
                      className="relative"
                    >
                      {folderColor && (
                        <span
                          aria-hidden
                          className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
                          style={{ backgroundColor: folderColor }}
                        />
                      )}
                      <button
                        onClick={() => onSelectGroup?.(g.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (onManageGroup) onManageGroup(g.id);
                        }}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`w-full px-3 py-2.5 rounded-relay-sm text-left transition-colors ${
                          isSelected ? 'bg-relay-surface-hover' : 'hover:bg-relay-surface-hover'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="relative">
                            <div
                              className={`w-[40px] h-[40px] rounded-full flex items-center justify-center text-sm font-semibold ${
                                isSelected ? 'bg-relay-accent/20 text-relay-accent' : 'bg-relay-surface-hover text-relay-text-secondary'
                              }`}
                            >
                              {getGroupInitials(g.name)}
                            </div>
                            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-relay-surface flex items-center justify-center">
                              <Users className="w-2.5 h-2.5 text-relay-text-muted" />
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline justify-between gap-2 mb-1">
                              <p className="text-sm font-medium truncate text-relay-text-primary">{g.name}</p>
                              <span className="text-xs text-relay-text-muted flex-shrink-0">
                                {formatTime(row.sortKey)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs text-relay-text-muted line-clamp-1">{groupPreview(g)}</p>
                              {unread > 0 && (
                                <motion.div
                                  initial={{ scale: 0.8, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1 }}
                                  className="flex-shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-relay-accent flex items-center justify-center"
                                >
                                  <span className="text-[10px] font-semibold tabular-nums text-white">
                                    {unread}
                                  </span>
                                </motion.div>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </AnimatePresence>
        </div>}
      </div>

      {/* Folder create/edit modal */}
      <FolderEditModal
        isOpen={folderModalOpen}
        folder={folderBeingEdited}
        contacts={contacts}
        groups={groups}
        onClose={() => setFolderModalOpen(false)}
        onSaved={handleFoldersChanged}
      />

      {/* Profile viewer modal */}
      <AnimatePresence>
        {selectedProfile && (
          <ContactProfileViewer
            relayId={selectedProfile.relayId}
            displayName={selectedProfile.displayName}
            publicKeyHex={selectedProfile.publicKeyHex}
            isOpen={profileOpen}
            onClose={() => {
              setProfileOpen(false);
              setSelectedProfile(null);
            }}
            isBlocked={!!contacts.find((c) => (c.relayId || c.id) === selectedProfile.relayId)?.blocked}
            onBlock={handleBlock}
            onUnblock={handleUnblock}
          />
        )}
      </AnimatePresence>
    </>
  );
});
