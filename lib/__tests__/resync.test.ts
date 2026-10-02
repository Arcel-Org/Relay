/**
 * @vitest-environment node
 *
 * Coverage for lib/messaging/resync.ts — the authenticated ratchet-resync
 * escape hatch. Uses fake-indexeddb (matching contact-key-cache-ratchet-
 * clear.test.ts's convention) since contact-key-cache.ts's persistence is
 * exercised for real, not mocked.
 *
 * node environment (not the project default jsdom): message-signing.ts
 * round-trips signatures through Node's Buffer.from(hex), and @noble/curves'
 * instanceof Uint8Array checks fail across jsdom's separate Uint8Array realm
 * — same reasoning as message-signing.test.ts. useCallback/useRef are
 * mocked to plain-object/passthrough equivalents (same technique as
 * use-group-messaging-governance.test.ts) so the hook can be invoked
 * directly without a component tree, which a Node environment can't provide.
 *
 * The final test is the actual regression proof this feature exists for:
 * a genuine two-party round trip (Bob detects repeated decrypt failures,
 * sends a signed resync_request; Alice validates it, clears her state,
 * responds, and drives a fresh key exchange; Bob validates the response and
 * clears his own state too) — not just that each function individually
 * doesn't throw.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useRef: (init: unknown) => ({ current: init }),
  };
});

import { initStorage, clearAllStorage } from '../db/relay-store';
import { useResync } from '../messaging/resync';
import { deriveSigningKeypair, signMessage } from '../crypto/message-signing';
import { saveContactPublicKey } from '../messaging/contact-key-cache';
import { toHex } from '../crypto/hex-utils';

const ALICE_ID = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';
const BOB_ID = 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb';

function ref<T>(current: T) {
  return { current };
}

function makeIdentity(relayId: string) {
  const privateKey = new Uint8Array(32).fill(relayId === ALICE_ID ? 1 : 2);
  const publicKey = new Uint8Array(32).fill(relayId === ALICE_ID ? 3 : 4); // unused by resync.ts itself
  return { privateKey, publicKey, relayId };
}

function makeShared(overrides: { ws?: any; identity?: any; sessions?: Map<string, any> } = {}) {
  const ws = overrides.ws ?? { sendRaw: vi.fn() };
  const identity = overrides.identity ?? makeIdentity(ALICE_ID);
  const sessions = overrides.sessions ?? new Map();
  return {
    wsRef: ref(ws),
    identityRef: ref(identity),
    sessionsRef: ref(sessions),
  } as any;
}

function makeState() {
  let messages = new Map<string, any[]>();
  return {
    setMessages: (updater: any) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    },
    getMessages: () => messages,
  } as any;
}

beforeEach(async () => {
  await initStorage(new Uint8Array(32).fill(9));
  await clearAllStorage();
});

describe('initiateResync — trigger threshold and rate limit', () => {
  it('does not send anything on the first failure — only records it', () => {
    const shared = makeShared();
    const state = makeState();
    const initiateKeyExchange = vi.fn();
    const { initiateResync } = useResync({ shared, state, initiateKeyExchange });

    initiateResync(BOB_ID);
    expect(shared.wsRef.current.sendRaw).not.toHaveBeenCalled();
  });

  it('sends a signed resync_request on the 2nd failure within the window', async () => {
    const shared = makeShared();
    const state = makeState();
    const initiateKeyExchange = vi.fn();
    const { initiateResync } = useResync({ shared, state, initiateKeyExchange });

    initiateResync(BOB_ID);
    initiateResync(BOB_ID);
    await new Promise((r) => setTimeout(r, 0)); // let the async sign+send settle

    expect(shared.wsRef.current.sendRaw).toHaveBeenCalledTimes(1);
    const sent = shared.wsRef.current.sendRaw.mock.calls[0][0];
    expect(sent.type).toBe('resync_request');
    expect(sent.toRelayId).toBe(BOB_ID);
    expect(sent.fromRelayId).toBe(ALICE_ID);
    expect(typeof sent.nonce).toBe('string');
    expect(typeof sent.signature).toBe('string');
  });

  it('does not send a second resync_request to the same contact within the rate-limit window', async () => {
    const shared = makeShared();
    const state = makeState();
    const initiateKeyExchange = vi.fn();
    const { initiateResync } = useResync({ shared, state, initiateKeyExchange });

    initiateResync(BOB_ID);
    initiateResync(BOB_ID);
    await new Promise((r) => setTimeout(r, 0));
    expect(shared.wsRef.current.sendRaw).toHaveBeenCalledTimes(1);

    // More failures right away — still within the 5-minute rate limit.
    initiateResync(BOB_ID);
    initiateResync(BOB_ID);
    await new Promise((r) => setTimeout(r, 0));
    expect(shared.wsRef.current.sendRaw).toHaveBeenCalledTimes(1);
  });
});

describe('handleResyncRequestReceived — validation', () => {
  it('ignores a request with no pinned signing key on file for the sender', async () => {
    const shared = makeShared({ identity: makeIdentity(BOB_ID) });
    const state = makeState();
    const initiateKeyExchange = vi.fn();
    const { handleResyncRequestReceived } = useResync({ shared, state, initiateKeyExchange });

    await handleResyncRequestReceived({
      type: 'resync_request', fromRelayId: ALICE_ID, toRelayId: BOB_ID,
      nonce: 'n1', timestamp: Date.now(), signature: 'deadbeef',
    });

    expect(initiateKeyExchange).not.toHaveBeenCalled();
    expect(shared.wsRef.current.sendRaw).not.toHaveBeenCalled();
  });

  it('rejects a request with an invalid signature even when a signing key IS pinned', async () => {
    const aliceSigning = deriveSigningKeypair(makeIdentity(ALICE_ID).privateKey);
    saveContactPublicKey(ALICE_ID, 'aa'.repeat(32), undefined, toHex(aliceSigning.publicKey));

    const shared = makeShared({ identity: makeIdentity(BOB_ID) });
    const state = makeState();
    const initiateKeyExchange = vi.fn();
    const { handleResyncRequestReceived } = useResync({ shared, state, initiateKeyExchange });

    await handleResyncRequestReceived({
      type: 'resync_request', fromRelayId: ALICE_ID, toRelayId: BOB_ID,
      nonce: 'n1', timestamp: Date.now(), signature: 'not-a-real-signature',
    });

    expect(initiateKeyExchange).not.toHaveBeenCalled();
  });

  it('rate-limits accepted resyncs per contact — a second genuinely valid request right after an accepted one is ignored', async () => {
    const aliceIdentity = makeIdentity(ALICE_ID);
    const aliceSigning = deriveSigningKeypair(aliceIdentity.privateKey);
    saveContactPublicKey(ALICE_ID, 'aa'.repeat(32), undefined, toHex(aliceSigning.publicKey));

    async function signedRequest(nonce: string) {
      const signed = await signMessage(nonce, `resync_request:${BOB_ID}`, ALICE_ID, aliceSigning.privateKey);
      return {
        type: 'resync_request', fromRelayId: ALICE_ID, toRelayId: BOB_ID,
        nonce, timestamp: signed.timestamp, signature: signed.signature,
      };
    }

    const shared = makeShared({ identity: makeIdentity(BOB_ID) });
    const state = makeState();
    const initiateKeyExchange = vi.fn();
    const { handleResyncRequestReceived } = useResync({ shared, state, initiateKeyExchange });

    await handleResyncRequestReceived(await signedRequest('n1'));
    expect(initiateKeyExchange).toHaveBeenCalledTimes(1);

    // A second, independently valid (fresh nonce, fresh signature) request
    // from the same contact, moments later — a hostile-but-legitimately-
    // signed sender's only lever, since they can't forge the signature
    // itself. Must be ignored by the incoming rate limit even though it
    // would otherwise pass every other check.
    await handleResyncRequestReceived(await signedRequest('n2'));
    expect(initiateKeyExchange).toHaveBeenCalledTimes(1);
  });

  it('rejects a validly-signed resync_response relabeled as a resync_request by a hostile relay', async () => {
    // A genuinely valid resync_response's signature must not also verify as
    // a resync_request — otherwise a relay could relabel one in transit and
    // trigger the wrong handler (request-received also drives a fresh key
    // exchange; response-received deliberately doesn't, to avoid both sides
    // racing to initiate at once).
    const aliceIdentity = makeIdentity(ALICE_ID);
    const aliceSigning = deriveSigningKeypair(aliceIdentity.privateKey);
    saveContactPublicKey(ALICE_ID, 'aa'.repeat(32), undefined, toHex(aliceSigning.publicKey));

    const signed = await signMessage('n1', `resync_response:${BOB_ID}`, ALICE_ID, aliceSigning.privateKey);
    const relabeled = {
      type: 'resync_request', fromRelayId: ALICE_ID, toRelayId: BOB_ID,
      nonce: 'n1', timestamp: signed.timestamp, signature: signed.signature,
    };

    const shared = makeShared({ identity: makeIdentity(BOB_ID) });
    const state = makeState();
    const initiateKeyExchange = vi.fn();
    const { handleResyncRequestReceived } = useResync({ shared, state, initiateKeyExchange });

    await handleResyncRequestReceived(relabeled);
    expect(initiateKeyExchange).not.toHaveBeenCalled();
    expect(shared.wsRef.current.sendRaw).not.toHaveBeenCalled();
  });
});

describe('end-to-end: repeated decrypt failure recovers via a real two-party resync round trip', () => {
  it('Bob detects failures, Alice validates + clears + responds + re-keys, Bob validates the response and clears too', async () => {
    const aliceIdentity = makeIdentity(ALICE_ID);
    const bobIdentity = makeIdentity(BOB_ID);
    const aliceSigning = deriveSigningKeypair(aliceIdentity.privateKey);
    const bobSigning = deriveSigningKeypair(bobIdentity.privateKey);

    // Each side pins the OTHER's signing key, as key-exchange.ts already
    // does today for every established session.
    saveContactPublicKey(BOB_ID, 'bb'.repeat(32), undefined, toHex(bobSigning.publicKey));
    saveContactPublicKey(ALICE_ID, 'aa'.repeat(32), undefined, toHex(aliceSigning.publicKey));

    const aliceSessions = new Map<string, any>([[BOB_ID, { relayId: BOB_ID, session: {}, publicKeyHex: 'bb'.repeat(32) }]]);
    const bobSessions = new Map<string, any>([[ALICE_ID, { relayId: ALICE_ID, session: {}, publicKeyHex: 'aa'.repeat(32) }]]);

    const aliceShared = makeShared({ identity: aliceIdentity, sessions: aliceSessions, ws: { sendRaw: vi.fn() } });
    const bobShared = makeShared({ identity: bobIdentity, sessions: bobSessions, ws: { sendRaw: vi.fn() } });
    const aliceState = makeState();
    const bobState = makeState();
    const aliceInitiateKX = vi.fn();
    const bobInitiateKX = vi.fn();

    const alice = useResync({ shared: aliceShared, state: aliceState, initiateKeyExchange: aliceInitiateKX });
    const bob = useResync({ shared: bobShared, state: bobState, initiateKeyExchange: bobInitiateKX });

    // Bob's ratchet has desynced with Alice's (simulated elsewhere at the
    // Session/relay-crypto layer — see relay-crypto.test.ts's own desync
    // test for the underlying "crash rolls the chain back" mechanics this
    // is recovering from). receive.ts calls this on every decrypt failure.
    bob.initiateResync(ALICE_ID);
    bob.initiateResync(ALICE_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(bobShared.wsRef.current.sendRaw).toHaveBeenCalledTimes(1);
    const resyncRequest = bobShared.wsRef.current.sendRaw.mock.calls[0][0];
    expect(resyncRequest.type).toBe('resync_request');

    // The relay delivers it to Alice verbatim (server overwrites fromRelayId
    // with the authenticated sender's real relayId, which is already correct
    // here since Bob's own resync.ts set it that way).
    await alice.handleResyncRequestReceived(resyncRequest);

    // Alice cleared her side and responded.
    expect(aliceSessions.has(BOB_ID)).toBe(false);
    expect(aliceShared.wsRef.current.sendRaw).toHaveBeenCalledTimes(1);
    const resyncResponse = aliceShared.wsRef.current.sendRaw.mock.calls[0][0];
    expect(resyncResponse.type).toBe('resync_response');
    expect(aliceInitiateKX).toHaveBeenCalledWith(BOB_ID, expect.any(String), undefined, { bypassCooldown: true });
    // A visible, honest system message — no silent security state change.
    expect(aliceState.getMessages().get(BOB_ID)?.[0]?.text).toMatch(/resync/i);

    // Bob receives the response and clears his side too.
    await bob.handleResyncResponseReceived(resyncResponse);
    expect(bobSessions.has(ALICE_ID)).toBe(false);
    // Only the request-receiver (Alice) drives a fresh key exchange —
    // the requester (Bob) waits for Alice's forthcoming key_exchange
    // instead, avoiding both sides racing to initiate at once.
    expect(bobInitiateKX).not.toHaveBeenCalled();
    expect(bobState.getMessages().get(ALICE_ID)?.[0]?.text).toMatch(/resync/i);
  });
});
