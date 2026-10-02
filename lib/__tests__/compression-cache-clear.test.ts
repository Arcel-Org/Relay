/**
 * Regression coverage for the "Clear local cache" button (SettingsPanel.tsx)
 * — it previously only swept localStorage keys under an 'relay:cache:' prefix
 * that literally nothing in the codebase ever wrote to, so the button
 * always did nothing while still showing "Cache cleared". The only genuine,
 * safe-to-clear cache in this app is the compression dictionary (it
 * self-heals by re-fetching/rebuilding on next use, per dictionary.ts) —
 * message history and ratchet state are NOT cache in this E2E system (no
 * server-side re-sync source), so clearing those would be real data loss.
 *
 * Checks the raw IndexedDB keys directly via idb-keyval rather than through
 * loadCachedDictionary()'s own `cached instanceof Uint8Array` check — under
 * fake-indexeddb, a stored Uint8Array comes back via structured clone as an
 * object from a different realm, so `instanceof` doesn't hold even though
 * the data round-trips correctly (a test-environment artifact, not a real
 * bug: same-realm in an actual browser). Plain strings like the version
 * marker don't hit that boundary, so checking the version key directly is
 * both simpler and avoids the false negative.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'idb-keyval';
import { cacheDictionary, clearDictionaryCache } from '../messaging/compression-cache';

const DICT_CACHE_KEY = 'relay:compression-dict';
const DICT_VERSION_KEY = 'relay:compression-dict-version';

beforeEach(async () => {
  await clearDictionaryCache();
});

describe('clearDictionaryCache', () => {
  it('THE REGRESSION: removes both the cached dictionary and its version marker', async () => {
    await cacheDictionary(new Uint8Array([1, 2, 3, 4]));
    expect(await get(DICT_VERSION_KEY)).toBe('v1');
    expect(await get(DICT_CACHE_KEY)).toBeTruthy();

    await clearDictionaryCache();

    expect(await get(DICT_VERSION_KEY)).toBeUndefined();
    expect(await get(DICT_CACHE_KEY)).toBeUndefined();
  });

  it('is a no-op (does not throw) when nothing was cached', async () => {
    await expect(clearDictionaryCache()).resolves.toBeUndefined();
  });
});
