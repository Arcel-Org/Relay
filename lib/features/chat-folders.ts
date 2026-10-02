/**
 * Chat Folders (Telegram-style)
 *
 * Lightweight client-side filter groups for the unified chat list.
 * Persisted to localStorage — no server involvement.
 */

import { v4 as uuid } from 'uuid';

export interface ChatFolder {
  id: string;
  name: string;
  /** Lucide icon name (e.g. "Users", "Briefcase") OR a single emoji */
  icon?: string;
  /** Optional custom color (hex). Undefined => use theme accent. */
  color?: string;
  include: {
    contactIds?: string[];
    groupIds?: string[];
    types?: Array<'dm' | 'group'>;
    unread?: boolean;
    pinned?: boolean;
    muted?: boolean;
  };
  exclude?: {
    contactIds?: string[];
    groupIds?: string[];
    muted?: boolean;
  };
  order: number;
  createdAt: number;
}

const FOLDERS_KEY = 'relay:chat-folders';
const PINNED_KEY = 'relay:pinned-chats';
const MUTED_KEY = 'relay:muted-chats';

export const ALL_FOLDER_ID = '__all__';

/** Special sentinel "All" folder — always rendered first, not persisted. */
export const ALL_FOLDER: ChatFolder = {
  id: ALL_FOLDER_ID,
  name: 'All',
  icon: 'Inbox',
  include: {},
  order: -1,
  createdAt: 0,
};

function safeRead<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota */
  }
}

// ─── Folders ────────────────────────────────────────────────────────────

export function getFolders(): ChatFolder[] {
  const list = safeRead<ChatFolder[]>(FOLDERS_KEY, []);
  return [...list].sort((a, b) => a.order - b.order);
}

export function saveFolders(list: ChatFolder[]): void {
  safeWrite(FOLDERS_KEY, list);
}

export function createFolder(
  partial: Partial<Omit<ChatFolder, 'id' | 'createdAt' | 'order'>> & { name: string },
): ChatFolder {
  const existing = getFolders();
  const folder: ChatFolder = {
    id: uuid(),
    name: partial.name,
    icon: partial.icon,
    color: partial.color,
    include: partial.include ?? {},
    exclude: partial.exclude,
    order: existing.length,
    createdAt: Date.now(),
  };
  saveFolders([...existing, folder]);
  return folder;
}

export function updateFolder(id: string, patch: Partial<ChatFolder>): ChatFolder | null {
  const list = getFolders();
  const idx = list.findIndex((f) => f.id === id);
  if (idx === -1) return null;
  const updated: ChatFolder = { ...list[idx], ...patch, id: list[idx].id };
  list[idx] = updated;
  saveFolders(list);
  return updated;
}

export function deleteFolder(id: string): void {
  saveFolders(getFolders().filter((f) => f.id !== id));
}

export function reorderFolders(ids: string[]): void {
  const map = new Map(getFolders().map((f) => [f.id, f]));
  const next: ChatFolder[] = [];
  ids.forEach((id, i) => {
    const f = map.get(id);
    if (f) next.push({ ...f, order: i });
  });
  saveFolders(next);
}

// ─── Pinned / Muted ─────────────────────────────────────────────────────

export function getPinnedMap(): Record<string, number> {
  return safeRead<Record<string, number>>(PINNED_KEY, {});
}

export function getPinnedSet(): Set<string> {
  return new Set(Object.keys(getPinnedMap()));
}

export function setPinned(chatId: string, pinned: boolean): void {
  const map = getPinnedMap();
  if (pinned) map[chatId] = Date.now();
  else delete map[chatId];
  safeWrite(PINNED_KEY, map);
}

export function isPinned(chatId: string): boolean {
  return chatId in getPinnedMap();
}

export function getMutedSet(): Set<string> {
  return new Set(safeRead<string[]>(MUTED_KEY, []));
}

export function setMuted(chatId: string, muted: boolean): void {
  const set = getMutedSet();
  if (muted) set.add(chatId);
  else set.delete(chatId);
  safeWrite(MUTED_KEY, Array.from(set));
}

export function isMuted(chatId: string): boolean {
  return getMutedSet().has(chatId);
}

// ─── Matching ───────────────────────────────────────────────────────────

export interface ChatSummary {
  id: string;
  type: 'dm' | 'group';
  unread: number;
  pinned: boolean;
  muted: boolean;
}

/**
 * Test whether a chat matches a folder's filters.
 * A folder matches when: (any include rule matches) AND (no exclude rule matches).
 * Empty include => match everything (used by "All").
 */
export function matchesFolder(folder: ChatFolder, chat: ChatSummary): boolean {
  const inc = folder.include ?? {};
  const exc = folder.exclude ?? {};

  const hasAnyIncludeRule =
    (inc.contactIds && inc.contactIds.length > 0) ||
    (inc.groupIds && inc.groupIds.length > 0) ||
    (inc.types && inc.types.length > 0) ||
    inc.unread ||
    inc.pinned ||
    inc.muted;

  let included = !hasAnyIncludeRule; // empty include => include everything

  if (hasAnyIncludeRule) {
    if (inc.types?.includes(chat.type)) included = true;
    if (chat.type === 'dm' && inc.contactIds?.includes(chat.id)) included = true;
    if (chat.type === 'group' && inc.groupIds?.includes(chat.id)) included = true;
    if (inc.unread && chat.unread > 0) included = true;
    if (inc.pinned && chat.pinned) included = true;
    if (inc.muted && chat.muted) included = true;
  }

  if (!included) return false;

  if (exc.muted && chat.muted) return false;
  if (chat.type === 'dm' && exc.contactIds?.includes(chat.id)) return false;
  if (chat.type === 'group' && exc.groupIds?.includes(chat.id)) return false;

  return true;
}

/** Count unread chats matching a folder, for the tab badge. */
export function countUnreadForFolder(folder: ChatFolder, chats: ChatSummary[]): number {
  return chats.reduce((n, c) => (c.unread > 0 && matchesFolder(folder, c) ? n + 1 : n), 0);
}

/** Predefined templates offered during folder creation. */
export const FOLDER_TEMPLATES: Array<{
  name: string;
  icon: string;
  include: ChatFolder['include'];
}> = [
  { name: 'Unread', icon: 'Mail', include: { unread: true } },
  { name: 'Personal', icon: 'Heart', include: { types: ['dm'] } },
  { name: 'Work', icon: 'Briefcase', include: { types: ['group'] } },
  { name: 'Pinned', icon: 'Pin', include: { pinned: true } },
];
