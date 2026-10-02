/**
 * Regression/coverage for lib/messaging/burn.ts — the mutual "burn
 * conversation" flow had zero test coverage despite being a security- and
 * data-integrity-sensitive deletion path: handleBurnRequest is the one place
 * a REMOTE, untrusted peer can trigger a local data wipe, and handleBurnConfirm
 * is the one place a cryptographic receipt is verified to prove a burn_confirm
 * really came from the conversation's peer rather than just the relay's say-so.
 *
 * useCallback is mocked to a passthrough (same technique as
 * receive-signature-verification.test.ts) so the hook can be called directly
 * with plain object refs, no component tree required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
  };
});

const deleteConversation = vi.fn(async () => {});
vi.mock('@/lib/db/relay-store', () => ({ deleteConversation }));

const toastWarning = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@/components/ToastNotification', () => ({
  toast: { warning: (...args: unknown[]) => toastWarning(...args), success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

import { useBurnRequests } from '../messaging/burn';
import { Session, generateKeypair, computeSharedSecret, deriveSessionRole, buildDictionary } from '../crypto/relay-crypto';

function ref<T>(current: T) {
  return { current };
}

// A dynamic import()'s resolution chain can take more ticks than a plain
// microtask flush accounts for (module instantiation on first resolution) —
// a macrotask boundary reliably drains it.
async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeSessionPair() {
  const dict = buildDictionary(['burn.ts regression test dictionary']);
  const a = generateKeypair();
  const b = generateKeypair();
  const sharedA = computeSharedSecret(a.privateKey, b.publicKey);
  const roleA = deriveSessionRole(a.publicKey, b.publicKey);
  const sharedB = computeSharedSecret(b.privateKey, a.publicKey);
  const roleB = deriveSessionRole(b.publicKey, a.publicKey);
  return {
    sessionA: new Session(sharedA, dict, 1, roleA),
    sessionB: new Session(sharedB, dict, 1, roleB),
  };
}

function makeHarness(initialContacts: any[] = []) {
  let messages = new Map<string, any[]>();

  const ws = {
    sendRaw: vi.fn(),
    sendBurnConfirm: vi.fn(),
    isReady: vi.fn(() => true),
  };

  const shared = {
    wsRef: ref<any>(ws),
    identityRef: ref<any>({ relayId: 'relay:me' }),
    sessionsRef: ref(new Map<string, any>()),
    contactsRef: ref(initialContacts),
  };

  const state = {
    setMessages: (updater: any) => { messages = typeof updater === 'function' ? updater(messages) : updater; },
  };

  const hook = useBurnRequests({ shared: shared as any, state: state as any });
  return { ...hook, shared, ws, getMessages: () => messages };
}

beforeEach(() => {
  deleteConversation.mockClear();
  toastWarning.mockClear();
  toastSuccess.mockClear();
});

describe('initiateBurnRequest / confirmBurn (outgoing)', () => {
  it('initiateBurnRequest sends a burn_request over the socket', () => {
    const { initiateBurnRequest, ws } = makeHarness();
    initiateBurnRequest('relay:peer');
    expect(ws.sendRaw).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'burn_request', to: 'relay:peer', fromId: 'relay:me' })
    );
  });

  it('confirmBurn sends burn_confirm, clears local messages, and persists the deletion', async () => {
    const { confirmBurn, ws, getMessages } = makeHarness();
    getMessages().set('relay:peer', [{ id: '1' }]);

    confirmBurn('relay:peer');

    expect(ws.sendRaw).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'burn_confirm', to: 'relay:peer' })
    );
    expect(getMessages().get('relay:peer')).toEqual([]);
    await flushMicrotasks();
    expect(deleteConversation).toHaveBeenCalledWith('relay:peer');
  });
});

describe('handleBurnRequest (incoming, from an untrusted peer)', () => {
  it('ignores a burn_request from someone who is not a contact — no wipe, no confirm sent', async () => {
    const { handleBurnRequest, ws, getMessages } = makeHarness([]);
    getMessages().set('relay:stranger', [{ id: '1' }]);

    handleBurnRequest({ fromRelayId: 'relay:stranger' });
    await flushMicrotasks();

    expect(getMessages().get('relay:stranger')).toEqual([{ id: '1' }]);
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(ws.sendBurnConfirm).not.toHaveBeenCalled();
  });

  it('ignores a burn_request from a blocked contact — no wipe, no confirm sent', async () => {
    const { handleBurnRequest, ws, getMessages } = makeHarness([
      { relayId: 'relay:blocked', blocked: true },
    ]);
    getMessages().set('relay:blocked', [{ id: '1' }]);

    handleBurnRequest({ fromRelayId: 'relay:blocked' });
    await flushMicrotasks();

    expect(getMessages().get('relay:blocked')).toEqual([{ id: '1' }]);
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(ws.sendBurnConfirm).not.toHaveBeenCalled();
  });

  it('honors a burn_request from a real, unblocked contact: wipes, persists, warns, and confirms', async () => {
    const { handleBurnRequest, ws, getMessages } = makeHarness([
      { relayId: 'relay:friend', blocked: false },
    ]);
    getMessages().set('relay:friend', [{ id: '1' }]);

    handleBurnRequest({ fromRelayId: 'relay:friend' });
    await flushMicrotasks();

    expect(getMessages().get('relay:friend')).toEqual([]);
    expect(deleteConversation).toHaveBeenCalledWith('relay:friend');
    expect(toastWarning).toHaveBeenCalled();
    expect(ws.sendBurnConfirm).toHaveBeenCalledWith('relay:friend', undefined);
  });

  it('attaches an encrypted receipt when an active session with the sender exists', async () => {
    const { handleBurnRequest, ws, shared } = makeHarness([
      { relayId: 'relay:friend', blocked: false },
    ]);
    const { sessionA } = makeSessionPair();
    shared.sessionsRef.current.set('relay:friend', { session: sessionA });

    handleBurnRequest({ fromRelayId: 'relay:friend' });
    await flushMicrotasks();

    expect(ws.sendBurnConfirm).toHaveBeenCalledWith('relay:friend', expect.any(String));
    const [, receipt] = ws.sendBurnConfirm.mock.calls[0];
    expect(receipt.length).toBeGreaterThan(0);
  });
});

describe('handleBurnConfirm (incoming confirmation + receipt verification)', () => {
  it('ignores a burn_confirm from someone who is not a contact — no wipe (regression: this used to wipe unconditionally)', async () => {
    const { handleBurnConfirm, getMessages } = makeHarness([]);
    getMessages().set('relay:stranger', [{ id: '1' }]);

    handleBurnConfirm({ fromRelayId: 'relay:stranger' });
    await flushMicrotasks();

    expect(getMessages().get('relay:stranger')).toEqual([{ id: '1' }]);
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('ignores a burn_confirm from a blocked contact', async () => {
    const { handleBurnConfirm, getMessages } = makeHarness([
      { relayId: 'relay:blocked', blocked: true },
    ]);
    getMessages().set('relay:blocked', [{ id: '1' }]);

    handleBurnConfirm({ fromRelayId: 'relay:blocked' });
    await flushMicrotasks();

    expect(getMessages().get('relay:blocked')).toEqual([{ id: '1' }]);
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('clears + persists on a plain burn_confirm from a real contact, with no receipt attached', async () => {
    const { handleBurnConfirm, getMessages } = makeHarness([
      { relayId: 'relay:peer', blocked: false },
    ]);
    getMessages().set('relay:peer', [{ id: '1' }]);

    handleBurnConfirm({ fromRelayId: 'relay:peer' });
    await flushMicrotasks();

    expect(getMessages().get('relay:peer')).toEqual([]);
    expect(deleteConversation).toHaveBeenCalledWith('relay:peer');
  });

  it('reports cryptographic verification success for a receipt encrypted with the real shared session', async () => {
    const { handleBurnConfirm, shared } = makeHarness([
      { relayId: 'relay:peer', blocked: false },
    ]);
    const { sessionA, sessionB } = makeSessionPair();
    // sessionB is "our" side's session with the peer; the peer encrypted the
    // receipt with sessionA (their complementary session over the same
    // shared secret) — mirrors handleBurnRequest's real encrypt call.
    shared.sessionsRef.current.set('relay:peer', { session: sessionB });
    const receiptBytes = sessionA.encrypt(new TextEncoder().encode('burn-receipt:relay:peer:123'));
    const receiptHex = Buffer.from(receiptBytes).toString('hex');

    handleBurnConfirm({ fromRelayId: 'relay:peer', receipt: receiptHex });
    await flushMicrotasks();

    expect(toastSuccess).toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('reports verification failure (not a throw) for a garbage/forged receipt', async () => {
    const { handleBurnConfirm, shared } = makeHarness([
      { relayId: 'relay:peer', blocked: false },
    ]);
    const { sessionB } = makeSessionPair();
    shared.sessionsRef.current.set('relay:peer', { session: sessionB });

    expect(() => handleBurnConfirm({ fromRelayId: 'relay:peer', receipt: 'deadbeef' })).not.toThrow();
    await flushMicrotasks();

    expect(toastWarning).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
