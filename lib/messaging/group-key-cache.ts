/**
 * In-memory cache of each group's current (and, briefly during a rotation,
 * previous) epoch key — mirrors contact-key-cache.ts's exact shape (sync
 * in-memory reads for the hot send/receive path, fire-and-forget encrypted-
 * at-rest persistence via relay-store.ts's saveGroupKey/loadGroupKey).
 *
 * Unlike contact keys, there's no single "getAllGroups" bulk read to
 * hydrate from at startup — each group's key is its own row keyed by
 * groupId, so hydrateGroupKeyCache() takes the list of known groupIds
 * (already available from the groups loaded out of localStorage) and loads
 * each one explicitly.
 */
import { saveGroupKey, loadGroupKey, type StoredGroupKeyRecord } from '@/lib/db/relay-store';
import { log } from '@/lib/platform/logger';

const groupKeyCache = new Map<string, StoredGroupKeyRecord>();

/** Sync read of a group's current epoch key record, or null if none is known yet. */
export function getActiveGroupKey(groupId: string): StoredGroupKeyRecord | null {
  return groupKeyCache.get(groupId) || null;
}

/**
 * Set (and persist) a group's epoch key. Callers rotating an existing key
 * should pass the outgoing key as `previousEpochKeyHex` so a message
 * encrypted just before rotation propagated (a normal race, not an error)
 * can still be decrypted during the transition — see getKeyForEpoch.
 */
export function setActiveGroupKey(groupId: string, record: StoredGroupKeyRecord): void {
  groupKeyCache.set(groupId, record);
  saveGroupKey(groupId, record).catch((err) => log.error(`[GroupKey] Failed to persist key for ${groupId}:`, err));
}

/** Resolve the actual key bytes for a specific epoch — the current epoch, or the retained previous one during a rotation's transition window. Null if neither matches (a genuinely unknown epoch — held/dropped by the caller, see use-group-messaging.ts). */
export function getKeyHexForEpoch(groupId: string, epoch: number): string | null {
  const record = groupKeyCache.get(groupId);
  if (!record) return null;
  if (record.epoch === epoch) return record.keyHex;
  if (record.previousEpochKeyHex && epoch === record.epoch - 1) return record.previousEpochKeyHex;
  return null;
}

/** Load every known group's key from encrypted-at-rest storage into the in-memory cache. Call once after storage init + groups are loaded from localStorage. */
export async function hydrateGroupKeyCache(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    try {
      const record = await loadGroupKey(groupId);
      if (record) groupKeyCache.set(groupId, record);
    } catch { /* storage may not be ready yet */ }
  }
}
