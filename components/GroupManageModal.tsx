'use client';

/**
 * GroupManageModal — tabbed info/members/settings.
 * Backward-compatible prop signature (unchanged).
 */

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Search, MoreVertical, Shield, ShieldOff, UserMinus, Crown, LogOut,
  Bell, BellOff, Pin, PinOff, Download, Check, Info, Users as UsersIcon, Settings as SettingsIcon, Plus, Users, Link,
} from 'lucide-react';
import type { Contact } from '@/lib/mock-data';
import type { GroupConversation } from '@/lib/hooks/messaging-types';
import { getGroupInitials } from '@/lib/messaging/group-display';
import { isPinned, setPinned, isMuted, setMuted } from '@/lib/features/chat-folders';
import { UserAvatar } from './UserAvatar';
import { getAccountProfile } from '@/lib/auth/account-manager';
import { exportConversationAsText, triggerDownload } from '@/lib/export/chat-export';
import { isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';

interface GroupManageModalProps {
  isOpen: boolean;
  group: GroupConversation | null;
  contacts: Contact[];
  currentUserId: string;
  onClose: () => void;
  onRename: (groupId: string, name: string) => Promise<void>;
  onSetDisappearingMessages: (groupId: string, seconds: number) => Promise<void>;
  onAddMembers: (groupId: string, memberIds: string[]) => Promise<void>;
  onRemoveMember: (groupId: string, memberId: string) => Promise<void>;
  onSetAdmin: (groupId: string, memberId: string, isAdmin: boolean) => Promise<void>;
  onTransferOwnership: (groupId: string, newOwnerId: string) => Promise<void>;
  onLeave: (groupId: string) => Promise<void>;
}

type Tab = 'info' | 'members' | 'settings';

const DISAPPEAR_OPTIONS: Array<{ label: string; value: number }> = [
  { label: 'Off', value: 0 },
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 7 * 86400 },
  { label: '30 days', value: 30 * 86400 },
];

export function GroupManageModal({
  isOpen, group, contacts, currentUserId,
  onClose, onRename, onSetDisappearingMessages, onAddMembers, onRemoveMember, onSetAdmin, onTransferOwnership, onLeave,
}: GroupManageModalProps) {
  const [tab, setTab] = useState<Tab>('info');
  const [name, setName] = useState(group?.name || '');
  const [memberQuery, setMemberQuery] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());
  const [addSearch, setAddSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pinned, setPinnedState] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [pendingJoins, setPendingJoins] = useState<{ pendingMembers: string[]; pendingRequests: string[] } | null>(null);
  const [pendingJoinsLoading, setPendingJoinsLoading] = useState(false);
  const [resolvingJoinId, setResolvingJoinId] = useState<string | null>(null);

  useEffect(() => {
    if (group) {
      setName(group.name);
      setPinnedState(isPinned(group.id));
      setMutedState(isMuted(group.id));
    }
    setTab('info');
    setOpenMenuId(null);
    setShowAddPicker(false);
    setSelectedToAdd(new Set());
    setAddSearch('');
    setMemberQuery('');
    setError(null);
  }, [group?.id, isOpen]);

  // Close on Escape, matching every other modal in the app (this one was
  // missing it, along with the role="dialog"/aria-modal semantics below).
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

  const canManage = !!group && (group.ownerId === currentUserId || group.adminIds.includes(currentUserId));
  const isOwner = !!group && group.ownerId === currentUserId;
  const showJoinRequests = !!group && isOwner && group.visibility === 'public';

  // Join requests are server-side discovery metadata (see public-groups-db.ts),
  // not part of the group's own E2E state — fetched on demand rather than
  // threaded through the whole messaging hook chain like memberIds is.
  // Only the owner can see or act on these (enforced server-side too).
  useEffect(() => {
    if (!isOpen || !group || !showJoinRequests || tab !== 'members') {
      setPendingJoins(null);
      return;
    }
    let cancelled = false;
    setPendingJoinsLoading(true);
    fetch(`/api/groups/pending?groupId=${encodeURIComponent(group.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled) setPendingJoins(data); })
      .catch(() => { if (!cancelled) setPendingJoins(null); })
      .finally(() => { if (!cancelled) setPendingJoinsLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, group?.id, showJoinRequests, tab]);

  const resolveJoin = async (relayId: string, approve: boolean) => {
    if (!group) return;
    setResolvingJoinId(relayId);
    setError(null);
    try {
      // Grant membership BEFORE telling the server this join request is
      // resolved — previously this ran in the opposite order, so a
      // failure in onAddMembers (network, crypto) after the server had
      // already removed the request from the pending queue left the
      // requester silently approved-but-never-added, with no way to
      // retry (the request no longer existed to re-approve). addGroupMembers
      // is idempotent (no-ops if already a member), so retrying resolveJoin
      // after a later failure below is always safe.
      if (approve) {
        await onAddMembers(group.id, [relayId]);
      }
      const res = await fetch('/api/groups/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: group.id, relayId }),
      });
      if (!res.ok) throw new Error('Failed to resolve join request');
      const data = await res.json();
      setPendingJoins({ pendingMembers: data.pendingMembers || [], pendingRequests: data.pendingRequests || [] });
      if (approve) showToast('Added to group');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve join request');
    } finally {
      setResolvingJoinId(null);
    }
  };

  const memberLabel = (id: string) => {
    if (id === currentUserId) return 'You';
    const contact = contacts.find((c) => (c.relayId || c.id) === id);
    return contact?.displayName || contact?.name || id;
  };

  const visibleMembers = useMemo(() => {
    if (!group) return [];
    const q = memberQuery.trim().toLowerCase();
    if (!q) return group.memberIds;
    return group.memberIds.filter((id) => memberLabel(id).toLowerCase().includes(q) || id.toLowerCase().includes(q));
  }, [group, memberQuery, contacts, currentUserId]);

  const addableContacts = useMemo(() => {
    if (!group) return [];
    const q = addSearch.trim().toLowerCase();
    // Ephemeral/ghost contacts are explicitly designed to "never touch
    // disk" — adding one to a group would persist their relayId to
    // localStorage (group roster) and expose it to every other real
    // member via governance-event fan-out, defeating that guarantee.
    return contacts
      .filter((c) => !isEphemeralContact(c.relayId || c.id))
      .map((c) => ({ id: c.relayId || c.id, name: c.displayName || c.name }))
      .filter((c) => !group.memberIds.includes(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [contacts, group, addSearch]);

  if (!isOpen || !group) return null;

  const run = async (fn: () => Promise<void>) => {
    try { setBusy(true); setError(null); await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Action failed'); }
    finally { setBusy(false); }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  const roleOf = (id: string): 'owner' | 'admin' | 'member' =>
    id === group.ownerId ? 'owner' : group.adminIds.includes(id) ? 'admin' : 'member';

  const roleBadge = (role: 'owner' | 'admin' | 'member') => {
    if (role === 'owner') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium">Owner</span>;
    if (role === 'admin') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium">Admin</span>;
    return null;
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.15 }}
          className="relay-panel w-full max-w-[620px] h-full sm:h-auto sm:max-h-[85vh] sm:rounded-xl flex flex-col"
          style={{ maxHeight: '85vh' }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="group-manage-title"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-relay-border">
            <h3 id="group-manage-title" className="text-sm font-semibold text-relay-text-primary">Group info</h3>
            <button onClick={onClose} className="relay-icon-btn" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs (underline-active-state) */}
          <div className="flex gap-0.5 px-5 border-b border-relay-border">
            {([
              { id: 'info', label: 'Info', Icon: Info },
              { id: 'members', label: 'Members', Icon: UsersIcon },
              { id: 'settings', label: 'Settings', Icon: SettingsIcon },
            ] as const).map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative px-3 py-2 text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  tab === id ? 'text-relay-accent' : 'text-relay-text-secondary hover:text-relay-text-primary'
                }`}
              >
                <Icon className="w-3.5 h-3.5" /> {label}
                {tab === id && (
                  <motion.div
                    layoutId="groupmanage-underline"
                    className="absolute left-0 right-0 bottom-0 h-0.5 bg-relay-accent"
                  />
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {tab === 'info' && (
              <div className="space-y-5">
                <div className="flex flex-col items-center text-center">
                  <div
                    className="w-20 h-20 rounded-full flex items-center justify-center text-3xl"
                    style={{ backgroundColor: 'var(--relay-surface-hover, #2a2a2a)' }}
                  >
                    {getGroupInitials(group.name)}
                  </div>
                  <div className="mt-3 w-full max-w-xs">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value.slice(0, 40))}
                      disabled={!canManage}
                      className="relay-input w-full text-center text-sm disabled:opacity-70"
                    />
                    {canManage && name.trim() && name.trim() !== group.name && (
                      <button
                        disabled={busy}
                        onClick={() => run(() => onRename(group.id, name.trim()))}
                        className="relay-btn-primary text-xs px-3 py-1.5 mt-2"
                      >
                        Save name
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-relay-text-muted mt-2">{group.memberIds.length} members</p>
                </div>

                <div>
                  <p className="relay-section-label mb-1.5">Created</p>
                  <p className="text-xs text-relay-text-secondary">
                    {new Date(group.createdAt).toLocaleString()}
                  </p>
                </div>

                <div>
                  <p className="relay-section-label mb-1.5">Disappearing messages</p>
                  <div className="flex flex-wrap gap-1.5">
                    {DISAPPEAR_OPTIONS.map((opt) => {
                      const active = (group.disappearAfter || 0) === opt.value;
                      return (
                        <button
                          key={opt.value}
                          disabled={!canManage || busy}
                          className={`px-2.5 py-1 text-xs rounded-md disabled:opacity-50 ${
                            active
                              ? 'bg-relay-accent/15 text-relay-accent font-medium'
                              : 'bg-relay-surface-hover/60 text-relay-text-secondary hover:text-relay-text-primary hover:bg-relay-surface-hover'
                          }`}
                          onClick={() => run(() => onSetDisappearingMessages(group.id, opt.value))}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  {!canManage && (
                    <p className="text-[11px] text-relay-text-muted mt-1.5">Only the group owner or an admin can change this.</p>
                  )}
                </div>
              </div>
            )}

            {tab === 'members' && (
              <div className="space-y-3">
                {showJoinRequests && (pendingJoinsLoading || (pendingJoins && (pendingJoins.pendingMembers.length + pendingJoins.pendingRequests.length > 0))) && (
                  <div className="rounded-lg border border-relay-border bg-relay-surface-hover/40 p-3 space-y-2">
                    <p className="relay-section-label">Join requests</p>
                    {pendingJoinsLoading && !pendingJoins && (
                      <p className="text-xs text-relay-text-muted">Loading…</p>
                    )}
                    {pendingJoins?.pendingRequests.map((id) => (
                      <div key={`req-${id}`} className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-relay-text-primary truncate">{memberLabel(id)}</p>
                          <p className="text-[11px] text-relay-text-muted truncate">Requested to join</p>
                        </div>
                        <button
                          disabled={resolvingJoinId === id}
                          onClick={() => resolveJoin(id, true)}
                          className="relay-btn-primary text-xs px-2.5 py-1"
                        >
                          Approve
                        </button>
                        <button
                          disabled={resolvingJoinId === id}
                          onClick={() => resolveJoin(id, false)}
                          className="text-xs px-2.5 py-1 rounded-md text-relay-text-secondary hover:bg-relay-surface-hover"
                        >
                          Deny
                        </button>
                      </div>
                    ))}
                    {pendingJoins?.pendingMembers.map((id) => (
                      <div key={`open-${id}`} className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-relay-text-primary truncate">{memberLabel(id)}</p>
                          <p className="text-[11px] text-relay-text-muted truncate">Joined via open link — not yet added</p>
                        </div>
                        <button
                          disabled={resolvingJoinId === id}
                          onClick={() => resolveJoin(id, true)}
                          className="relay-btn-primary text-xs px-2.5 py-1"
                        >
                          Add
                        </button>
                        <button
                          disabled={resolvingJoinId === id}
                          onClick={() => resolveJoin(id, false)}
                          className="text-xs px-2.5 py-1 rounded-md text-relay-text-secondary hover:bg-relay-surface-hover"
                        >
                          Dismiss
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-relay-text-muted" />
                    <input
                      value={memberQuery}
                      onChange={(e) => setMemberQuery(e.target.value)}
                      placeholder="Search members…"
                      className="relay-input w-full pl-8"
                    />
                  </div>
                  {canManage && (
                    <button
                      onClick={() => setShowAddPicker(true)}
                      className="relay-btn-primary text-xs px-2.5 py-1.5 flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add
                    </button>
                  )}
                </div>

                <div className="space-y-0.5">
                  {visibleMembers.map((id, i) => {
                    const role = roleOf(id);
                    return (
                      <motion.div
                        key={id}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.15, delay: i * 0.015 }}
                        className="flex items-center gap-3 px-2.5 py-2 rounded-md hover:bg-relay-surface-hover/60 relative"
                      >
                        {(() => {
                          const contact = contacts.find((c) => (c.relayId || c.id) === id);
                          const profile = getAccountProfile(id);
                          const emoji = contact?.avatarEmoji || profile?.avatarEmoji;
                          const color = contact?.avatarColor || profile?.avatarColor;
                          if (emoji && color) {
                            return <UserAvatar emoji={emoji} color={color} size={32} />;
                          }
                          return (
                            <div className="w-8 h-8 rounded-full bg-relay-surface-hover flex items-center justify-center text-xs font-semibold text-relay-text-secondary shrink-0">
                              {memberLabel(id).slice(0, 1).toUpperCase()}
                            </div>
                          );
                        })()}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm text-relay-text-primary truncate">{memberLabel(id)}</p>
                            {roleBadge(role)}
                          </div>
                          <p className="text-[11px] text-relay-text-muted truncate">{id}</p>
                        </div>
                        {canManage && id !== currentUserId && (
                          <div className="relative">
                            <button
                              onClick={() => setOpenMenuId(openMenuId === id ? null : id)}
                              className="relay-icon-btn"
                              aria-label="Member actions"
                            >
                              <MoreVertical className="w-3.5 h-3.5" />
                            </button>
                            {openMenuId === id && (
                              <div
                                className="absolute right-0 top-full mt-1 min-w-[180px] rounded-lg bg-relay-surface border border-relay-border shadow-lg py-1 z-10"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {isOwner && role !== 'owner' && (
                                  <button
                                    disabled={busy}
                                    onClick={() => {
                                      const nextIsAdmin = role !== 'admin';
                                      setOpenMenuId(null);
                                      run(() => onSetAdmin(group.id, id, nextIsAdmin));
                                    }}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-relay-text-primary hover:bg-relay-surface-hover text-left"
                                  >
                                    {role === 'admin' ? (<><ShieldOff className="w-3 h-3" /> Remove admin</>) : (<><Shield className="w-3 h-3" /> Make admin</>)}
                                  </button>
                                )}
                                {isOwner && (
                                  <button
                                    disabled={busy}
                                    onClick={() => {
                                      setOpenMenuId(null);
                                      if (!window.confirm(`Transfer ownership to ${memberLabel(id)}?`)) return;
                                      run(() => onTransferOwnership(group.id, id));
                                    }}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-relay-text-primary hover:bg-relay-surface-hover text-left"
                                  >
                                    <Crown className="w-3 h-3" /> Transfer ownership
                                  </button>
                                )}
                                <button
                                  disabled={busy}
                                  onClick={() => {
                                    setOpenMenuId(null);
                                    if (!window.confirm(`Remove ${memberLabel(id)} from this group?`)) return;
                                    run(() => onRemoveMember(group.id, id));
                                  }}
                                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 text-left"
                                >
                                  <UserMinus className="w-3 h-3" /> Remove from group
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </motion.div>
                    );
                  })}
                </div>

                {/* Add picker sheet */}
                {showAddPicker && (
                  <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={() => setShowAddPicker(false)}>
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="relay-panel w-full max-w-sm rounded-xl overflow-hidden flex flex-col max-h-[70vh]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between px-4 py-3 border-b border-relay-border">
                        <h4 className="text-sm font-semibold text-relay-text-primary">Add members</h4>
                        <button onClick={() => setShowAddPicker(false)} className="relay-icon-btn"><X className="w-4 h-4" /></button>
                      </div>
                      <div className="p-3">
                        <input
                          value={addSearch}
                          onChange={(e) => setAddSearch(e.target.value)}
                          placeholder="Search contacts…"
                          className="relay-input w-full"
                          autoFocus
                        />
                      </div>
                      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
                        {addableContacts.length === 0 ? (
                          <p className="text-xs text-relay-text-muted text-center py-6">All contacts already in this group.</p>
                        ) : addableContacts.map((c) => {
                          const checked = selectedToAdd.has(c.id);
                          return (
                            <label key={c.id} className="flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer hover:bg-relay-surface-hover/60">
                              <div className={`w-4 h-4 rounded border flex items-center justify-center ${checked ? 'bg-relay-accent border-relay-accent text-relay-accent-foreground' : 'border-relay-border'}`}>
                                {checked && <Check className="w-3 h-3" />}
                              </div>
                              <input type="checkbox" className="sr-only" checked={checked} onChange={() => {
                                const next = new Set(selectedToAdd);
                                if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                                setSelectedToAdd(next);
                              }} />
                              <span className="text-sm text-relay-text-primary truncate">{c.name}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-relay-border">
                        <button className="relay-btn-secondary text-xs px-3 py-1.5" onClick={() => setShowAddPicker(false)}>Cancel</button>
                        <button
                          disabled={selectedToAdd.size === 0 || busy}
                          onClick={() => run(async () => {
                            await onAddMembers(group.id, Array.from(selectedToAdd));
                            setSelectedToAdd(new Set());
                            setShowAddPicker(false);
                          })}
                          className="relay-btn-primary text-xs px-3 py-1.5 disabled:opacity-40"
                        >
                          Add {selectedToAdd.size > 0 ? `(${selectedToAdd.size})` : ''}
                        </button>
                      </div>
                    </motion.div>
                  </div>
                )}
              </div>
            )}

            {tab === 'settings' && (
              <div className="space-y-1">
                {canManage && (
                  <GroupVisibilityEditor
                    groupId={group.id}
                    groupName={group.name}
                    description={group.description}
                    avatarEmoji={group.avatarEmoji}
                    avatarColor={group.avatarColor}
                    memberCount={group.memberIds.length}
                    ownerRelayId={group.ownerId}
                    initialVisibility={group.visibility || 'private'}
                    initialHandle={group.publicHandle}
                    initialPolicy={group.joinPolicy || 'open'}
                    onToast={showToast}
                  />
                )}
                {group.visibility === 'public' && group.publicHandle && (
                  <div className="flex items-center gap-3 px-2.5 py-2.5 rounded-md">
                    <Link className="w-4 h-4 text-relay-text-secondary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-relay-text-primary">Invite link</p>
                      <p className="text-[11px] text-relay-text-muted truncate">
                        {typeof window !== 'undefined' ? `${window.location.origin}/join/@${group.publicHandle}` : `/join/@${group.publicHandle}`}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        const link = `${window.location.origin}/join/@${group.publicHandle}`;
                        navigator.clipboard.writeText(link).then(() => showToast('Link copied'));
                      }}
                      className="flex-shrink-0 p-1.5 rounded-md bg-relay-surface-hover hover:bg-relay-accent/20 text-relay-text-secondary hover:text-relay-accent transition-colors"
                      title="Copy invite link"
                    >
                      <Check className="w-3.5 h-3.5 hidden" />
                      <Link className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                <SettingsRow
                  Icon={muted ? BellOff : Bell}
                  label="Mute notifications"
                  hint="You won't be notified about new messages."
                  value={muted}
                  onToggle={() => { setMuted(group.id, !muted); setMutedState(!muted); }}
                />
                <SettingsRow
                  Icon={pinned ? Pin : PinOff}
                  label="Pin to top"
                  hint="Keep this group at the top of your chat list."
                  value={pinned}
                  onToggle={() => { setPinned(group.id, !pinned); setPinnedState(!pinned); }}
                />
                <button
                  onClick={async () => {
                    try {
                      const blob = await exportConversationAsText(group.id, group.name);
                      triggerDownload(
                        blob,
                        `${group.name.replace(/[^\w.-]+/g, '_')}-${Date.now()}.txt`
                      );
                      showToast('Export downloaded');
                    } catch (e) {
                      showToast('Export failed');
                    }
                  }}
                  className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-md hover:bg-relay-surface-hover/60 text-left"
                >
                  <Download className="w-4 h-4 text-relay-text-secondary" />
                  <div className="flex-1">
                    <p className="text-sm text-relay-text-primary">Export chat</p>
                    <p className="text-[11px] text-relay-text-muted">Download group history.</p>
                  </div>
                </button>
                <div className="pt-3 mt-3 border-t border-relay-border">
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Leave "${group.name}"? You'll need to be re-added to rejoin.`)) return;
                      run(async () => { await onLeave(group.id); onClose(); });
                    }}
                    className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-md hover:bg-rose-500/10 text-left text-rose-500 dark:text-rose-400"
                  >
                    <LogOut className="w-4 h-4" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">Leave group</p>
                      <p className="text-[11px] opacity-80">You will no longer receive messages.</p>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {error && <p className="text-xs text-rose-500 dark:text-rose-400 mt-3">{error}</p>}
          </div>

          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-relay-surface border border-relay-border px-3 py-1.5 rounded-md text-xs text-relay-text-primary shadow-lg"
            >
              {toast}
            </motion.div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function SettingsRow({
  Icon, label, hint, value, onToggle,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-md hover:bg-relay-surface-hover/60 text-left"
    >
      <Icon className="w-4 h-4 text-relay-text-secondary shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-relay-text-primary">{label}</p>
        <p className="text-[11px] text-relay-text-muted">{hint}</p>
      </div>
      <div className={`w-8 h-4 rounded-full transition-colors ${value ? 'bg-relay-accent' : 'bg-relay-border'} relative shrink-0`}>
        <div
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${value ? 'left-4' : 'left-0.5'}`}
        />
      </div>
    </button>
  );
}

void Users; // silence unused

function GroupVisibilityEditor(props: {
  groupId: string;
  groupName: string;
  description?: string;
  avatarEmoji?: string;
  avatarColor?: string;
  memberCount: number;
  ownerRelayId: string;
  initialVisibility: 'public' | 'private';
  initialHandle?: string;
  initialPolicy: 'open' | 'request';
  onToast: (m: string) => void;
}) {
  const [visibility, setVisibility] = useState<'public' | 'private'>(props.initialVisibility);
  const [handle, setHandle] = useState(props.initialHandle || '');
  const [policy, setPolicy] = useState<'open' | 'request'>(props.initialPolicy);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (visibility === 'public') {
        const h = handle.trim().replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9_\-]{3,32}$/.test(h)) {
          setErr('Handle must be 3-32 chars (a-z, 0-9, _ or -)');
          return;
        }
        const res = await fetch('/api/groups/directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            groupId: props.groupId,
            publicHandle: h,
            name: props.groupName,
            description: props.description,
            avatarEmoji: props.avatarEmoji,
            avatarColor: props.avatarColor,
            memberCount: props.memberCount,
            ownerRelayId: props.ownerRelayId,
            joinPolicy: policy,
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error?.message || 'Failed to publish group');
        }
        props.onToast('Group is now public');
      } else {
        await fetch('/api/groups/leave-directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupId: props.groupId }),
        });
        props.onToast('Group is now private');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-2.5 py-2.5 space-y-2 border border-relay-border rounded-md mb-2">
      <p className="text-sm text-relay-text-primary font-medium">Visibility</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setVisibility('private')}
          className={`rounded-md border px-2 py-1.5 text-[11px] ${visibility === 'private' ? 'border-relay-accent text-relay-text-primary' : 'border-relay-border text-relay-text-secondary'}`}
        >Private</button>
        <button
          type="button"
          onClick={() => setVisibility('public')}
          className={`rounded-md border px-2 py-1.5 text-[11px] ${visibility === 'public' ? 'border-relay-accent text-relay-text-primary' : 'border-relay-border text-relay-text-secondary'}`}
        >Public</button>
      </div>
      {visibility === 'public' && (
        <div className="space-y-2">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-relay-text-muted text-sm">@</span>
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value.replace(/^@/, '').slice(0, 32))}
              placeholder="yourgroup"
              className="relay-input w-full pl-6 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPolicy('open')}
              className={`rounded-md border px-2 py-1.5 text-[11px] ${policy === 'open' ? 'border-relay-accent text-relay-text-primary' : 'border-relay-border text-relay-text-secondary'}`}
            >Open</button>
            <button
              type="button"
              onClick={() => setPolicy('request')}
              className={`rounded-md border px-2 py-1.5 text-[11px] ${policy === 'request' ? 'border-relay-accent text-relay-text-primary' : 'border-relay-border text-relay-text-secondary'}`}
            >Request</button>
          </div>
        </div>
      )}
      <button
        onClick={save}
        disabled={busy}
        className="relay-btn-primary text-xs px-3 py-1.5 w-full disabled:opacity-40"
      >{busy ? 'Saving…' : 'Save visibility'}</button>
      {err && <p className="text-[11px] text-rose-500">{err}</p>}
    </div>
  );
}
