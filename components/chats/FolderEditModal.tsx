'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, ChevronDown, ChevronRight, Palette } from 'lucide-react';
import { useRef } from 'react';
import {
  type ChatFolder,
  createFolder,
  updateFolder,
  deleteFolder,
  FOLDER_TEMPLATES,
} from '@/lib/features/chat-folders';
import { FOLDER_ICON_OPTIONS as ICON_OPTIONS } from '@/components/chats/folder-icons';
import type { Contact } from '@/lib/mock-data';
import type { GroupConversation } from '@/lib/hooks/messaging-types';

const FOLDER_COLOR_PALETTE = [
  '#e11d1d', '#f97316', '#f59e0b', '#22c55e', '#10b981',
  '#0ea5e9', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b',
];

// A screen reader announcing raw hex ("pound e one one d one d") is
// meaningless — human-readable names for the same fixed palette above.
const FOLDER_COLOR_NAMES: Record<string, string> = {
  '#e11d1d': 'Red',
  '#f97316': 'Orange',
  '#f59e0b': 'Amber',
  '#22c55e': 'Green',
  '#10b981': 'Emerald',
  '#0ea5e9': 'Sky blue',
  '#3b82f6': 'Blue',
  '#8b5cf6': 'Violet',
  '#ec4899': 'Pink',
  '#64748b': 'Slate',
};

interface FolderEditModalProps {
  isOpen: boolean;
  folder: ChatFolder | null; // null => create mode
  contacts: Contact[];
  groups: GroupConversation[];
  onClose: () => void;
  onSaved: () => void;
}

export function FolderEditModal({ isOpen, folder, contacts, groups, onClose, onSaved }: FolderEditModalProps) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>('Inbox');
  const [color, setColor] = useState<string | undefined>(undefined);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [includeDm, setIncludeDm] = useState(false);
  const [includeGroup, setIncludeGroup] = useState(false);
  const [includeUnread, setIncludeUnread] = useState(false);
  const [includePinned, setIncludePinned] = useState(false);
  const [contactIds, setContactIds] = useState<Set<string>>(new Set());
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [excludeMuted, setExcludeMuted] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    if (folder) {
      setName(folder.name);
      setIcon(folder.icon || 'Inbox');
      setColor(folder.color);
      setIncludeDm(!!folder.include.types?.includes('dm'));
      setIncludeGroup(!!folder.include.types?.includes('group'));
      setIncludeUnread(!!folder.include.unread);
      setIncludePinned(!!folder.include.pinned);
      setContactIds(new Set(folder.include.contactIds ?? []));
      setGroupIds(new Set(folder.include.groupIds ?? []));
      setExcludeMuted(!!folder.exclude?.muted);
    } else {
      setName('');
      setIcon('Inbox');
      setColor(undefined);
      setIncludeDm(false);
      setIncludeGroup(false);
      setIncludeUnread(false);
      setIncludePinned(false);
      setContactIds(new Set());
      setGroupIds(new Set());
      setExcludeMuted(false);
    }
    setShowAdvanced(false);
    setSearch('');
  }, [isOpen, folder]);

  // Escape closes the modal; Tab/Shift+Tab are trapped inside the dialog
  // so focus can't leak into the page behind it (same pattern as
  // AddContactModal.tsx).
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

  if (!isOpen) return null;

  const applyTemplate = (tpl: (typeof FOLDER_TEMPLATES)[number]) => {
    setName(tpl.name);
    setIcon(tpl.icon);
    setIncludeDm(!!tpl.include.types?.includes('dm'));
    setIncludeGroup(!!tpl.include.types?.includes('group'));
    setIncludeUnread(!!tpl.include.unread);
    setIncludePinned(!!tpl.include.pinned);
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const types: Array<'dm' | 'group'> = [];
    if (includeDm) types.push('dm');
    if (includeGroup) types.push('group');

    const payload = {
      name: trimmed,
      icon,
      color,
      include: {
        ...(types.length ? { types } : {}),
        ...(contactIds.size ? { contactIds: Array.from(contactIds) } : {}),
        ...(groupIds.size ? { groupIds: Array.from(groupIds) } : {}),
        ...(includeUnread ? { unread: true } : {}),
        ...(includePinned ? { pinned: true } : {}),
      },
      exclude: excludeMuted ? { muted: true } : undefined,
    };

    if (folder) updateFolder(folder.id, payload);
    else createFolder(payload);
    onSaved();
    onClose();
  };

  const handleDelete = () => {
    if (!folder) return;
    if (!window.confirm(`Delete folder "${folder.name}"?`)) return;
    deleteFolder(folder.id);
    onSaved();
    onClose();
  };

  const filteredContacts = contacts.filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (c.displayName || c.name || '').toLowerCase().includes(q);
  });
  const filteredGroups = groups.filter((g) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return g.name.toLowerCase().includes(q);
  });

  const toggle = (set: Set<string>, id: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

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
          ref={dialogRef}
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.15 }}
          className="relay-panel w-full max-w-lg max-h-[85vh] rounded-xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-edit-title"
        >
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-relay-border">
            <h3 id="folder-edit-title" className="text-sm font-semibold text-relay-text-primary">
              {folder ? 'Edit folder' : 'New folder'}
            </h3>
            <button onClick={onClose} className="relay-icon-btn" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {!folder && (
              <div>
                <p className="relay-section-label mb-2">Quick start</p>
                <div className="flex flex-wrap gap-1.5">
                  {FOLDER_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.name}
                      onClick={() => applyTemplate(tpl)}
                      className="px-2.5 py-1 text-xs rounded-md bg-relay-surface-hover/60 hover:bg-relay-surface-hover text-relay-text-secondary hover:text-relay-text-primary"
                    >
                      {tpl.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="folder-name" className="relay-section-label">Name</label>
              <input
                id="folder-name"
                className="relay-input w-full mt-1.5"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 40))}
                placeholder="e.g. Work"
                autoFocus
              />
            </div>

            <div>
              <label className="relay-section-label">Icon</label>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {ICON_OPTIONS.map(({ name: n, Comp }) => (
                  <button
                    key={n}
                    onClick={() => setIcon(n)}
                    className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
                      icon === n
                        ? 'bg-relay-accent/15 text-relay-accent ring-1 ring-relay-accent/30'
                        : 'bg-relay-surface-hover/60 text-relay-text-secondary hover:text-relay-text-primary'
                    }`}
                    aria-label={n}
                  >
                    <Comp className="w-4 h-4" />
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="relay-section-label flex items-center gap-1">
                <Palette className="w-3 h-3" /> Color
              </label>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setColor(undefined)}
                  className={`w-7 h-7 rounded-full bg-relay-accent transition-transform ${
                    !color ? 'ring-2 ring-offset-2 ring-relay-accent ring-offset-relay-surface' : ''
                  }`}
                  title="Use theme accent"
                  aria-label="Use theme accent"
                />
                {FOLDER_COLOR_PALETTE.map((c) => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-7 h-7 rounded-full transition-transform ${
                      color === c ? 'ring-2 ring-offset-2 ring-relay-accent ring-offset-relay-surface' : ''
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={FOLDER_COLOR_NAMES[c] || c}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => colorInputRef.current?.click()}
                  className="w-7 h-7 rounded-full border border-dashed border-relay-border-light flex items-center justify-center text-relay-text-muted hover:text-relay-text-primary hover:border-relay-accent transition-colors"
                  title="Custom color"
                  aria-label="Pick custom color"
                >
                  <Palette className="w-3.5 h-3.5" />
                </button>
                <input
                  ref={colorInputRef}
                  type="color"
                  value={color || '#e11d1d'}
                  onChange={(e) => setColor(e.target.value)}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                />
                {color && (
                  <span className="font-mono text-[11px] text-relay-text-muted">{color.toUpperCase()}</span>
                )}
              </div>
            </div>

            <div>
              <p className="relay-section-label mb-2">Include</p>
              <div className="space-y-1.5">
                {[
                  { checked: includeDm, onChange: setIncludeDm, label: 'Direct messages' },
                  { checked: includeGroup, onChange: setIncludeGroup, label: 'Groups' },
                  { checked: includeUnread, onChange: setIncludeUnread, label: 'Unread chats' },
                  { checked: includePinned, onChange: setIncludePinned, label: 'Pinned chats' },
                ].map((row) => (
                  <label key={row.label} className="flex items-center gap-2.5 text-xs text-relay-text-primary cursor-pointer py-1">
                    <input
                      type="checkbox"
                      checked={row.checked}
                      onChange={(e) => row.onChange(e.target.checked)}
                      className="accent-relay-accent w-3.5 h-3.5"
                    />
                    {row.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                aria-controls="folder-advanced-section"
                className="flex items-center gap-1 text-xs text-relay-text-secondary hover:text-relay-text-primary"
              >
                {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Advanced
              </button>
              {showAdvanced && (
                <div id="folder-advanced-section" className="mt-3 space-y-4">
                  <label className="flex items-center gap-2.5 text-xs text-relay-text-primary cursor-pointer py-1">
                    <input
                      type="checkbox"
                      checked={excludeMuted}
                      onChange={(e) => setExcludeMuted(e.target.checked)}
                      className="accent-relay-accent w-3.5 h-3.5"
                    />
                    Hide muted chats
                  </label>

                  {(contacts.length > 0 || groups.length > 0) && (
                    <div>
                      <p className="relay-section-label mb-2">Specific chats (optional)</p>
                      <input
                        className="relay-input w-full mb-2"
                        placeholder="Search contacts and groups…"
                        aria-label="Search contacts and groups"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      <div className="max-h-48 overflow-y-auto rounded-md border border-relay-border/60 divide-y divide-relay-border/40">
                        {filteredContacts.map((c) => {
                          const id = c.relayId || c.id;
                          const checked = contactIds.has(id);
                          return (
                            <label key={`c-${id}`} className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-relay-text-primary hover:bg-relay-surface-hover/50 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(contactIds, id, setContactIds)}
                                className="accent-relay-accent w-3.5 h-3.5"
                              />
                              <span className="truncate">{c.displayName || c.name}</span>
                              <span className="ml-auto text-[10px] text-relay-text-muted">DM</span>
                            </label>
                          );
                        })}
                        {filteredGroups.map((g) => {
                          const checked = groupIds.has(g.id);
                          return (
                            <label key={`g-${g.id}`} className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-relay-text-primary hover:bg-relay-surface-hover/50 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(groupIds, g.id, setGroupIds)}
                                className="accent-relay-accent w-3.5 h-3.5"
                              />
                              <span className="truncate">{g.name}</span>
                              <span className="ml-auto text-[10px] text-relay-text-muted">Group</span>
                            </label>
                          );
                        })}
                        {filteredContacts.length + filteredGroups.length === 0 && (
                          <p className="text-xs text-relay-text-muted px-2.5 py-3 text-center">No matches</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between px-5 py-3 border-t border-relay-border">
            <div>
              {folder && (
                <button
                  onClick={handleDelete}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-rose-500 dark:text-rose-400 hover:bg-rose-500/10"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="relay-btn-secondary text-xs px-3 py-1.5">Cancel</button>
              <button
                onClick={save}
                disabled={!name.trim()}
                className="relay-btn-primary text-xs px-3 py-1.5 disabled:opacity-40"
              >
                {folder ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
