/**
 * Identity loading — resolves the current user's private/public key (and PQ
 * keys, when available) from the auth store, with a session-persistence
 * fallback, and writes it into identityRef for the rest of the messaging
 * hook to use.
 */

import { useCallback } from 'react';
import type { useRouter } from 'next/navigation';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { log } from '@/lib/platform/logger';
import { toast } from '@/components/ToastNotification';
import { loadSession } from '@/lib/auth/session-persistence';
import type { SharedMessagingRefs, IdentityInfo } from '@/lib/hooks/messaging-types';

interface UseIdentityParams {
  shared: SharedMessagingRefs;
  authStore: {
    getPrivateKey: () => Uint8Array | null;
    currentRelayId: string | null;
    getPqPrivateKey: () => Uint8Array | null;
  };
  router: ReturnType<typeof useRouter>;
  setError: (error: string | null) => void;
}

export function useIdentity({ shared, authStore, router, setError }: UseIdentityParams) {
  const { identityRef } = shared;

  const loadIdentity = useCallback(async (): Promise<(IdentityInfo & { pubKeyHex: string }) | null> => {
    try {
      if (typeof window === 'undefined') return null;

      // Get identity from auth store
      let privateKey = authStore.getPrivateKey();
      let currentRelayId = authStore.currentRelayId;

      // Fallback: if not in store, try to load from session directly
      if (!privateKey || !currentRelayId) {
        try {
          const { hexToBytes } = require('@noble/hashes/utils.js');
          const session = loadSession();
          if (session && session.privateKeyHex && session.relayId) {
            privateKey = hexToBytes(session.privateKeyHex);
            currentRelayId = session.relayId;
          }
        } catch (err) {
          // Silently fail fallback
        }
      }

      if (!privateKey || !currentRelayId) {
        log.warn('Identity not found in auth store, redirecting to login');
        router.push('/auth/login');
        return null;
      }

      // Compute public key from private key using x25519
      const { x25519 } = require('@noble/curves/ed25519.js');
      const publicKey = x25519.getPublicKey(privateKey);
      const pubKeyHex = toHex(publicKey);

      // PQ private key comes from the auth store (decrypted with the PIN at
      // login time) — never read the raw encrypted-at-rest IndexedDB copy
      // here, since it's PIN-encrypted and this scope has no PIN.
      let pqPrivateKey: Uint8Array | undefined = authStore.getPqPrivateKey() || undefined;
      let pqPublicKey: Uint8Array | undefined;
      try {
        const { getUserByRelayId } = await import('@/lib/db/relay-db');
        const user = await getUserByRelayId(currentRelayId);
        if (user && user.pqPublicKeyHex) {
          pqPublicKey = fromHex(user.pqPublicKeyHex);
        }
        if (!pqPrivateKey && user?.pqPrivateKeyHex) {
          log.warn('PQ private key not available in auth store; hybrid key exchange unavailable until re-login');
        }
      } catch (err) {
        log.warn('Failed to load PQ public key from IndexedDB:', err);
      }

      // QR-paired devices never get a local `users` row (getUserByRelayId
      // above returns nothing for them), so their only source for their own
      // PQ public key is the session record populated at pairing time —
      // mirrors the privateKey/currentRelayId session fallback above.
      // Without this, a QR-paired device silently advertises no PQ public
      // key and every session it opens downgrades to classical-only.
      if (!pqPublicKey) {
        try {
          const session = loadSession();
          if (session?.pqPublicKeyHex) {
            pqPublicKey = fromHex(session.pqPublicKeyHex);
          }
        } catch (err) {
          // Silently fail fallback
        }
      }

      identityRef.current = { privateKey, publicKey, relayId: currentRelayId, pqPrivateKey, pqPublicKey };

      return { privateKey, publicKey, relayId: currentRelayId, pubKeyHex, pqPrivateKey, pqPublicKey };
    } catch (err) {
      setError('Failed to load identity');
      toast.error('Session expired', 'Please log in again');
      router.push('/auth/login');
      return null;
    }
  }, [authStore, router, setError, identityRef]);

  return loadIdentity;
}
