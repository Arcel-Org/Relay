/**
 * @vitest-environment node
 *
 * Regression test for the actual lib/messaging/receive.ts wiring — not just
 * the crypto primitives (relay-crypto.test.ts, message-signing correctness)
 * or a hand-rolled mirror of the envelope logic (messaging-integration.test.ts,
 * whose own doc comment notes it never touches the real receive.ts). This
 * calls the real handleMessageReceived and caught a real regression where
 * receive.ts verified signatures against sessionData.publicKeyHex (the
 * peer's X25519 identity key) instead of sessionData.signingPublicKeyHex
 * (their derived Ed25519 signing key) — which made every signed message
 * from any peer fail verification and get silently dropped.
 *
 * node environment (not the project default jsdom) because message-signing.ts
 * round-trips signatures through Node's Buffer.from(hex), and @noble/curves'
 * instanceof Uint8Array checks fail across jsdom's separate Uint8Array realm
 * — same reasoning as messaging-integration.test.ts. That in turn rules out
 * rendering useMessageReceive through @testing-library/react's renderHook
 * (it requires `document`, i.e. jsdom). Since useMessageReceive doesn't use
 * any actual React rendering behavior — just useCallback for memoization and
 * one useEffect that syncs a ref — 'react' is mocked here to make both
 * synchronous passthroughs, so the hook can be called directly as a plain
 * function with plain object refs/state, no component tree required.
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

vi.mock('@/lib/messaging/ghost-mode', () => ({
  computeExpiresAt: vi.fn(() => undefined),
}));
vi.mock('@/lib/messaging/ephemeral-contacts', () => ({
  isEphemeralContact: vi.fn(() => false),
}));
vi.mock('@/lib/messaging/message-persistence', () => ({
  persistMessage: vi.fn(async () => {}),
}));
vi.mock('@/lib/platform/notifications', () => ({
  sendNotification: vi.fn(async () => {}),
  vibrate: vi.fn(() => {}),
}));
vi.mock('@/lib/messaging/username-lookup', () => ({
  lookupUserProfile: vi.fn(async () => null),
}));
vi.mock('@/lib/db/relay-store', () => ({
  upsertContact: vi.fn(async () => {}),
}));
vi.mock('@/lib/messaging/contact-key-cache', () => ({
  loadContactPublicKey: vi.fn(() => null),
  saveContactPublicKey: vi.fn(() => {}),
  loadContactSigningPublicKey: vi.fn(() => null),
  loadRatchetState: vi.fn(() => null),
  saveRatchetState: vi.fn(() => {}),
}));
const toastError = vi.fn();
vi.mock('@/components/ToastNotification', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), warning: vi.fn(), success: vi.fn() },
}));

import { useMessageReceive } from '../messaging/receive';
import {
  Session,
  generateKeypair,
  computeSharedSecret,
  deriveSessionRole,
  buildDictionary,
} from '../crypto/relay-crypto';
import { signMessage, deriveSigningKeypair } from '../crypto/message-signing';

function makeDict() {
  return buildDictionary(['Regression test for receive.ts signature verification wiring']);
}

/** Plain-object stand-in for a React ref — { current } is all receive.ts touches. */
function ref<T>(current: T) {
  return { current };
}

/**
 * Minimal SharedMessagingRefs/State fixture — plain objects, no React needed
 * (see file header). `initialContacts` must be passed in up front: receive.ts
 * destructures `const { contacts } = state` once at hook-invocation time (a
 * real re-render would give it a fresh closure over updated state; this
 * harness calls the hook body exactly once, so a contacts update made via
 * state.setContacts() AFTER construction would never be seen by the already-
 * closed-over handleMessageReceived).
 */
function makeHarness(initialContacts: any[] = []) {
  let messages = new Map<string, any[]>();
  let contacts: any[] = initialContacts;

  const shared = {
    wsRef: ref<any>({ sendAck: vi.fn(), isReady: () => true }),
    sessionsRef: ref(new Map<string, any>()),
    identityRef: ref<any>(null),
    dictRef: ref<Uint8Array | null>(null),
    pendingMessagesRef: ref(new Map()),
    reconnectQueueRef: ref([] as any[]),
    pendingFilesRef: ref(new Map()),
    keyExchangeInitiatedRef: ref(new Set<string>()),
    contactsRef: ref([] as any[]),
    groupsRef: ref([] as any[]),
    sentMessagesRef: ref(new Map()),
    keyExchangeTimeoutsRef: ref(new Map()),
    handleMessageReceivedRef: ref<any>(null),
    keyExchangeLastResponseRef: ref(new Map()),
    pendingEncryptedRef: ref(new Map()),
    pendingPqSecretsRef: ref(new Map()),
    initializationCompleteRef: ref(true),
  };

  const state = {
    get messages() { return messages; },
    setMessages: (updater: any) => { messages = typeof updater === 'function' ? updater(messages) : updater; },
    get contacts() { return contacts; },
    setContacts: (updater: any) => { contacts = typeof updater === 'function' ? updater(contacts) : updater; },
    groups: [] as any[],
    setGroups: vi.fn(),
  };

  const initiateKeyExchange = vi.fn();

  const receive = useMessageReceive({
    shared,
    // `state.contacts`/`state.messages` are read live via getters above, so
    // the closure useMessageReceive captures always sees the current value
    // — equivalent to what a real re-render would give it.
    state: state as any,
    initiateKeyExchange,
    loadDictionary: async () => makeDict(),
    updateSessionStats: vi.fn(),
    applyReactionToState: vi.fn(),
    handleGroupMessage: vi.fn(),
    initiateResync: vi.fn(),
  });

  return { receive, shared, state, initiateKeyExchange };
}

describe('receive.ts signature verification wiring', () => {
  beforeEach(() => {
    toastError.mockClear();
  });

  it('accepts a message correctly signed with the peer-s derived Ed25519 signing key', async () => {
    const senderIdentity = generateKeypair();
    const senderRelayId = 'relay:sender-test';
    const receiverIdentity = generateKeypair();
    const senderSigningKeypair = deriveSigningKeypair(senderIdentity.privateKey);

    // Two complementary Session instances, one per side, exactly as two real
    // peers would each derive independently from the same ECDH shared
    // secret — encrypting and decrypting with the SAME Session instance is
    // not equivalent, since send/recv use separate ratchet chains per role.
    const dict = makeDict();
    const senderSharedSecret = computeSharedSecret(senderIdentity.privateKey, receiverIdentity.publicKey);
    const senderRole = deriveSessionRole(senderIdentity.publicKey, receiverIdentity.publicKey);
    const senderSession = new Session(senderSharedSecret, dict, 1, senderRole);

    const receiverSharedSecret = computeSharedSecret(receiverIdentity.privateKey, senderIdentity.publicKey);
    const receiverRole = deriveSessionRole(receiverIdentity.publicKey, senderIdentity.publicKey);
    const receiverSession = new Session(receiverSharedSecret, dict, 1, receiverRole);

    const { receive, shared, state } = makeHarness([
      { id: senderRelayId, relayId: senderRelayId, name: 'Sender', messages: [] },
    ]);

    // Pre-populate the session with BOTH keys, exactly as key-exchange.ts
    // does — signingPublicKeyHex is the field the fix reads from.
    shared.sessionsRef.current.set(senderRelayId, {
      relayId: senderRelayId,
      session: receiverSession,
      publicKeyHex: Buffer.from(senderIdentity.publicKey).toString('hex'),
      signingPublicKeyHex: Buffer.from(senderSigningKeypair.publicKey).toString('hex'),
    });

    const msgId = 'msg-1';
    const text = 'hello from the real signing path';
    const signed = await signMessage(msgId, text, senderRelayId, senderSigningKeypair.privateKey);

    const wirePayload = JSON.stringify({ type: 'text', text, sig: signed.signature, sigTs: signed.timestamp });
    const encrypted = senderSession.encrypt(new TextEncoder().encode(wirePayload));

    await receive.handleMessageReceived({
      fromRelayId: senderRelayId,
      messageId: msgId,
      encryptedMessage: Buffer.from(encrypted).toString('hex'),
    });

    expect(toastError).not.toHaveBeenCalled();
    // Positive check, not just "no rejection toast" — that alone wouldn't
    // distinguish real success from an unrelated silent failure.
    expect(state.messages.get(senderRelayId)?.[0]?.text).toBe(text);
  });

  it('rejects a message whose signature does not match (tampered content)', async () => {
    const senderIdentity = generateKeypair();
    const senderRelayId = 'relay:sender-test-2';
    const receiverIdentity = generateKeypair();
    const senderSigningKeypair = deriveSigningKeypair(senderIdentity.privateKey);

    const dict = makeDict();
    const senderSharedSecret = computeSharedSecret(senderIdentity.privateKey, receiverIdentity.publicKey);
    const senderRole = deriveSessionRole(senderIdentity.publicKey, receiverIdentity.publicKey);
    const senderSession = new Session(senderSharedSecret, dict, 1, senderRole);

    const receiverSharedSecret = computeSharedSecret(receiverIdentity.privateKey, senderIdentity.publicKey);
    const receiverRole = deriveSessionRole(receiverIdentity.publicKey, senderIdentity.publicKey);
    const receiverSession = new Session(receiverSharedSecret, dict, 1, receiverRole);

    const { receive, shared, state } = makeHarness([
      { id: senderRelayId, relayId: senderRelayId, name: 'Sender', messages: [] },
    ]);
    shared.sessionsRef.current.set(senderRelayId, {
      relayId: senderRelayId,
      session: receiverSession,
      publicKeyHex: Buffer.from(senderIdentity.publicKey).toString('hex'),
      signingPublicKeyHex: Buffer.from(senderSigningKeypair.publicKey).toString('hex'),
    });

    const msgId = 'msg-2';
    const signed = await signMessage(msgId, 'original text', senderRelayId, senderSigningKeypair.privateKey);
    // Tamper: encrypt different text than what was signed.
    const wirePayload = JSON.stringify({ type: 'text', text: 'TAMPERED', sig: signed.signature, sigTs: signed.timestamp });
    const encrypted = senderSession.encrypt(new TextEncoder().encode(wirePayload));

    await receive.handleMessageReceived({
      fromRelayId: senderRelayId,
      messageId: msgId,
      encryptedMessage: Buffer.from(encrypted).toString('hex'),
    });

    expect(toastError).toHaveBeenCalledWith('Message rejected', expect.stringContaining('failed signature verification'));
  });

  it('holds a signed message un-ACKed (does not drop or reject it) when the session has no signingPublicKeyHex on file yet', async () => {
    // Superseded behavior: this used to reject+toast immediately, since an
    // unverifiable signed message looked indistinguishable from a forged
    // one. But a missing signingPublicKeyHex is also exactly what a message
    // arriving before key exchange completes looks like — treating that as
    // a hard rejection meant a real race condition could drop a legitimate
    // message. receive.ts now holds it un-ACKed and kicks a key exchange,
    // so the relay keeps redelivering until the signing key arrives and the
    // message can actually be verified. See receive.ts's "NEVER DROP+ACK AN
    // UNVERIFIABLE SIGNED MESSAGE" comment.
    const senderIdentity = generateKeypair();
    const senderRelayId = 'relay:sender-test-3';
    const receiverIdentity = generateKeypair();
    const senderSigningKeypair = deriveSigningKeypair(senderIdentity.privateKey);

    const dict = makeDict();
    const senderSharedSecret = computeSharedSecret(senderIdentity.privateKey, receiverIdentity.publicKey);
    const senderRole = deriveSessionRole(senderIdentity.publicKey, receiverIdentity.publicKey);
    const senderSession = new Session(senderSharedSecret, dict, 1, senderRole);

    const receiverSharedSecret = computeSharedSecret(receiverIdentity.privateKey, senderIdentity.publicKey);
    const receiverRole = deriveSessionRole(receiverIdentity.publicKey, senderIdentity.publicKey);
    const receiverSession = new Session(receiverSharedSecret, dict, 1, receiverRole);

    const { receive, shared, initiateKeyExchange } = makeHarness([
      { id: senderRelayId, relayId: senderRelayId, name: 'Sender', messages: [] },
    ]);
    shared.sessionsRef.current.set(senderRelayId, {
      relayId: senderRelayId,
      session: receiverSession,
      publicKeyHex: Buffer.from(senderIdentity.publicKey).toString('hex'),
      // signingPublicKeyHex intentionally absent — e.g. a session cached
      // from before this field was rolled out, or a message racing ahead
      // of key exchange.
    });

    const msgId = 'msg-3';
    const signed = await signMessage(msgId, 'hello', senderRelayId, senderSigningKeypair.privateKey);
    const wirePayload = JSON.stringify({ type: 'text', text: 'hello', sig: signed.signature, sigTs: signed.timestamp });
    const encrypted = senderSession.encrypt(new TextEncoder().encode(wirePayload));

    await receive.handleMessageReceived({
      fromRelayId: senderRelayId,
      messageId: msgId,
      encryptedMessage: Buffer.from(encrypted).toString('hex'),
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(initiateKeyExchange).toHaveBeenCalledWith(senderRelayId, '');
    const held = shared.pendingEncryptedRef.current.get(senderRelayId);
    expect(held).toHaveLength(1);
    expect(held?.[0].msg.messageId).toBe(msgId);
  });
});
