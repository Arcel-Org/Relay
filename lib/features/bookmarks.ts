/**
 * Bookmarks — save message snapshots locally.
 *
 * Storage: localStorage key `relay:bookmarks` = Bookmark[]
 */

const STORAGE_KEY = 'relay:bookmarks';

export interface Bookmark {
  id: string; // messageId
  conversationId: string;
  text: string;
  senderName?: string;
  senderRelayId?: string;
  timestamp: number;
  bookmarkedAt: number;
}

function readAll(): Bookmark[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Bookmark[];
  } catch {
    return [];
  }
}

function writeAll(list: Bookmark[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota */
  }
}

export function getBookmarks(): Bookmark[] {
  return readAll();
}

export function addBookmark(b: Omit<Bookmark, 'bookmarkedAt'>): Bookmark[] {
  const now = Date.now();
  const all = readAll().filter((x) => x.id !== b.id);
  const entry: Bookmark = { ...b, bookmarkedAt: now };
  const next = [entry, ...all];
  writeAll(next);
  return next;
}

export function removeBookmark(id: string): Bookmark[] {
  const next = readAll().filter((x) => x.id !== id);
  writeAll(next);
  return next;
}

export function isBookmarked(id: string): boolean {
  return readAll().some((x) => x.id === id);
}

export function exportBookmarks(): string {
  return JSON.stringify(readAll(), null, 2);
}
