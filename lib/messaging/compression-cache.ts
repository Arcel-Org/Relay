/**
 * Compression dictionary cache — persists the CryptoPress dictionary
 * to IndexedDB so it doesn't need to be rebuilt every session.
 *
 * The dictionary is keyed by a version string so it can be invalidated
 * when the dictionary format changes.
 */

import { get, set, del } from 'idb-keyval';

const DICT_CACHE_KEY = 'relay:compression-dict';
const DICT_VERSION_KEY = 'relay:compression-dict-version';
const CURRENT_VERSION = 'v1';

/** Load a cached dictionary from IndexedDB, or null if not cached / stale. */
export async function loadCachedDictionary(): Promise<Uint8Array | null> {
  try {
    const version = await get(DICT_VERSION_KEY);
    if (version !== CURRENT_VERSION) return null;

    const cached = await get(DICT_CACHE_KEY);
    if (cached instanceof Uint8Array && cached.length > 0) {
      return cached;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a dictionary to IndexedDB for future sessions. */
export async function cacheDictionary(dict: Uint8Array): Promise<void> {
  try {
    await set(DICT_CACHE_KEY, dict);
    await set(DICT_VERSION_KEY, CURRENT_VERSION);
  } catch {
    // Non-critical — next session will rebuild
  }
}

/**
 * Drop the cached dictionary — self-healing (dictionary.ts's loadDictionary
 * re-fetches or rebuilds it on next use), unlike message history or ratchet
 * session state, which have no re-sync source in this E2E architecture and
 * must never be included in a "clear cache" action.
 */
export async function clearDictionaryCache(): Promise<void> {
  await del(DICT_CACHE_KEY);
  await del(DICT_VERSION_KEY);
}
