/**
 * @vitest-environment node
 *
 * Relay WS server integration tests
 *
 * Starts a real instance of server/relay-node.ts (the actual network-facing
 * relay) on an ephemeral port and drives it with real `ws` WebSocket
 * clients. This is the only automated coverage of the WS auth/schema/
 * rate-limit surface added during the lib/messaging/ split — everything
 * here previously had zero test coverage.
 *
 * Session store + ticket minting follow the same pattern as
 * server-session.test.ts: point SESSION_STORE_DIR at an isolated temp dir
 * and set SESSION_SECRET before dynamically importing anything that reads
 * either at module load time (session-store.ts reads SESSION_STORE_DIR;
 * server/relay-node.ts reads SESSION_SECRET).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHmac } from 'crypto';
import WebSocket from 'ws';
import type { AddressInfo } from 'net';

const TEST_DIR = path.join(os.tmpdir(), `relay-node-test-${process.pid}-${Date.now()}`);
const SESSION_SECRET = 'relay-node-test-session-secret-32chars-min';
process.env.SESSION_STORE_DIR = TEST_DIR;
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.MESSAGE_TTL_MINUTES = '20';
process.env.COVER_TRAFFIC_ENABLED = 'false'; // avoid noisy extra frames during assertions

const sessionStore = await import('../db/session-store');
const { createSession, revokeSession } = sessionStore;

const relayNode = await import('../../server/relay-node');
const { startServer, server } = relayNode;

const TICKET_LIFETIME_MS = 15 * 60 * 1000;

/** Mint a ticket exactly like app/api/auth/ws-ticket/route.ts does. */
function mintTicket(relayId: string, sessionToken: string, issuedAt = Date.now()): string {
  const sessionHash = sessionStore.hashToken(sessionToken);
  const payload = Buffer.from(`${relayId}:${issuedAt}:${sessionHash}`).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

let port: number;
let wsUrl: string;

beforeAll(async () => {
  startServer(0); // ephemeral port
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  wsUrl = `ws://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

/** Open a raw ws connection, resolving once it's open. */
function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Wait for the next message on a socket, parsed as JSON. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Wait for the socket to close, resolving with the close code. */
function nextClose(ws: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Register + authenticate a relayId, returning its open, hello'd socket. */
async function connectAuthenticated(relayId: string): Promise<{ ws: WebSocket; sessionToken: string }> {
  const sessionToken = await createSession(relayId);
  const ticket = mintTicket(relayId, sessionToken);
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'hello', relayId, ticket }));
  // Drain presence broadcasts until nothing else is queued — simplest is to
  // just wait a tick; the hello path doesn't ack explicitly so we only need
  // the socket to be registered server-side before sending further frames.
  await new Promise((r) => setTimeout(r, 50));
  return { ws, sessionToken };
}

describe('relay-node WS server', () => {
  it('rejects a connection that never sends a valid ticket (bogus ticket on hello)', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'hello', relayId: 'relay:bogus000000000', ticket: 'not-a-real-ticket' }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    const code = await nextClose(ws);
    expect(code).toBe(1008); // Unauthorized
  });

  it('rejects a ticket tied to a revoked session', async () => {
    const relayId = 'relay:revokedsession01';
    const sessionToken = await createSession(relayId);
    const ticket = mintTicket(relayId, sessionToken);
    await revokeSession(sessionToken);

    const ws = await connect();
    ws.send(JSON.stringify({ type: 'hello', relayId, ticket }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    const code = await nextClose(ws);
    expect(code).toBe(1008);
  });

  it('rejects an expired ticket', async () => {
    const relayId = 'relay:expiredsession01';
    const sessionToken = await createSession(relayId);
    const staleIssuedAt = Date.now() - TICKET_LIFETIME_MS - 1000;
    const ticket = mintTicket(relayId, sessionToken, staleIssuedAt);

    const ws = await connect();
    ws.send(JSON.stringify({ type: 'hello', relayId, ticket }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    const code = await nextClose(ws);
    expect(code).toBe(1008);
  });

  it('a valid ticket for a mismatched relayId is rejected', async () => {
    const sessionToken = await createSession('relay:realowner000000');
    const ticket = mintTicket('relay:realowner000000', sessionToken);

    const ws = await connect();
    // Claim a different relayId than the one the ticket was minted for.
    ws.send(JSON.stringify({ type: 'hello', relayId: 'relay:impersonator001', ticket }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    const code = await nextClose(ws);
    expect(code).toBe(1008);
  });

  it('accepts a valid ticket and lets the client send authenticated frames', async () => {
    const relayId = 'relay:validclient00001';
    const { ws } = await connectAuthenticated(relayId);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('a malformed frame (fails schema validation) does not crash the server and gets a graceful error', async () => {
    const relayId = 'relay:malformedsender1';
    const { ws } = await connectAuthenticated(relayId);

    // Missing every required field for any known schema.
    ws.send(JSON.stringify({ type: 'message' }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    expect(ws.readyState).toBe(WebSocket.OPEN); // connection survives

    // Server is still healthy for a subsequent, well-formed frame.
    ws.send(JSON.stringify({ type: 'ack', messageId: 'whatever' }));
    // No response expected for a valid ack to a message that was never
    // pending — absence of a crash/close is the assertion. Give it a beat.
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('completely invalid JSON does not crash the server', async () => {
    const relayId = 'relay:invalidjsonsend1';
    const { ws } = await connectAuthenticated(relayId);

    ws.send('{not valid json');
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects an oversized payload at the transport layer (64KB+ cap)', async () => {
    const relayId = 'relay:oversizedsender1';
    const { ws } = await connectAuthenticated(relayId);

    // encryptedMessage cap is 64KB at the schema layer; the transport-level
    // maxPayload is 66KB. Send a frame whose total JSON size blows past
    // that transport cap so it never even reaches schema validation.
    const hugeBlob = 'a'.repeat(70 * 1024);
    const closePromise = nextClose(ws, 3000);
    ws.send(JSON.stringify({ type: 'message', toRelayId: 'relay:someoneelse00001', encryptedMessage: hugeBlob, messageId: 'huge-1' }));
    const code = await closePromise;
    // `ws` closes with 1009 (message too big) when maxPayload is exceeded.
    expect(code).toBe(1009);
  });

  it('per-connection rate limiting kicks in on a fast burst and does not silently process everything', async () => {
    const senderId = 'relay:burstsender00001';
    const recipientId = 'relay:burstrecipient01';
    const { ws: senderWs } = await connectAuthenticated(senderId);
    const { ws: recipientWs } = await connectAuthenticated(recipientId);

    const received: any[] = [];
    const errors: any[] = [];
    recipientWs.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'message') received.push(m);
    });
    senderWs.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'error') errors.push(m);
    });

    // Burst well past WS_MESSAGE_BURST (100) as fast as possible.
    const BURST = 160;
    for (let i = 0; i < BURST; i++) {
      senderWs.send(JSON.stringify({
        type: 'message',
        toRelayId: recipientId,
        encryptedMessage: `blob-${i}`,
        messageId: `burst-${i}`,
      }));
    }

    await new Promise((r) => setTimeout(r, 300));

    // Some frames must have been rejected by the rate limiter — not every
    // one of the 160 rapid-fire frames should have been processed.
    expect(errors.some((e) => /rate limit/i.test(e.message))).toBe(true);
    expect(received.length).toBeLessThan(BURST);
    expect(received.length).toBeGreaterThan(0);

    senderWs.close();
    recipientWs.close();
  });

  it('two authenticated clients complete a key_exchange + message round trip', async () => {
    const aliceId = 'relay:alicefullflow001';
    const bobId = 'relay:bobfullflow00001';
    const { ws: aliceWs } = await connectAuthenticated(aliceId);
    const { ws: bobWs } = await connectAuthenticated(bobId);

    // key_exchange: Alice -> Bob
    const bobKeyExchange = nextMessage(bobWs);
    aliceWs.send(JSON.stringify({
      type: 'key_exchange',
      toRelayId: bobId,
      publicKey: 'deadbeef'.repeat(8),
    }));
    const kx = await bobKeyExchange;
    expect(kx.type).toBe('key_exchange');
    expect(kx.fromRelayId).toBe(aliceId);
    expect(kx.publicKey).toBe('deadbeef'.repeat(8));

    // message: Alice -> Bob, plus a 'delivered' ack back to Alice.
    const bobMessage = nextMessage(bobWs);
    const aliceDelivered = nextMessage(aliceWs);
    aliceWs.send(JSON.stringify({
      type: 'message',
      toRelayId: bobId,
      encryptedMessage: 'cafebabe'.repeat(4),
      messageId: 'roundtrip-msg-1',
    }));

    const deliveredMsg = await bobMessage;
    expect(deliveredMsg.type).toBe('message');
    expect(deliveredMsg.fromRelayId).toBe(aliceId);
    expect(deliveredMsg.encryptedMessage).toBe('cafebabe'.repeat(4));
    expect(deliveredMsg.messageId).toBe('roundtrip-msg-1');

    const deliveredAck = await aliceDelivered;
    expect(deliveredAck.type).toBe('delivered');
    expect(deliveredAck.messageId).toBe('roundtrip-msg-1');

    aliceWs.close();
    bobWs.close();
  });

  it('queues a key_exchange for an offline recipient and flushes it (plus a delivered ack for a queued message) on reconnect', async () => {
    const aliceId = 'relay:alicequeuetest1';
    const bobId = 'relay:bobqueuetest001';
    const { ws: aliceWs } = await connectAuthenticated(aliceId);

    // Bob is offline for both of these — previously key_exchange was
    // silently dropped in this case (unlike regular messages, which already
    // queued correctly), so the very first message to a contact who happens
    // to be offline could never establish a session at all.
    aliceWs.send(JSON.stringify({
      type: 'key_exchange',
      toRelayId: bobId,
      publicKey: 'deadbeef'.repeat(8),
    }));

    const alicePending = nextMessage(aliceWs);
    aliceWs.send(JSON.stringify({
      type: 'message',
      toRelayId: bobId,
      encryptedMessage: 'cafebabe'.repeat(4),
      messageId: 'queued-msg-1',
    }));
    const pendingAck = await alicePending;
    expect(pendingAck.type).toBe('pending');
    expect(pendingAck.messageId).toBe('queued-msg-1');

    // Also start listening for Alice's post-reconnect 'delivered' ack now
    // (before Bob ever connects) — it's only sent once Bob's hello flush
    // succeeds, so there's no risk of missing it by attaching this late.
    const aliceDelivered = nextMessage(aliceWs);

    // Bob connects for the first time. The pending-message flush happens
    // synchronously inside the server's handling of 'hello', which
    // completes well before connectAuthenticated()'s helper-internal 50ms
    // wait returns — attaching a 'message' listener on the returned ws
    // only AFTER that wait is too late to catch frames that already
    // arrived. Attach a listener that collects every frame BEFORE 'hello'
    // is even sent instead, exactly like connectAuthenticated does
    // internally, just observed from outside it this time.
    const sessionToken = await createSession(bobId);
    const ticket = mintTicket(bobId, sessionToken);
    const bobWs = await connect();
    const bobFrames: any[] = [];
    const gotBothFrames = new Promise<void>((resolve) => {
      bobWs.on('message', (raw) => {
        bobFrames.push(JSON.parse(raw.toString()));
        if (bobFrames.length >= 2) resolve();
      });
    });
    bobWs.send(JSON.stringify({ type: 'hello', relayId: bobId, ticket }));
    await Promise.race([
      gotBothFrames,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for flushed frames')), 3000)),
    ]);

    const kxFrame = bobFrames.find((f) => f.type === 'key_exchange');
    const msgFrame = bobFrames.find((f) => f.type === 'message');
    expect(kxFrame).toBeTruthy();
    expect(kxFrame.fromRelayId).toBe(aliceId);
    expect(kxFrame.publicKey).toBe('deadbeef'.repeat(8));
    expect(msgFrame).toBeTruthy();
    expect(msgFrame.fromRelayId).toBe(aliceId);
    expect(msgFrame.messageId).toBe('queued-msg-1');

    // Sender gets 'delivered' once the queued message is flushed to the
    // now-reconnected recipient — previously this never fired for the
    // flush path (only the immediate-delivery path sent it), leaving the
    // sender's UI showing "Sending…" forever for anything that had to queue.
    const deliveredAck = await aliceDelivered;
    expect(deliveredAck.type).toBe('delivered');
    expect(deliveredAck.messageId).toBe('queued-msg-1');

    aliceWs.close();
    bobWs.close();
  });

  it('sends the connecting client a presence:true event for each other online client (chunked online-list)', async () => {
    // Regression test for sendOnlineListChunked — this used to be a plain
    // synchronous for-loop over the full `clients` map on every single
    // connect, making a mass-reconnect O(n²) with no event-loop yielding.
    // Chunking must not change what the connecting client actually receives.
    const carolId = 'relay:onlinelistcarol1';
    const daveId = 'relay:onlinelistdave01';
    const { ws: carolWs } = await connectAuthenticated(carolId);

    const daveSessionToken = await createSession(daveId);
    const daveTicket = mintTicket(daveId, daveSessionToken);
    const daveWs = await connect();
    const daveFrames: any[] = [];
    daveWs.on('message', (raw) => daveFrames.push(JSON.parse(raw.toString())));
    daveWs.send(JSON.stringify({ type: 'hello', relayId: daveId, ticket: daveTicket }));
    await new Promise((r) => setTimeout(r, 150));

    const presenceForCarol = daveFrames.find(
      (f) => f.type === 'presence' && f.relayId === carolId && f.online === true
    );
    expect(presenceForCarol).toBeTruthy();
    // Dave must never receive a presence event about himself from his own
    // connecting online-list.
    expect(daveFrames.some((f) => f.type === 'presence' && f.relayId === daveId)).toBe(false);

    carolWs.close();
    daveWs.close();
  });

  it('sends the sender a purge_notice when a per-recipient pending queue overflows and evicts the oldest message', async () => {
    // Regression test for notifyPurged (server/relay-node.ts's
    // storePendingMessage) — queuing past MAX_PENDING_PER_RECIPIENT (100)
    // silently evicted the oldest queued message with no signal to its
    // sender at all, leaving that message's UI stuck showing "Sending…"/
    // "pending" forever even though the relay had already discarded it.
    const erinId = 'relay:erinpurgetest001';
    const frankId = 'relay:frankpurgetest01'; // never connects — stays offline for this whole test
    const { ws: erinWs } = await connectAuthenticated(erinId);

    const frames: any[] = [];
    erinWs.on('message', (raw) => frames.push(JSON.parse(raw.toString())));

    // Fill the queue to exactly MAX_PENDING_PER_RECIPIENT (100), then send
    // one more — the 101st insert is what triggers the oldest-message
    // eviction (see storePendingMessage's `queue.length >= 100` check).
    // Paced below the connection's own token-bucket rate limit (30/sec
    // sustained, 100 burst — see takeToken()) so none of these 101 sends
    // themselves get rejected as a flood before ever reaching the queue.
    for (let i = 1; i <= 101; i++) {
      erinWs.send(JSON.stringify({
        type: 'message',
        toRelayId: frankId,
        encryptedMessage: 'cafebabe'.repeat(4),
        messageId: `overflow-msg-${i}`,
      }));
      await new Promise((r) => setTimeout(r, 40));
    }

    const deadline = Date.now() + 3000;
    while (!frames.some((f) => f.type === 'purge_notice') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(frames.some((f) => f.type === 'error' && f.message === 'Rate limit exceeded')).toBe(false);

    const purgeNotice = frames.find((f) => f.type === 'purge_notice');
    expect(purgeNotice).toBeTruthy();
    // The very first message sent is the oldest, so it's the one evicted.
    expect(purgeNotice.messageId).toBe('overflow-msg-1');
    expect(typeof purgeNotice.purgedAt).toBe('number');

    erinWs.close();
  }, 10000);
});
