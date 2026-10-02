/**
 * Regression coverage for lib/messaging/dictionary.ts's network-fetch
 * fallback. relay-crypto.ts's Session mixes sha256(dict) directly into
 * every session's root-key HKDF (dictHash, ~line 534/545) — two peers with
 * different dictionaries silently derive different keys from the identical
 * shared secret. The local fallback corpus used to be cached under the
 * exact same key/version as a real network-fetched dictionary
 * (compression-cache.ts), so a single flaky-network moment during
 * onboarding could permanently pin a device to the wrong dictionary
 * forever. The fix: never cache the fallback.
 *
 * useCallback is mocked to a passthrough (same technique as
 * burn.test.ts) so the hook can be called directly with a plain ref, no
 * component tree required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useCallback: (fn: unknown) => fn };
});

const loadCachedDictionary = vi.fn();
const cacheDictionary = vi.fn(async (_dict: Uint8Array) => {});
vi.mock('@/lib/messaging/compression-cache', () => ({
  loadCachedDictionary: () => loadCachedDictionary(),
  cacheDictionary: (dict: Uint8Array) => cacheDictionary(dict),
}));

import { useDictionary } from '../messaging/dictionary';

function ref<T>(current: T) {
  return { current };
}

beforeEach(() => {
  loadCachedDictionary.mockReset();
  cacheDictionary.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});

describe('loadDictionary — fallback dictionary is never cached', () => {
  it('returns the cached dictionary directly and never fetches when IndexedDB already has one', async () => {
    const cached = new Uint8Array([1, 2, 3]);
    loadCachedDictionary.mockResolvedValue(cached);
    const dictRef = ref<Uint8Array | null>(null);
    const loadDictionary = useDictionary({ dictRef } as any);

    const result = await loadDictionary();

    expect(result).toBe(cached);
    expect(fetch).not.toHaveBeenCalled();
    expect(cacheDictionary).not.toHaveBeenCalled();
  });

  it('caches a real network-fetched dictionary', async () => {
    loadCachedDictionary.mockResolvedValue(null);
    const bytes = new Uint8Array([9, 9, 9, 9]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer } as any);
    const dictRef = ref<Uint8Array | null>(null);
    const loadDictionary = useDictionary({ dictRef } as any);

    const result = await loadDictionary();

    expect(result).toEqual(bytes);
    expect(cacheDictionary).toHaveBeenCalledTimes(1);
    expect(cacheDictionary).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('THE REGRESSION: falls back to the local corpus after all retries fail, but does NOT cache it', async () => {
    loadCachedDictionary.mockResolvedValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    const dictRef = ref<Uint8Array | null>(null);
    const loadDictionary = useDictionary({ dictRef } as any);

    const result = await loadDictionary(1); // 1 retry to keep the test fast

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result!.length).toBeGreaterThan(0);
    // The entire point of this fix: a fallback dictionary must never be
    // persisted, or the next session would load it from cache forever
    // instead of getting another chance to fetch the real one.
    expect(cacheDictionary).not.toHaveBeenCalled();
  });

  it('a second call after a failed fallback still attempts a fresh network fetch (self-healing), not a cached fallback', async () => {
    loadCachedDictionary.mockResolvedValue(null);
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([5, 5, 5]).buffer } as any);
    const dictRef1 = ref<Uint8Array | null>(null);
    const loadDictionary1 = useDictionary({ dictRef: dictRef1 } as any);
    await loadDictionary1(1);

    // Simulate a fresh session (new dictRef, e.g. a reload) — since nothing
    // was cached, loadCachedDictionary is asked again and (per this test)
    // still finds nothing, so a real fetch is attempted and succeeds.
    const dictRef2 = ref<Uint8Array | null>(null);
    const loadDictionary2 = useDictionary({ dictRef: dictRef2 } as any);
    const result = await loadDictionary2(1);

    expect(result).toEqual(new Uint8Array([5, 5, 5]));
    expect(cacheDictionary).toHaveBeenCalledTimes(1); // only the successful real fetch
  });
});
