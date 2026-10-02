/**
 * @vitest-environment node
 *
 * Regression test for the handshake-authentication binding in
 * lib/messaging/key-exchange.ts (#2). The relay is untrusted and stamps
 * `fromRelayId` itself, so a MITM relay can forward its OWN public key while
 * claiming the offer came from the victim's contact. handleKeyExchangeReceived
 * must reject any key_exchange whose publicKey does not hash to the claimed
 * relayId (relayIdFromPublicKey(theirPublicKey) === fromRelayId), and accept a
 * matching one.
 *
 * node environment + react mock for the same reasons as
 * receive-signature-verification.test.ts (Buffer/@noble realm + no renderHook).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void) => fn(),
  };
});

const toastWarning = vi.fn();
vi.mock('@/components/ToastNotification', () => ({
  toast: { warning: (...a: unknown[]) => toastWarning(...a), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/messaging/ephemeral-contacts', () => ({ isEphemeralContact: vi.fn(() => false) }));
vi.mock('@/lib/messaging/message-persistence', () => ({ persistMessage: vi.fn(async () => {}) }));
vi.mock('@/lib/messaging/ghost-mode', () => ({ computeExpiresAt: vi.fn(() => undefined) }));
vi.mock('@/lib/features/features-store', () => ({
  getSafetyNumber: vi.fn(async () => null),
  storeSafetyNumber: vi.fn(async () => {}),
}));
vi.mock('@/lib/features/safety-numbers', () => ({ createSafetyNumber: vi.fn(() => ({})) }));

const saveContactPublicKey = vi.fn();
const saveRatchetState = vi.fn();
let ratchetStore: Record<string, any> = {};
vi.mock('@/lib/messaging/contact-key-cache', () => ({
  loadContactPublicKey: vi.fn(() => null),
  saveContactPublicKey: (...a: unknown[]) => saveContactPublicKey(...a),
  loadContactPqPublicKey: vi.fn(() => null),
  loadContactSigningPublicKey: vi.fn(() => null),
  saveRatchetState: (...a: unknown[]) => saveRatchetState(...a),
  loadRatchetState: vi.fn((id: string) => ratchetStore[id] ?? null),
}));

import { useKeyExchange } from '../messaging/key-exchange';
import { generateKeypair, buildDictionary } from '../crypto/relay-crypto';
import { relayIdFromPublicKey } from '../crypto/relay-id';
import { toHex } from '../crypto/hex-utils';

function ref<T>(current: T) {
  return { current };
}

function makeHarness() {
  const me = generateKeypair();
  const myRelayId = relayIdFromPublicKey(me.publicKey);
  const sendKeyExchange = vi.fn();

  const shared: any = {
    wsRef: ref<any>({ sendKeyExchange, isReady: () => true }),
    sessionsRef: ref(new Map<string, any>()),
    identityRef: ref<any>({
      privateKey: me.privateKey,
      publicKey: me.publicKey,
      relayId: myRelayId,
      pqPrivateKey: undefined,
      pqPublicKey: undefined,
    }),
    keyExchangeLastResponseRef: ref(new Map<string, number>()),
    keyExchangeTimeoutsRef: ref(new Map()),
    keyExchangeInitiatedRef: ref(new Set<string>()),
    pendingPqSecretsRef: ref(new Map()),
    pendingEncryptedRef: ref(new Map()),
    pendingMessagesRef: ref(new Map()),
    pendingFilesRef: ref(new Map()),
    handleMessageReceivedRef: ref<any>(null),
    contactsRef: ref<any[]>([]),
  };
  const state: any = { contacts: [], setMessages: vi.fn() };

  const hook = useKeyExchange({
    shared,
    state,
    loadDictionary: async () => buildDictionary(['key exchange binding regression test corpus']),
  });
  return { hook, shared, sendKeyExchange };
}

describe('key-exchange handshake identity binding (#2)', () => {
  beforeEach(() => {
    toastWarning.mockClear();
    saveContactPublicKey.mockClear();
    saveRatchetState.mockClear();
    ratchetStore = {};
  });

  it('rejects a key exchange whose public key does not hash to the claimed fromRelayId (relay MITM)', async () => {
    const { hook, shared } = makeHarness();

    // The relay claims the offer is from `victimRelayId`, but forwards the
    // ATTACKER's public key (which hashes to a different relayId).
    const victim = generateKeypair();
    const victimRelayId = relayIdFromPublicKey(victim.publicKey);
    const attacker = generateKeypair();
    expect(relayIdFromPublicKey(attacker.publicKey)).not.toBe(victimRelayId);

    await hook.handleKeyExchangeReceived({
      fromRelayId: victimRelayId,
      publicKey: toHex(attacker.publicKey),
    });

    expect(toastWarning).toHaveBeenCalledWith(
      'Rejected suspicious key exchange',
      expect.stringContaining('did not match that identity')
    );
    // No session established for the spoofed identity.
    expect(shared.sessionsRef.current.has(victimRelayId)).toBe(false);
    expect(saveContactPublicKey).not.toHaveBeenCalled();
  });

  it('accepts a key exchange whose public key correctly hashes to fromRelayId', async () => {
    const { hook, shared, sendKeyExchange } = makeHarness();

    const peer = generateKeypair();
    const peerRelayId = relayIdFromPublicKey(peer.publicKey);

    await hook.handleKeyExchangeReceived({
      fromRelayId: peerRelayId,
      publicKey: toHex(peer.publicKey),
    });

    expect(toastWarning).not.toHaveBeenCalled();
    // Session established, keys + ratchet state persisted, and we respond so the
    // peer can complete its own session.
    expect(shared.sessionsRef.current.has(peerRelayId)).toBe(true);
    expect(saveRatchetState).toHaveBeenCalled();
    expect(sendKeyExchange).toHaveBeenCalled();
  });
});
