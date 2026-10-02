/**
 * Compression dictionary loading — IndexedDB cache, then network fetch with
 * retries, then a built-in fallback corpus if both fail. Encryption cannot
 * proceed without a dictionary (see relay-crypto.ts's Session), so the
 * fallback build failing is treated as fatal.
 */

import { useCallback } from 'react';
import { log } from '@/lib/platform/logger';
import { loadCachedDictionary, cacheDictionary } from '@/lib/messaging/compression-cache';
import { buildDictionary } from '@/lib/crypto/relay-crypto';
import type { SharedMessagingRefs } from '@/lib/hooks/messaging-types';

export function useDictionary(shared: SharedMessagingRefs) {
  const { dictRef } = shared;

  const loadDictionary = useCallback(async (retries = 3): Promise<Uint8Array> => {
    if (dictRef.current) return dictRef.current;

    // Try IndexedDB cache first (avoids network fetch on reload)
    const cached = await loadCachedDictionary();
    if (cached) {
      dictRef.current = cached;
      return cached;
    }

    // Try to load with retries
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch('/dicts/chat-v1.bin');
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength === 0) {
            throw new Error('Dictionary file is empty');
          }
          dictRef.current = new Uint8Array(buffer);
          cacheDictionary(dictRef.current).catch(() => {});
          return dictRef.current;
        }
      } catch (err) {
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
        }
      }
    }

    // Fallback: Build default dictionary
    const corpus = [
      'hello how are you doing today',
      'im good thanks for asking',
      'what are you up to',
      'just working on some projects',
      'that sounds interesting tell me more',
      'okay sounds good to me',
      'thanks for letting me know',
      'no problem happy to help',
      'see you later talk soon',
      'goodbye have a great day',
      'lets meet up sometime',
      'sure id love that',
      'what time works for you',
      'any time is fine',
      'cool lets do it',
      'absolutely yes definitely maybe',
      'not sure about that',
      'ill think about it',
      'sounds like a plan',
      'perfect lets go',
    ];

    try {
      const dict = buildDictionary(corpus);
      if (!dict || dict.length === 0) {
        throw new Error('Failed to build dictionary');
      }
      dictRef.current = dict;
      // Deliberately NEVER cached. relay-crypto.ts's Session mixes
      // sha256(dict) directly into every session's root-key HKDF — two
      // peers with different dictionaries derive different keys from the
      // identical shared secret, with no error, no mismatch signal, just
      // permanently failing AEAD verification indistinguishable from any
      // other decrypt failure. cacheDictionary() persists under the exact
      // same key/version as a real network-fetched dictionary (see
      // compression-cache.ts) — caching this fallback here previously meant
      // ANY single flaky-network moment (a CDN blip during onboarding)
      // permanently pinned this device to the wrong dictionary forever,
      // since loadCachedDictionary() would then always return it before a
      // network fetch is ever attempted again. Not caching it means the
      // NEXT call to loadDictionary() (next reload/session) gets a fresh
      // chance to fetch the real one — this failure mode becomes transient
      // and self-healing instead of permanent and silent.
      log.error('[Crypto] Dictionary network fetch failed after retries — using an UNCACHED local fallback this session only. If this persists across reloads, sessions with peers who successfully fetched the real dictionary will fail to decrypt.');
      return dict;
    } catch (err) {
      log.error('[Crypto] CRITICAL: Dictionary build failed:', err);
      throw new Error('Failed to load or build dictionary - encryption will not work');
    }
  }, [dictRef]);

  return loadDictionary;
}
