/**
 * Coverage for lib/messaging/send.ts's useMessageSend — previously zero
 * direct unit tests (round-6 audit, LOW finding #8). Focuses on the
 * highest-value contracts: the guard clauses (init/identity/ws/self-
 * message), the three distinct send paths (offline-queue, no-session-yet,
 * established-session) each producing the right optimistic message status
 * and touching the right ref/queue, and sendFile's size/self-send guards
 * and its single-queued-file-per-contact limit.
 *
 * Crypto/signing/persistence dependencies are mocked — this module's own
 * job is orchestration (which queue, which status, which ws call), not
 * cryptographic correctness, which belongs to (and is tested by) the
 * modules it calls into.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type {
  SharedMessagingRefs,
  SharedMessagingState,
  MessageWithStatus,
} from '../hooks/messaging-types';
import type { Contact } from '../mock-data';

const { toastError, normalizeUserId, persistMessage, saveRatchetState } = vi.hoisted(() => ({
  toastError: vi.fn(),
  normalizeUserId: vi.fn(async (_id: string) => null as string | null),
  persistMessage: vi.fn(async () => {}),
  saveRatchetState: vi.fn(),
}));

vi.mock('@/components/ToastNotification', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/messaging/username-lookup', () => ({ normalizeUserId }));
vi.mock('@/lib/messaging/ephemeral-contacts', () => ({ isEphemeralContact: vi.fn(() => false) }));
vi.mock('@/lib/messaging/message-persistence', () => ({ persistMessage }));
vi.mock('@/lib/messaging/ghost-mode', () => ({ computeExpiresAt: vi.fn(() => undefined) }));
vi.mock('@/lib/crypto/message-signing', () => ({
  deriveSigningKeypair: vi.fn(() => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) })),
  signMessage: vi.fn(async () => ({ signature: 'sig', timestamp: 1234 })),
}));
vi.mock('@/lib/messaging/contact-key-cache', () => ({
  loadContactPublicKey: vi.fn(() => undefined),
  saveRatchetState,
}));

import { useMessageSend } from '../messaging/send';

const ME = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';
const PEER = 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb';

function makeShared(overrides: Partial<SharedMessagingRefs> = {}): SharedMessagingRefs {
  return {
    wsRef: { current: { isReady: () => true, sendMessage: vi.fn() } as any },
    sessionsRef: { current: new Map() },
    identityRef: { current: { relayId: ME, privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) } },
    dictRef: { current: new Uint8Array([1, 2, 3]) },
    pendingMessagesRef: { current: new Map() },
    reconnectQueueRef: { current: [] },
    pendingFilesRef: { current: new Map() },
    keyExchangeInitiatedRef: { current: new Set() },
    contactsRef: { current: [] },
    groupsRef: { current: [] },
    sentMessagesRef: { current: new Map() },
    keyExchangeTimeoutsRef: { current: new Map() },
    handleMessageReceivedRef: { current: null },
    keyExchangeLastResponseRef: { current: new Map() },
    pendingEncryptedRef: { current: new Map() },
    pendingPqSecretsRef: { current: new Map() },
    initializationCompleteRef: { current: true },
    ...overrides,
  } as SharedMessagingRefs;
}

function makeState(contacts: Contact[] = []): SharedMessagingState & { messagesByContact: () => Map<string, MessageWithStatus[]> } {
  let messages = new Map<string, MessageWithStatus[]>();
  let contactsState = contacts;
  return {
    messages,
    setMessages: vi.fn((updater: any) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    }),
    contacts: contactsState,
    setContacts: vi.fn((updater: any) => {
      contactsState = typeof updater === 'function' ? updater(contactsState) : updater;
    }),
    groups: [],
    setGroups: vi.fn(),
    messagesByContact: () => messages,
  };
}

beforeEach(() => {
  normalizeUserId.mockReset();
  normalizeUserId.mockResolvedValue(null);
});

function setup(sharedOverrides: Partial<SharedMessagingRefs> = {}, contacts: Contact[] = []) {
  const shared = makeShared(sharedOverrides);
  const state = makeState(contacts);
  const initiateKeyExchange = vi.fn();
  const updateSessionStats = vi.fn();
  const { result } = renderHook(() =>
    useMessageSend({ shared, state, initiateKeyExchange, updateSessionStats })
  );
  return { result, shared, state, initiateKeyExchange, updateSessionStats };
}

describe('sendMessage — guard clauses', () => {
  it('throws when initialization is not complete', async () => {
    const { result } = setup({ initializationCompleteRef: { current: false } });
    await expect(result.current.sendMessage(PEER, 'hi')).rejects.toThrow(/still initializing/);
  });

  it('throws when the websocket client is not initialized', async () => {
    const { result } = setup({ wsRef: { current: null } });
    await expect(result.current.sendMessage(PEER, 'hi')).rejects.toThrow(/WebSocket client not initialized/);
  });

  it('throws when identity is not loaded', async () => {
    const { result } = setup({ identityRef: { current: null } });
    await expect(result.current.sendMessage(PEER, 'hi')).rejects.toThrow(/identity not loaded/);
  });

  it('refuses to send a message to yourself by relayId', async () => {
    const { result } = setup();
    await expect(result.current.sendMessage(ME, 'hi')).rejects.toThrow(/cannot message yourself/);
  });

  it('refuses to send when the resolved contact entry turns out to be yourself', async () => {
    const contacts: Contact[] = [{ id: 'contact-1', relayId: ME } as Contact];
    const { result } = setup({}, contacts);
    await expect(result.current.sendMessage('contact-1', 'hi')).rejects.toThrow(/cannot message yourself/);
  });
});

describe('sendMessage — offline (ws not ready)', () => {
  it('queues onto reconnectQueueRef and shows an optimistic "pending" message', async () => {
    const { result, shared, state } = setup({
      wsRef: { current: { isReady: () => false, sendMessage: vi.fn() } as any },
    });

    const sent = await result.current.sendMessage(PEER, 'hello offline');
    expect(sent.status).toBe('pending');
    expect(shared.reconnectQueueRef.current).toHaveLength(1);
    expect(shared.reconnectQueueRef.current[0]).toMatchObject({ contactRelayId: PEER, text: 'hello offline' });
    expect(state.messagesByContact().get(PEER)?.[0].status).toBe('pending');
  });
});

describe('sendMessage — no session yet', () => {
  it('queues the message, initiates key exchange, and shows an optimistic "sending" message', async () => {
    const { result, shared, state, initiateKeyExchange } = setup();

    const sent = await result.current.sendMessage(PEER, 'hello no session');
    expect(sent.status).toBe('sending');
    expect(initiateKeyExchange).toHaveBeenCalledWith(PEER, '');
    expect(shared.pendingMessagesRef.current.get(PEER)).toHaveLength(1);
    expect(shared.pendingMessagesRef.current.get(PEER)![0]).toMatchObject({ relayId: PEER, text: 'hello no session' });
    expect(shared.sentMessagesRef.current.has(sent.id)).toBe(true);
    expect(state.messagesByContact().get(PEER)?.[0].status).toBe('sending');
  });

  it('a second queued message to the same not-yet-connected contact appends rather than overwriting the first', async () => {
    const { result, shared } = setup();
    await result.current.sendMessage(PEER, 'first');
    await result.current.sendMessage(PEER, 'second');
    expect(shared.pendingMessagesRef.current.get(PEER)).toHaveLength(2);
  });
});

describe('sendMessage — established session', () => {
  function sessionFixture() {
    return {
      relayId: PEER,
      publicKeyHex: 'ab'.repeat(32),
      session: {
        encryptAsync: vi.fn(async (bytes: Uint8Array) => new Uint8Array([...bytes.slice(0, 4), 9, 9])),
        serialize: vi.fn(() => ({ ratchet: 'state' })),
      },
    } as any;
  }

  it('encrypts, sends over the websocket, persists, and marks the message "sending"', async () => {
    const sessionData = sessionFixture();
    const { result, shared, state, updateSessionStats } = setup({
      sessionsRef: { current: new Map([[PEER, sessionData]]) },
    });

    const sent = await result.current.sendMessage(PEER, 'hello established');
    expect(sent.status).toBe('sending');
    expect((shared.wsRef.current as any).sendMessage).toHaveBeenCalledTimes(1);
    expect((shared.wsRef.current as any).sendMessage).toHaveBeenCalledWith(PEER, expect.any(String), sent.id);
    expect(sessionData.session.encryptAsync).toHaveBeenCalledTimes(1);
    expect(saveRatchetState).toHaveBeenCalledWith(PEER, { ratchet: 'state' });
    expect(persistMessage).toHaveBeenCalledTimes(1);
    expect(updateSessionStats).toHaveBeenCalledWith(PEER);
    expect(state.messagesByContact().get(PEER)?.[0].status).toBe('sending');
  });

  it('splits text longer than the per-segment limit into multiple sends under one logical message', async () => {
    const sessionData = sessionFixture();
    const { result, shared } = setup({ sessionsRef: { current: new Map([[PEER, sessionData]]) } });

    const longText = 'x'.repeat(8000 * 2 + 500); // 3 segments
    const sent = await result.current.sendMessage(PEER, longText);
    expect(sessionData.session.encryptAsync).toHaveBeenCalledTimes(3);
    expect((shared.wsRef.current as any).sendMessage).toHaveBeenCalledTimes(3);
    expect(sent.text).toBe(longText); // one logical message, full text preserved in local state
  });
});

describe('sendFile — guard clauses', () => {
  it('rejects a file over the size cap without touching the websocket', async () => {
    const { result, shared } = setup();
    const big = new File([new Uint8Array(1)], 'big.bin', { type: 'application/octet-stream' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });

    await expect(result.current.sendFile(PEER, big)).rejects.toThrow(/too large/);
    expect((shared.wsRef.current as any).sendMessage).not.toHaveBeenCalled();
  });

  it('refuses to send a file to yourself', async () => {
    const { result } = setup();
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    await expect(result.current.sendFile(ME, file)).rejects.toThrow(/cannot send files to yourself/);
  });
});

describe('sendFile — no session yet', () => {
  it('queues the file and initiates key exchange', async () => {
    const { result, shared, initiateKeyExchange } = setup();
    const file = new File(['hello world'], 'a.txt', { type: 'text/plain' });

    const optimistic = await result.current.sendFile(PEER, file);
    expect(optimistic.status).toBe('sending');
    expect(initiateKeyExchange).toHaveBeenCalledWith(PEER, '');
    expect(shared.pendingFilesRef.current.has(PEER)).toBe(true);
  });

  it('refuses a second concurrent file to the same contact while one is already queued', async () => {
    const { result } = setup();
    const fileA = new File(['a'], 'a.txt', { type: 'text/plain' });
    const fileB = new File(['b'], 'b.txt', { type: 'text/plain' });

    await result.current.sendFile(PEER, fileA);
    await expect(result.current.sendFile(PEER, fileB)).rejects.toThrow(/already queued/);
  });
});
