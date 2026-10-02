/**
 * Ghost Mode — per-conversation auto-expiring messages.
 *
 * Settings persist per chat in localStorage under `relay:ghost:<conversationId>`.
 * Messages get `expiresAt` stamped at send time (see helper below).
 * A sweeper iterates persisted messages periodically and deletes expired ones
 * via the normal delete flow.
 *
 * This module is intentionally decoupled from the crypto/protocol layer — it
 * only touches local storage + UI state.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getAllMessagesForConversation, deleteMessage as storeDeleteMessage } from '@/lib/db/relay-store';
import { log } from '@/lib/platform/logger';

export const GHOST_PRESETS = {
  OFF: 0,
  THIRTY_SECONDS: 30,
  FIVE_MINUTES: 5 * 60,
  ONE_HOUR: 60 * 60,
  TWENTY_FOUR_HOURS: 24 * 60 * 60,
  SEVEN_DAYS: 7 * 24 * 60 * 60,
} as const;

export const GHOST_OPTIONS: { value: number; label: string }[] = [
  { value: GHOST_PRESETS.OFF, label: 'Off' },
  { value: GHOST_PRESETS.THIRTY_SECONDS, label: '30 seconds' },
  { value: GHOST_PRESETS.FIVE_MINUTES, label: '5 minutes' },
  { value: GHOST_PRESETS.ONE_HOUR, label: '1 hour' },
  { value: GHOST_PRESETS.TWENTY_FOUR_HOURS, label: '24 hours' },
  { value: GHOST_PRESETS.SEVEN_DAYS, label: '7 days' },
];

function storageKey(conversationId: string): string {
  return `relay:ghost:${conversationId}`;
}

// Simple pub-sub so the UI re-renders when settings change
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => { try { l(); } catch { /* */ } }); }

export function getGhostSeconds(conversationId: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(storageKey(conversationId));
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

export function setGhostSeconds(conversationId: string, seconds: number): void {
  if (typeof window === 'undefined') return;
  try {
    if (seconds <= 0) {
      localStorage.removeItem(storageKey(conversationId));
    } else {
      localStorage.setItem(storageKey(conversationId), String(Math.floor(seconds)));
    }
    emit();
  } catch (err) {
    log.warn('[ghost] Failed to persist ghost setting', err);
  }
}

export function formatGhostLabel(seconds: number): string {
  const match = GHOST_OPTIONS.find((o) => o.value === seconds);
  if (match) return match.label;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * React hook — reactive ghost setting for a given conversation.
 */
export function useGhostMode(conversationId: string | null | undefined): {
  seconds: number;
  setSeconds: (n: number) => void;
  isOn: boolean;
  label: string;
} {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, []);
  const seconds = useSyncExternalStore(
    subscribe,
    () => (conversationId ? getGhostSeconds(conversationId) : 0),
    () => 0,
  );
  const setSeconds = useCallback((n: number) => {
    if (!conversationId) return;
    setGhostSeconds(conversationId, n);
  }, [conversationId]);
  return { seconds, setSeconds, isOn: seconds > 0, label: formatGhostLabel(seconds) };
}

/**
 * Compute expiresAt timestamp (ms) based on current ghost setting.
 * Returns undefined when ghost is off OR when the user is not currently
 * viewing the ghost thread for this conversation.
 *
 * This is the key guard that ensures non-ghost messages never get stamped
 * with an expiresAt: a ghost interval alone is no longer sufficient — the
 * user must have explicitly toggled into the ghost thread view.
 */
export function computeExpiresAt(conversationId: string): number | undefined {
  const s = getGhostSeconds(conversationId);
  if (s <= 0) return undefined;
  if (!getGhostModeActive(conversationId)) return undefined;
  return Date.now() + s * 1000;
}

// ────────────────────────────────────────────────────────────────────────
// Ghost thread-view state (in-memory, per tab). Distinct from the interval
// setting persisted in localStorage — this tracks whether the user is
// currently LOOKING at the ghost thread for a given conversation.
// ────────────────────────────────────────────────────────────────────────

const activeViews = new Map<string, boolean>();
const activeListeners = new Set<() => void>();
function emitActive() { activeListeners.forEach((l) => { try { l(); } catch { /* */ } }); }

export function getGhostModeActive(conversationId: string): boolean {
  return activeViews.get(conversationId) === true;
}

export function setGhostModeActive(conversationId: string, active: boolean): void {
  if (active) activeViews.set(conversationId, true);
  else activeViews.delete(conversationId);
  emitActive();
}

export function useGhostModeActive(conversationId: string | null | undefined): {
  active: boolean;
  setActive: (on: boolean) => void;
  toggle: () => void;
} {
  const subscribe = useCallback((cb: () => void) => {
    activeListeners.add(cb);
    return () => { activeListeners.delete(cb); };
  }, []);
  const active = useSyncExternalStore(
    subscribe,
    () => (conversationId ? getGhostModeActive(conversationId) : false),
    () => false,
  );
  const setActive = useCallback((on: boolean) => {
    if (!conversationId) return;
    setGhostModeActive(conversationId, on);
  }, [conversationId]);
  const toggle = useCallback(() => {
    if (!conversationId) return;
    setGhostModeActive(conversationId, !getGhostModeActive(conversationId));
  }, [conversationId]);
  return { active, setActive, toggle };
}

/**
 * Filter messages out whose expiresAt has passed. Use for immediate UI hiding.
 */
export function filterExpired<T extends { expiresAt?: number }>(items: T[], now = Date.now()): T[] {
  return items.filter((m) => !m.expiresAt || m.expiresAt > now);
}

/**
 * Sweep: iterate all persisted messages in all known groups + conversations,
 * delete any with expired expiresAt. Safe to call repeatedly.
 */
export async function sweepExpired(
  conversationIds: string[],
  onDeleted?: (conversationId: string, messageId: string) => void,
): Promise<number> {
  const now = Date.now();
  let deleted = 0;
  for (const cid of conversationIds) {
    try {
      const msgs = await getAllMessagesForConversation(cid);
      for (const m of msgs) {
        if (m.expiresAt && m.expiresAt <= now) {
          try {
            await storeDeleteMessage(m.id);
            onDeleted?.(cid, m.id);
            deleted++;
          } catch (err) {
            log.debug('[ghost] delete failed', err);
          }
        }
      }
    } catch (err) {
      log.debug('[ghost] sweep skipped', cid, err);
    }
  }
  return deleted;
}

/**
 * Hook that runs a periodic sweep (every 10s) and invalidates the UI when
 * expirations happen. Pass the set of conversation IDs currently known.
 */
export function useGhostSweeper(
  conversationIds: string[],
  onDeleted?: (conversationId: string, messageId: string) => void,
): void {
  useEffect(() => {
    if (!conversationIds.length) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try { await sweepExpired(conversationIds, onDeleted); } catch { /* noop */ }
    };
    // Run once immediately, then every 10s
    void tick();
    const id = setInterval(() => { void tick(); }, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [conversationIds.join('|'), onDeleted]); // eslint-disable-line react-hooks/exhaustive-deps
}
