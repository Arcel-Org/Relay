/**
 * @vitest-environment node
 *
 * Coverage for lib/relay/relay-websocket.ts's RelayWebSocketClient —
 * previously zero direct unit tests (round-6 audit, LOW finding #8). Runs
 * against a real local `ws` server (same "verify against real infra, not
 * just mocks" approach used by lib/__tests__/relay-node.test.ts), since this
 * class's whole job is orchestrating a real WebSocket handshake, not just
 * shaping JSON.
 *
 * Node has no global WebSocket (added later than the Node version this repo
 * targets), so `ws`'s client class — which implements the same
 * onopen/onmessage/onclose/onerror + readyState/bufferedAmount surface the
 * browser WebSocket does — is installed as the global before importing the
 * module under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'net';

vi.stubGlobal('WebSocket', NodeWebSocket);

let server: WebSocketServer;
let port: number;

function nextConnection(): Promise<import('ws').WebSocket> {
  return new Promise((resolve) => server.once('connection', resolve));
}

beforeEach(async () => {
  server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'test-ticket' }) })));
  vi.resetModules();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// A relayId derived from a real (fixed) public key hex, matching what
// relayIdFromPublicKeyHex would produce for any 64-hex-char input — the
// exact value doesn't matter to these tests, only that it's deterministic.
const PUBLIC_KEY_HEX = 'ab'.repeat(32);

describe('connect() handshake', () => {
  it('fetches a ws-ticket, sends hello, and resolves once the server is reachable', async () => {
    const { RelayWebSocketClient } = await import('../relay/relay-websocket');
    const client = new RelayWebSocketClient(`ws://localhost:${port}`);

    const connectionPromise = nextConnection();
    const connectedHandler = vi.fn();
    client.on('connected', connectedHandler);

    const helloReceived = new Promise<any>(async (resolve) => {
      const serverSocket = await connectionPromise;
      serverSocket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    });

    await client.connect(PUBLIC_KEY_HEX);
    const hello = await helloReceived;

    expect(hello.type).toBe('hello');
    expect(hello.ticket).toBe('test-ticket');
    expect(typeof hello.relayId).toBe('string');
    expect(connectedHandler).toHaveBeenCalledTimes(1);
    expect(client.isReady()).toBe(true);

    client.disconnect();
  });

  it('emits auth_required and stops trying when the ws-ticket fetch returns 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    const { RelayWebSocketClient } = await import('../relay/relay-websocket');
    const client = new RelayWebSocketClient(`ws://localhost:${port}`);

    const authRequired = vi.fn();
    client.on('auth_required', authRequired);

    await expect(client.connect(PUBLIC_KEY_HEX)).rejects.toThrow(/Session expired/);
    expect(authRequired).toHaveBeenCalledTimes(1);
    expect(client.isReady()).toBe(false);
  });
});

describe('message dispatch', () => {
  it('routes a server-sent frame to the matching event listener', async () => {
    const { RelayWebSocketClient } = await import('../relay/relay-websocket');
    const client = new RelayWebSocketClient(`ws://localhost:${port}`);
    const connectionPromise = nextConnection();

    await client.connect(PUBLIC_KEY_HEX);
    const serverSocket = await connectionPromise;

    const messageHandler = vi.fn();
    client.on('message', messageHandler);

    serverSocket.send(JSON.stringify({ type: 'message', fromRelayId: 'peer-1', encryptedMessage: 'abcd', messageId: 'm1' }));
    await vi.waitFor(() => expect(messageHandler).toHaveBeenCalledTimes(1));
    expect(messageHandler.mock.calls[0][0]).toMatchObject({ fromRelayId: 'peer-1', messageId: 'm1' });

    client.disconnect();
  });

  it('silently drops an unparseable frame instead of throwing', async () => {
    const { RelayWebSocketClient } = await import('../relay/relay-websocket');
    const client = new RelayWebSocketClient(`ws://localhost:${port}`);
    const connectionPromise = nextConnection();
    await client.connect(PUBLIC_KEY_HEX);
    const serverSocket = await connectionPromise;

    const messageHandler = vi.fn();
    client.on('message', messageHandler);
    serverSocket.send('not json at all');

    await new Promise((r) => setTimeout(r, 50));
    expect(messageHandler).not.toHaveBeenCalled();
    expect(client.isReady()).toBe(true); // the bad frame didn't take the connection down

    client.disconnect();
  });
});

describe('message queueing before the connection is ready', () => {
  it('queues sendKeyExchange calls made before connect(), then flushes them right after hello', async () => {
    const { RelayWebSocketClient } = await import('../relay/relay-websocket');
    const client = new RelayWebSocketClient(`ws://localhost:${port}`);

    client.sendKeyExchange('peer-1', 'cd'.repeat(32));

    const connectionPromise = nextConnection();
    const received: any[] = [];
    const framesPromise = (async () => {
      const serverSocket = await connectionPromise;
      await new Promise<void>((resolve) => {
        serverSocket.on('message', (raw) => {
          received.push(JSON.parse(raw.toString()));
          if (received.length >= 2) resolve();
        });
      });
    })();

    await client.connect(PUBLIC_KEY_HEX);
    await framesPromise;

    expect(received.map((f) => f.type)).toEqual(['hello', 'key_exchange']);
    expect(received[1].toRelayId).toBe('peer-1');

    client.disconnect();
  });
});

describe('isReady() / disconnect()', () => {
  it('is false before connecting and before the handshake completes, true once connected, false after disconnect', async () => {
    const { RelayWebSocketClient } = await import('../relay/relay-websocket');
    const client = new RelayWebSocketClient(`ws://localhost:${port}`);
    expect(client.isReady()).toBe(false);

    await client.connect(PUBLIC_KEY_HEX);
    expect(client.isReady()).toBe(true);

    client.disconnect();
    expect(client.isReady()).toBe(false);
  });
});
