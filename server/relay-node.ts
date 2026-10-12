/**
 * Relay Server (Node.js version)
 * 
 * WebSocket relay server for encrypted messaging
 * - Routes messages between clients
 * - Enforces 20-minute TTL for messages
 * - Handles key exchange protocol
 */

// Must be the very first import — this process runs under plain ts-node
// (no Next.js, which loads .env itself via loadEnvConfig) as its own
// standalone entrypoint (PM2's ecosystem.config.js `relay-relay` app, or
// `npm run relay` directly). Without this, SESSION_SECRET/WS_ALLOWED_ORIGINS
// below are read from process.env before anything has ever populated it from
// a real .env file, and this throws at import time in production —
// Docker Compose is unaffected (it sets `env_file: .env`, which injects real
// process env vars directly, no dotenv needed), but the PM2/bare-metal path
// has no equivalent and crash-looped on every boot without this.
import 'dotenv/config';

import * as http from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseRelayMessage } from './relay-schemas';
import { log } from './logger';
import { isSessionValidByHash, touchSessionActivity } from '../lib/db/session-store';
import { initErrorMonitoring, captureException, flushErrorMonitoring } from './error-monitoring';

initErrorMonitoring();

// ─────────────────────────────────────────────────────────────────────────
// AUTH / LIMITS CONFIG
// ─────────────────────────────────────────────────────────────────────────

// Kept local (not imported from lib/env.ts) because this file runs under
// plain ts-node without path-alias resolution — see lib/env.ts for the
// Next.js-side equivalent and the rationale for allowing 'test'/unset too.
const DEV_LIKE_ENVS = new Set([undefined, 'development', 'test']);
const isDevLikeEnv = () => DEV_LIKE_ENVS.has(process.env.NODE_ENV);

const SESSION_SECRET = (() => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    if (!isDevLikeEnv()) {
      throw new Error('SESSION_SECRET is required (>=32 chars) — only development/test may use the insecure dev fallback');
    }
    if (process.env.NODE_ENV === undefined) {
      console.warn(
        '[relay-node] WARNING: SESSION_SECRET not set and NODE_ENV is unset — using a DETERMINISTIC (insecure) ' +
        'dev secret. Set a real SESSION_SECRET and NODE_ENV=production for any non-development deployment.'
      );
    }
    return 'dev-only-session-secret-change-me-in-production!!';
  }
  return s;
})();

const TICKET_LIFETIME_MS = 15 * 60 * 1000;

// Replay-protection: track ticket payloads already consumed within their
// validity window. Entries evicted lazily when a new ticket is checked.
const usedTickets = new Map<string, number>(); // payload → issuedAt (epoch ms)

function pruneUsedTickets(): void {
  const cutoff = Date.now() - TICKET_LIFETIME_MS;
  for (const [payload, issuedAt] of usedTickets) {
    if (issuedAt < cutoff) usedTickets.delete(payload);
  }
}

setInterval(pruneUsedTickets, TICKET_LIFETIME_MS).unref();
// In production WS_ALLOWED_ORIGINS must be set (e.g. "https://relay.arcel.org").
// In development we allow localhost origins by default; never allow an empty list
// in production because that would skip origin checks entirely.
const _rawOrigins = (process.env.WS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const ALLOWED_ORIGINS: string[] =
  !isDevLikeEnv()
    ? _rawOrigins // must be non-empty outside dev/test; enforced below
    : (_rawOrigins.length > 0 ? _rawOrigins : DEV_ORIGINS);

if (!isDevLikeEnv() && ALLOWED_ORIGINS.length === 0) {
  throw new Error('WS_ALLOWED_ORIGINS must be set outside development/test to prevent cross-origin WebSocket attacks');
}
// relay-schemas.ts caps encryptedMessage/blob at 65536 bytes; the ws-frame
// cap must leave headroom for the surrounding JSON envelope (type,
// toRelayId, messageId fields) or a legitimate in-spec message gets a hard
// 1009 disconnect at the transport layer instead of reaching schema
// validation for a graceful rejection. +2KB comfortably covers envelope
// overhead for every message type this server handles.
const MAX_WS_PAYLOAD = 64 * 1024 + 2 * 1024; // 66 KB
const MAX_PENDING_PER_RECIPIENT = 100;
// Per-recipient queues are capped, but `to` is client-supplied and never
// validated against a real user registry — nothing previously bounded the
// number of DISTINCT recipient keys. One authenticated connection could
// address messages to any number of made-up relayIds, each creating a new
// map entry that only gets swept after MESSAGE_TTL_MS. This bounds total
// memory regardless of how many distinct (real or fabricated) recipients
// are addressed.
const MAX_PENDING_RECIPIENTS = 50_000;
const MAX_CONNECTIONS = parseInt(process.env.MAX_WS_CONNECTIONS || '10000', 10);

// Per-connection token bucket rate limit. There was previously no throttle
// at all on the WS message pipeline (HTTP routes got one via
// lib/rate-limit.ts, this path didn't) — without it a single authenticated
// connection can flood the message handler at wire speed with no cap.
//
// Sustained rate (30/sec) and burst (100) are sized against real traffic
// patterns, not just "one message at a time":
//  - A group chat member doing simultaneous typing-indicator + message +
//    read-receipt + reaction traffic is nowhere near 30/sec sustained.
//  - A reconnect flushes the client's queued backlog (lib/relay-websocket.ts
//    _flushQueue) essentially all at once with no pacing — a user who was
//    offline for a while composing/retrying several messages could
//    plausibly queue a few dozen frames.
//  - WebRTC ICE gathering can emit many candidates in a short window, and in
//    a multi-party call each candidate is relayed once per peer (call_ice
//    fan-out), so a 4-5 person call's connection setup can burst well past
//    a handful of control messages within a second or two, especially
//    layered on top of ordinary chat traffic during the same window.
// A tighter burst of 40 was found to trip on the reconnect-flush + ICE-fanout
// cases above and silently drop a message (the handler replies with an error
// and does not queue/retry it). 100 gives real usage comfortable headroom
// while still capping an abusive connection to 30 msg/sec sustained — far
// below anything a legitimate client needs long-term.
const WS_MESSAGE_RATE_PER_SEC = 30;
const WS_MESSAGE_BURST = 100;

// Heartbeat: Cloudflare (and many other reverse proxies) silently closes a
// WebSocket connection after ~100s with no data flowing in either
// direction. The relay protocol had no application/protocol-level keepalive
// at all, so an idle-but-connected client (no new messages, no typing) would
// get dropped by the proxy well before either side noticed. Standard `ws`
// heartbeat pattern: ping every 30s, terminate any connection that didn't
// answer the *previous* ping. WebSocket ping/pong is handled by the browser
// itself (no client-side code needed) — the pong reply is enough to reset
// Cloudflare's idle timer for both directions.
const WS_HEARTBEAT_INTERVAL_MS = 30_000;

// A socket that never sends 'hello' never enters the `clients` map, so it
// must not be allowed to sit open indefinitely just by answering WS pings
// (which any bare/scripted client does automatically, with no auth). Close
// any connection that hasn't authenticated within this window so unbounded
// unauthenticated connections can't exhaust file descriptors/memory.
//
// The real client (lib/relay-websocket.ts) does an additional authenticated
// HTTP round-trip (POST /api/auth/ws-ticket — itself rate-limited and
// DB-backed) after the socket opens and before it sends 'hello'. 30s gives
// that sequence real margin under high latency, a cold start, or a mass-
// reconnect event without meaningfully weakening the DoS protection above.
const HELLO_TIMEOUT_MS = 30_000;

/**
 * Verify the HMAC signature and structure of a WS ticket. This alone is
 * NOT sufficient to authenticate a connection — it only proves the
 * ticket was minted by the server within its 15-minute lifetime. The
 * ticket is also bound to the session that minted it (via a hash of the
 * session token, never the raw token itself); callers must additionally
 * confirm that session is still live via `isSessionValidByHash` so a
 * revoked session can't keep using tickets it already obtained.
 */
function verifyTicketSignature(ticket: string): { relayId: string; sessionHash: string } | null {
  try {
    const dot = ticket.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = ticket.slice(0, dot);
    const sig = ticket.slice(dot + 1);
    const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    const sigBuf = Buffer.from(sig, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    const decoded = Buffer.from(payload, 'base64url').toString();
    // Payload is `relayId:issuedAt:sessionHash`. Parsed from the right so
    // this still works regardless of whether relayId itself ever contains a
    // colon (today's format doesn't, but nothing here should assume that).
    const parts = decoded.split(':');
    if (parts.length < 3) return null;
    const sessionHash = parts.pop() as string;
    const issuedAtStr = parts.pop() as string;
    const relayId = parts.join(':');
    const issuedAt = parseInt(issuedAtStr, 10);
    if (!relayId || isNaN(issuedAt) || Date.now() - issuedAt > TICKET_LIFETIME_MS) return null;
    // Replay prevention: each ticket payload may only be consumed once
    pruneUsedTickets();
    if (usedTickets.has(payload)) return null;
    usedTickets.set(payload, issuedAt);
    return { relayId, sessionHash };
  } catch {
    return null;
  }
}

/**
 * Full ticket verification: signature/structure/replay checks plus a
 * live lookup confirming the minting session hasn't been revoked (e.g.
 * via logout) since the ticket was issued.
 */
async function verifyTicket(ticket: string): Promise<{ relayId: string; sessionHash: string } | null> {
  const parsed = verifyTicketSignature(ticket);
  if (!parsed) return null;
  const sessionLive = await isSessionValidByHash(parsed.sessionHash, parsed.relayId);
  if (!sessionLive) return null;
  return parsed;
}


// ─────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────

interface ClientConnection {
  relayId: string;
  socket: WebSocket;
  connectedAt: number;
  // Hash of the session token that authenticated this connection (never the
  // raw token — see verifyTicketSignature). Kept so the periodic
  // revalidation sweep (revalidateActiveSessions) can re-check session
  // liveness/idle-timeout without needing anything else from the client.
  sessionHash: string;
  // Client-requested opt-out of presence broadcast (Settings' "Show online
  // status" toggle). Purely a courtesy — the relay still knows this relayId
  // is connected (it must, to route messages), this only suppresses telling
  // OTHER clients about it.
  hidePresence: boolean;
}

interface Message {
  type: 'message' | 'key_exchange' | 'ack' | 'delivered' | 'pending' | 'purge_notice' | 'hello' | 'error' | string;
  from?: string;
  // Canonical incoming message fields (sent by relay-websocket.ts client)
  toRelayId?: string;
  encryptedMessage?: string;
  messageId?: string;
  // Key exchange fields
  relayId?: string;
  publicKey?: string;
  to?: string;       // used in key_exchange
  expiresAt?: number;
  sentAt?: number;
  purgedAt?: number;
  msgId?: string;    // used in delivered/pending acknowledgements
  [key: string]: any;
}

interface PendingChatMessage {
  id: string;
  from: string;
  to: string;
  kind?: 'message'; // absent on entries stored before `kind` existed — treated as 'message'
  blob: string;
  storedAt: number;
  expiresAt: number;
  attemptCount: number;
}

// key_exchange frames were previously never queued for an offline recipient
// at all (unlike regular messages) — the client gives up waiting after
// ~48s and deletes the pending first message it was for, so the very
// first message to a contact who happens to be offline at that exact
// moment silently never establishes a session. Queuing them the same way
// regular messages already are closes that gap. There's no ack protocol
// for key exchanges (the initial, non-queued send path doesn't wait for
// one either — see handleKeyExchange), so a queued one is just removed
// once a flush attempt's sendToClient() call succeeds, not gated on any
// client acknowledgement.
interface PendingKeyExchange {
  id: string;
  from: string;
  to: string;
  kind: 'key_exchange';
  publicKey: string;
  signingPublicKey?: string;
  pqPublicKey?: string;
  pqCipherText?: string;
  storedAt: number;
  expiresAt: number;
  attemptCount: number;
}

type PendingMessage = PendingChatMessage | PendingKeyExchange;

// ─────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────

const MESSAGE_TTL_MS = (Number(process.env.MESSAGE_TTL_MINUTES) || 20) * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 1000; // 5 seconds
// RELAY_PORT is authoritative (matches server.js's WS-proxy target and
// app/api/status/route.ts's reachability check) — PORT is accepted only as
// a fallback for anyone relying on the old behavior. The Dockerfile's base
// image sets a global `ENV PORT=3000` for the app service; since both
// services build from the same image, this relay process previously read
// that SAME PORT var by default and needed an explicit per-service
// docker-compose.yml override (PORT=8080) just to not collide with the
// app's own port. Reading RELAY_PORT first removes the need for that
// workaround — see docker-compose.yml's relay service, updated to match.
const PORT = process.env.RELAY_PORT
  ? parseInt(process.env.RELAY_PORT)
  : process.env.PORT
    ? parseInt(process.env.PORT)
    : 8080;

// Cover traffic: dummy frames sent to every connected client at randomized
// intervals so a network observer watching ciphertext timing/size can't
// distinguish "actively chatting" from "idle but connected". Frames are
// tagged `cover_traffic` and the client drops them before they ever reach
// app code (see lib/relay-websocket.ts _handleMessage).
const COVER_TRAFFIC_ENABLED = process.env.COVER_TRAFFIC_ENABLED !== 'false';
const COVER_TRAFFIC_MIN_MS = 15_000;
const COVER_TRAFFIC_MAX_MS = 45_000;
const COVER_TRAFFIC_MIN_BYTES = 64;
const COVER_TRAFFIC_MAX_BYTES = 1024;

// ─────────────────────────────────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────────────────────────────────

const clients = new Map<string, ClientConnection>(); // relayId -> connection
const pendingMessages = new Map<string, PendingMessage[]>(); // to -> messages
// Maps msgId → time added (ms). Used for deduplication and bounded memory:
// pending-message cleanups delete their IDs; immediately-delivered IDs are
// purged after MESSAGE_TTL_MS so un-ACK'd messages can't leak memory forever.
const messageIds = new Map<string, number>();
// Duplicate-delivery check keyed by (from, to, msgId), not bare msgId.
// `from` is the authenticated connection's own relayId (never client-
// supplied), so this can't collide across different senders — but msgId
// itself IS client-supplied with no uniqueness/format enforcement, so the
// bare-msgId dedup this used to piggyback on `messageIds` let any
// authenticated client pre-seed an entry for an ID it expects a DIFFERENT
// sender to use for a DIFFERENT recipient, silently causing that unrelated,
// legitimate message to be dropped as a "duplicate". Kept as a separate map
// (rather than changing messageIds' key format) since messageIds is also
// keyed by bare msgId for ack/eviction/TTL bookkeeping elsewhere, which
// don't have easy access to the original (from, to) pair at every call site.
const dedupKeys = new Map<string, number>();
const coverTrafficTimers = new Map<string, ReturnType<typeof setTimeout>>(); // relayId -> pending timer

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function sendToClient(relayId: string, message: Message): boolean {
  const client = clients.get(relayId);
  if (client && client.socket.readyState === WebSocket.OPEN) {
    try {
      client.socket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      log.error(`Failed to send to ${relayId}:`, err);
      return false;
    }
  }
  return false;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Presence broadcast batching: broadcasting to every connected client on
// every single connect/disconnect is O(n) work per event, so under
// connection churn (many clients connecting/disconnecting in a short
// window — e.g. a burst of reconnects) that becomes O(n) work n times over,
// i.e. quadratic aggregate CPU on the single-threaded event loop. Coalesce
// events that land within the same short window into one pass over
// `clients` instead of one pass per event.
const PRESENCE_FLUSH_MS = 100;
// A relayId flapping online/offline several times within one flush window
// (a reconnect storm is exactly repeated connect/disconnect) only needs its
// FINAL state broadcast, not every intermediate one — a Map keyed by
// relayId coalesces that automatically (last write wins) in O(1) per queued
// event, instead of an array that would need an O(n) scan per push to dedupe.
let pendingPresenceEvents = new Map<string, boolean>(); // relayId -> online
let presenceFlushTimer: ReturnType<typeof setTimeout> | null = null;

// The flush itself used to be one fully-synchronous nested loop over every
// (client × event) pair — under a reconnect storm (relay restart, OOM,
// network blip) both dimensions can be in the thousands at once, making a
// single flush block the event loop — and everyone's message delivery and
// heartbeats along with it — for the entire duration of that one pass, at
// exactly the moment responsiveness matters most (mass reconnection).
// Chunking the outer (client) loop across ticks bounds how much synchronous
// work any single tick does; for the normal case (small client count) this
// still completes in one synchronous pass with no added latency, since the
// chunk boundary is never reached.
const PRESENCE_FLUSH_CLIENTS_PER_TICK = 200;

function broadcastPresenceEventsChunked(events: Array<{ relayId: string; online: boolean }>): void {
  // Precompute each event's JSON payload once — it's identical for every
  // receiving client, so stringifying it per-client-per-event (the
  // previous behavior) redid the same serialization work N times over.
  const payloads = events.map((e) => ({
    relayId: e.relayId,
    message: JSON.stringify({ type: 'presence', relayId: e.relayId, online: e.online }),
  }));
  const clientEntries = Array.from(clients.values());
  let index = 0;
  function processBatch() {
    const end = Math.min(index + PRESENCE_FLUSH_CLIENTS_PER_TICK, clientEntries.length);
    for (; index < end; index++) {
      const client = clientEntries[index];
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      for (const { relayId, message } of payloads) {
        if (relayId === client.relayId) continue;
        // A readyState-OPEN check doesn't guarantee send() can't still
        // throw (e.g. a compression-extension error, or the socket tearing
        // down between the check and this call) — sendToClient() already
        // guards this same call for exactly that reason; matching it here
        // so one bad socket mid-broadcast can't abort presence delivery to
        // every client after it in this batch.
        try {
          client.socket.send(message);
        } catch (err) {
          log.error(`[Presence] Failed to send to ${client.relayId}:`, err);
        }
      }
    }
    if (index < clientEntries.length) setImmediate(processBatch);
  }
  processBatch();
}

// Same reasoning as PRESENCE_FLUSH_CLIENTS_PER_TICK above, but for the
// OTHER half of the presence O(n²) problem: handleHello's own online-list
// send to the connecting client. Unlike the presence broadcast (fanning one
// batch of events out to all clients), this runs once PER CONNECT and
// iterates the full `clients` map each time — so under a mass-reconnect
// (relay restart, network blip) at MAX_WS_CONNECTIONS scale, total
// synchronous work across the storm scales with (connecting clients) ×
// (existing clients), with no event-loop yielding at all before this fix.
// Chunking bounds how much of that one connecting client's online-list any
// single tick sends; for the normal case (small client count) this still
// completes in one synchronous pass, since the chunk boundary is never hit.
const ONLINE_LIST_CLIENTS_PER_TICK = 200;

function sendOnlineListChunked(connectingRelayId: string, socket: WebSocket): void {
  const clientEntries = Array.from(clients.entries());
  let index = 0;
  function processBatch() {
    const end = Math.min(index + ONLINE_LIST_CLIENTS_PER_TICK, clientEntries.length);
    for (; index < end; index++) {
      const [id, client] = clientEntries[index];
      if (id === connectingRelayId || client.hidePresence) continue;
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(JSON.stringify({ type: 'presence', relayId: id, online: true }));
      } catch (err) {
        log.error(`[Presence] Failed to send online-list entry for ${id} to ${connectingRelayId}:`, err);
      }
    }
    if (index < clientEntries.length) setImmediate(processBatch);
  }
  processBatch();
}

function flushPresenceEvents(): void {
  const events = Array.from(pendingPresenceEvents, ([relayId, online]) => ({ relayId, online }));
  pendingPresenceEvents = new Map();
  presenceFlushTimer = null;
  if (events.length === 0) return;
  broadcastPresenceEventsChunked(events);
}

function queuePresenceEvent(relayId: string, online: boolean): void {
  pendingPresenceEvents.set(relayId, online);
  if (!presenceFlushTimer) {
    presenceFlushTimer = setTimeout(flushPresenceEvents, PRESENCE_FLUSH_MS);
    presenceFlushTimer.unref?.();
  }
}

function clearCoverTraffic(relayId: string): void {
  const timer = coverTrafficTimers.get(relayId);
  if (timer) clearTimeout(timer);
  coverTrafficTimers.delete(relayId);
}

function scheduleCoverTraffic(relayId: string): void {
  if (!COVER_TRAFFIC_ENABLED) return;
  clearCoverTraffic(relayId);

  const delay = randomInt(COVER_TRAFFIC_MIN_MS, COVER_TRAFFIC_MAX_MS);
  const timer = setTimeout(() => {
    const client = clients.get(relayId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      coverTrafficTimers.delete(relayId);
      return;
    }
    const pad = bytesToHex(randomBytes(randomInt(COVER_TRAFFIC_MIN_BYTES, COVER_TRAFFIC_MAX_BYTES)));
    try {
      client.socket.send(JSON.stringify({ type: 'cover_traffic', pad }));
    } catch (err) {
      log.error(`[CoverTraffic] Failed to send to ${relayId}:`, err);
    }
    scheduleCoverTraffic(relayId); // reschedule with a fresh random delay
  }, delay);

  coverTrafficTimers.set(relayId, timer);
}

// Notifies the ORIGINAL SENDER that a queued message will never be
// delivered, so the client can flip it from "pending"/"sending" to an
// explicit error instead of leaving it stuck forever. key_exchange has no
// per-message UI status (same reasoning as the 'delivered' notice in
// flushPendingMessages/handleMessage), so it's skipped there.
function notifyPurged(msg: PendingMessage): void {
  if (msg.kind === 'key_exchange') return;
  sendToClient(msg.from, {
    type: 'purge_notice',
    messageId: msg.id,
    purgedAt: Date.now(),
  });
}

function storePendingMessage(msg: PendingMessage): void {
  if (!pendingMessages.has(msg.to)) {
    if (pendingMessages.size >= MAX_PENDING_RECIPIENTS) {
      log.warn(`[PENDING] Dropping message to new recipient key ${msg.to} — MAX_PENDING_RECIPIENTS (${MAX_PENDING_RECIPIENTS}) reached`);
      notifyPurged(msg);
      return;
    }
    pendingMessages.set(msg.to, []);
  }
  const queue = pendingMessages.get(msg.to)!;
  if (queue.length >= MAX_PENDING_PER_RECIPIENT) {
    // Evict oldest to bound memory.
    const dropped = queue.shift();
    if (dropped) {
      messageIds.delete(dropped.id);
      notifyPurged(dropped);
    }
  }
  queue.push(msg);
}

function getPendingMessagesForClient(relayId: string): PendingMessage[] {
  return pendingMessages.get(relayId) || [];
}

function removePendingMessage(to: string, msgId: string): void {
  const messages = pendingMessages.get(to);
  if (messages) {
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx >= 0) {
      messages.splice(idx, 1);
    }
  }
}

function cleanupExpiredMessages(): void {
  const now = Date.now();
  for (const [to, messages] of pendingMessages) {
    const remaining: PendingMessage[] = [];

    for (const msg of messages) {
      if (msg.expiresAt > now) {
        remaining.push(msg);
      } else {
        log.debug(`[PURGE] Message ${msg.id} from ${msg.from} to ${to} expired after ${msg.attemptCount} attempts`);
        messageIds.delete(msg.id);
        notifyPurged(msg);
      }
    }

    if (remaining.length > 0) {
      pendingMessages.set(to, remaining);
    } else {
      pendingMessages.delete(to);
    }
  }
  // Purge immediately-delivered message IDs that were never ACK'd. Without
  // this, a sender who drops the connection before ACKing leaks the ID forever.
  const ttlCutoff = now - MESSAGE_TTL_MS;
  for (const [id, addedAt] of messageIds) {
    if (addedAt < ttlCutoff) messageIds.delete(id);
  }
  for (const [key, addedAt] of dedupKeys) {
    if (addedAt < ttlCutoff) dedupKeys.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLERS
// ─────────────────────────────────────────────────────────────────────────

function handleHello(relayId: string, socket: WebSocket, sessionHash: string, hidePresence: boolean): void {
  // Check if client already exists
  if (clients.has(relayId)) {
    const existing = clients.get(relayId);
    if (existing && existing.socket.readyState === WebSocket.OPEN) {
      existing.socket.close(1000, 'Duplicate connection');
    }
  }

  // Register client
  clients.set(relayId, {
    relayId,
    socket,
    connectedAt: Date.now(),
    sessionHash,
    hidePresence,
  });

  // Connecting counts as activity for server-side inactivity-timeout
  // enforcement — see touchSessionActivity's doc comment.
  void touchSessionActivity(sessionHash);

  log.debug(`[CONNECT] ${relayId} connected (total: ${clients.size})`);

  scheduleCoverTraffic(relayId);

  // Broadcast presence: tell everyone this user is online (batched, see
  // queuePresenceEvent) — unless they've opted out via Settings' "Show
  // online status" toggle.
  if (!hidePresence) {
    queuePresenceEvent(relayId, true);
  }

  // Tell the connecting user who else is online — skip anyone who's
  // opted out of presence broadcast themselves. Chunked (see
  // sendOnlineListChunked) so a mass-reconnect doesn't block the event loop.
  sendOnlineListChunked(relayId, socket);

  // Deliver pending messages. Each delivery attempt increments attemptCount;
  // once MAX_DELIVERY_ATTEMPTS is reached the message is dropped to prevent a
  // hostile/flapping recipient from keeping the queue hot (W4).
  const pending = getPendingMessagesForClient(relayId).slice();
  for (const msg of pending) {
    msg.attemptCount += 1;
    if (msg.attemptCount > MAX_DELIVERY_ATTEMPTS) {
      log.debug(`[DROP] Message ${msg.id} exceeded MAX_DELIVERY_ATTEMPTS`);
      removePendingMessage(relayId, msg.id);
      messageIds.delete(msg.id);
      notifyPurged(msg);
      continue;
    }
    const frame =
      msg.kind === 'key_exchange'
        ? {
            type: 'key_exchange' as const,
            fromRelayId: msg.from,
            publicKey: msg.publicKey,
            ...(msg.signingPublicKey ? { signingPublicKey: msg.signingPublicKey } : {}),
            ...(msg.pqPublicKey ? { pqPublicKey: msg.pqPublicKey } : {}),
            ...(msg.pqCipherText ? { pqCipherText: msg.pqCipherText } : {}),
          }
        : {
            type: 'message' as const,
            fromRelayId: msg.from,
            encryptedMessage: msg.blob,
            messageId: msg.id,
          };
    if (sendToClient(relayId, frame)) {
      log.debug(`[DELIVERED] ${msg.kind || 'message'} ${msg.id} delivered on reconnect (attempt ${msg.attemptCount})`);
      removePendingMessage(relayId, msg.id);
      // The immediate-delivery path in handleMessage() sends 'delivered'
      // back to the ORIGINAL SENDER right after a successful send; this
      // flush path (recipient reconnecting later) previously didn't,
      // leaving the sender's UI showing "Sending…" forever for any message
      // that had to be queued. key_exchange has no equivalent concept (the
      // client doesn't show delivery status for it), so this only applies
      // to regular chat messages.
      if (msg.kind !== 'key_exchange') {
        sendToClient(msg.from, { type: 'delivered', messageId: msg.id });
      }
    }
  }
}

function handleKeyExchange(from: string, message: Message): void {
  const { toRelayId: to, publicKey, signingPublicKey, pqPublicKey, pqCipherText } = message;

  if (!to || !publicKey) {
    log.warn(`[KEY_EXCHANGE] Invalid key exchange from ${from} (to=${to}, publicKey=${publicKey ? 'present' : 'missing'})`);
    return;
  }

  // Forward key exchange to recipient.
  // IMPORTANT: use `fromRelayId` (not `from`) — the client expects this field name.
  if (sendToClient(to, {
    type: 'key_exchange',
    fromRelayId: from,
    publicKey,
    ...(signingPublicKey ? { signingPublicKey } : {}),
    ...(pqPublicKey ? { pqPublicKey } : {}),
    ...(pqCipherText ? { pqCipherText } : {}),
  })) {
    log.debug(`[KEY_EXCHANGE] ${from} -> ${to}`);
  } else {
    log.debug(`[KEY_EXCHANGE_QUEUE] ${from} -> ${to} (recipient offline)`);
    const now = Date.now();
    storePendingMessage({
      id: bytesToHex(randomBytes(8)),
      from,
      to,
      kind: 'key_exchange',
      publicKey,
      signingPublicKey,
      pqPublicKey,
      pqCipherText,
      storedAt: now,
      expiresAt: now + MESSAGE_TTL_MS,
      attemptCount: 0,
    });
  }
}

function handleMessage(from: string, message: Message): void {
  const { toRelayId: to, encryptedMessage: blob, messageId: msgId } = message;

  if (!to || !blob || !msgId) {
    log.warn(`[MESSAGE] Invalid message from ${from}`);
    return;
  }

  // Deduplication — scoped to (from, to, msgId); see dedupKeys comment above.
  const dedupKey = `${from}:${to}:${msgId}`;
  if (dedupKeys.has(dedupKey)) {
    log.debug(`[DUPLICATE] Message ${msgId} already processed`);
    return;
  }
  dedupKeys.set(dedupKey, Date.now());
  messageIds.set(msgId, Date.now());

  const now = Date.now();
  const expiresAt = now + MESSAGE_TTL_MS;

  // Try immediate delivery
  if (sendToClient(to, {
    type: 'message',
    fromRelayId: from,
    encryptedMessage: blob,
    messageId: msgId,
  })) {
    log.debug(`[MESSAGE] ${from} -> ${to} (delivered immediately)`);
    // Send delivery notification
    sendToClient(from, {
      type: 'delivered',
      messageId: msgId,
    });
  } else {
    // Queue for later
    log.debug(`[MESSAGE_QUEUE] ${from} -> ${to} (recipient offline, TTL: 20m)`);
    storePendingMessage({
      id: msgId,
      from,
      to,
      blob,
      storedAt: now,
      expiresAt,
      attemptCount: 0,
    });

    // Send pending notification
    sendToClient(from, {
      type: 'pending',
      messageId: msgId,
      expiresAt,
    });
  }
}

function handleAck(from: string, message: Message): void {
  // The real client (RelayWebSocketClient.sendAck) always sends `messageId`,
  // not `msgId` — accept either so acks actually clear the dedup entry.
  const msgId = message.msgId || message.messageId;
  if (!msgId) return;
  log.debug(`[ACK] ${from} acknowledged message ${msgId}`);
  messageIds.delete(msgId);
}

// Handle generic control messages (burn, typing, call signals, etc.)
function handleControlMessage(from: string, message: Message): void {
  const to = message.toRelayId || message.to;
  if (!to) return;

  // Relay control messages to recipient — use fromRelayId so the client
  // can identify the sender consistently.
  const controlMsg = { ...message, fromRelayId: from };
  if (sendToClient(to, controlMsg)) {
    log.debug(`[${message.type.toUpperCase()}] ${from} -> ${to}`);
  } else {
    log.debug(`[${message.type.toUpperCase()}] ${from} -> ${to} (recipient offline)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER
// ─────────────────────────────────────────────────────────────────────────

export const server = http.createServer();

// Node's http.Server and ws's WebSocketServer are both EventEmitters —
// without a listener bound, an emitted 'error' event throws synchronously
// instead of just being ignored, which the process-wide uncaughtException
// handler below (installed further down) then treats as a corrupted-state
// signal and exits the whole process on. A routine, recoverable server-level
// error (e.g. EMFILE from too many open file descriptors during a
// connection flood, a transient ECONNRESET forwarded from the underlying
// socket) would otherwise kill every live connection for every user instead
// of just being logged. These listeners keep such errors non-fatal, matching
// the same "one bad thing shouldn't take down every connected user's
// session" philosophy applied to per-connection message handling below.
server.on('error', (err) => {
  log.error('[Relay] HTTP server error:', err);
  captureException(err);
});

// Only accept WebSocket connections on the root path or /ws.
// Non-relay clients (Next.js HMR, browser extensions, port scanners) that
// somehow reach port 8080 will be rejected before the ws library processes
// their frames — eliminating WS_ERR_INVALID_UTF8 / WS_ERR_INVALID_CLOSE_CODE
// noise from non-relay traffic.
export const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD,
  verifyClient: ({ req }: { req: http.IncomingMessage }) => {
    const path = req.url?.split('?')[0] ?? '/';
    if (path !== '/' && path !== '/ws' && path !== '') return false;

    // Origin allow-list. Browser clients always send Origin; native clients omit it.
    // If Origin is present, it MUST be in the allow-list — no fallthrough when the
    // list is populated.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return false;
    }
    return true;
  },
});

wss.on('error', (err) => {
  log.error('[Relay] WebSocketServer error:', err);
  captureException(err);
});

wss.on('connection', (socket: WebSocket) => {
  // Cap against the total number of open sockets, not just authenticated
  // ones — `clients` only gains an entry once a socket completes 'hello',
  // so capping against clients.size alone leaves unauthenticated
  // connections completely unbounded (W-critical DoS).
  if (wss.clients.size > MAX_CONNECTIONS) {
    socket.close(1013, 'Server at capacity');
    return;
  }
  log.debug('[WS] New connection');

  const clientData: { relayId?: string } = {};
  (socket as any).data = clientData;

  const helloTimeout = setTimeout(() => {
    if (!clientData.relayId) {
      socket.close(1008, 'Hello timeout');
    }
  }, HELLO_TIMEOUT_MS);
  helloTimeout.unref();

  // Heartbeat liveness flag — flipped true on every pong, checked (and reset
  // to false) on every ping tick by the global heartbeat interval below.
  // Stored on the socket itself (rather than a closure var) so the interval,
  // which iterates wss.clients, can read/reset it per-connection.
  (socket as any).isAlive = true;
  socket.on('pong', () => {
    (socket as any).isAlive = true;
  });

  // Per-connection token bucket — the WS pipeline had no rate limit at all
  // (HTTP routes got one in an earlier hardening pass, this didn't): without
  // it, a single authenticated connection can flood the message handler
  // (each frame occupies a pendingMessages slot until the TTL sweep) at wire
  // speed with no throttle.
  let tokens = WS_MESSAGE_BURST;
  let lastRefill = Date.now();
  function takeToken(): boolean {
    const now = Date.now();
    const elapsedSec = (now - lastRefill) / 1000;
    if (elapsedSec > 0) {
      tokens = Math.min(WS_MESSAGE_BURST, tokens + elapsedSec * WS_MESSAGE_RATE_PER_SEC);
      lastRefill = now;
    }
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  socket.on('message', (rawData: RawData) => {
    void (async () => {
    try {
      if (!takeToken()) {
        socket.send(JSON.stringify({ type: 'error', from: 'server', message: 'Rate limit exceeded' }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', from: 'server', message: 'Invalid JSON' }));
        return;
      }
      let data: Message;
      try {
        data = parseRelayMessage(parsed) as Message;
      } catch {
        socket.send(JSON.stringify({ type: 'error', from: 'server', message: 'Invalid message format' }));
        return;
      }
      const relayId = clientData.relayId;

      // Hello message initializes the connection
      if (data.type === 'hello') {
        const id = (data as { relayId: string; ticket?: string }).relayId;
        const ticket = (data as { relayId: string; ticket?: string }).ticket ?? null;
        const hidePresence = !!(data as { hidePresence?: boolean }).hidePresence;
        let verified: { relayId: string; sessionHash: string } | null = null;
        if (ticket) {
          try {
            verified = await verifyTicket(ticket);
          } catch (err) {
            // A storage error here previously propagated up to the generic
            // catch below, which only logs — the socket was left open with
            // no error sent, sitting idle until HELLO_TIMEOUT_MS force-closed
            // it instead of failing fast with a clean auth error.
            log.error('[WS] Ticket verification failed (storage error):', err);
            socket.send(JSON.stringify({
              type: 'error',
              from: 'server',
              message: 'Authentication temporarily unavailable',
            }));
            socket.close(1011, 'Internal error');
            return;
          }
        }
        if (!id || !ticket || !verified || verified.relayId !== id) {
          socket.send(JSON.stringify({
            type: 'error',
            from: 'server',
            message: 'Invalid or missing auth ticket',
          }));
          socket.close(1008, 'Unauthorized');
          return;
        }
        clearTimeout(helloTimeout);
        clientData.relayId = id;
        handleHello(id, socket, verified.sessionHash, hidePresence);
        return;
      }

      // All other messages require initialization
      if (!relayId) {
        socket.send(JSON.stringify({
          type: 'error',
          from: 'server',
          message: 'Not initialized (send hello first)',
        }));
        socket.close(1002, 'Not initialized');
        return;
      }

      // Any authenticated frame counts as activity for server-side
      // inactivity-timeout enforcement (see lib/auth/auto-logout.ts for the
      // client-configured threshold and session-store.ts's isIdleExpired for
      // the check) — independent of the client's own inactivity timer.
      const activeClient = clients.get(relayId);
      if (activeClient) void touchSessionActivity(activeClient.sessionHash);

      // Route message based on type
      switch (data.type) {
        case 'key_exchange':
          handleKeyExchange(relayId, data);
          break;
        case 'message':
          handleMessage(relayId, data);
          break;
        case 'ack':
          handleAck(relayId, data);
          break;
        // Control messages (typing, burns, etc.)
        case 'burn_request':
        case 'burn_confirm':
        case 'resync_request':
        case 'resync_response':
        case 'typing':
        // Call signaling — relay to the peer
        case 'call_offer':
        case 'call_answer':
        case 'call_ice':
        case 'call_ring':
        case 'call_hangup':
        // Reactions, edits, read receipts
        case 'reaction':
        case 'reaction_revoke':
        case 'message_edit':
        case 'read_receipt':
        case 'delivered':
        case 'delete_message':
        case 'call_peers':
          handleControlMessage(relayId, data);
          break;
        default:
          // Forward any unknown message types as control messages if they have a recipient
          if (data.toRelayId || data.to) {
            handleControlMessage(relayId, data);
          } else {
            log.warn(`[MESSAGE] Unknown message type: ${data.type}`);
          }
      }
    } catch (err) {
      log.error('[WS] Error processing message:', err);
    }
    })().catch((err) => {
      log.error('[WS] Unhandled error processing message:', err);
    });
  });

  socket.on('close', () => {
    clearTimeout(helloTimeout);
    const relayId = clientData.relayId;
    // Only remove the map entry if it still points at THIS socket. A
    // reconnect (handleHello) overwrites the entry with a new socket before
    // the old socket's async close event fires; without this check, the old
    // socket's close handler would delete the new, legitimate connection.
    if (relayId && clients.get(relayId)?.socket === socket) {
      const wasHidingPresence = clients.get(relayId)?.hidePresence ?? false;
      clients.delete(relayId);
      clearCoverTraffic(relayId);
      log.debug(`[DISCONNECT] ${relayId} disconnected (total: ${clients.size})`);

      // Broadcast offline presence to remaining clients (batched, see
      // queuePresenceEvent) — unless we never announced them as online in
      // the first place.
      if (!wasHidingPresence) {
        queuePresenceEvent(relayId, false);
      }
    }
  });

  socket.on('error', (err: Error & { code?: string }) => {
    // Protocol-level errors (invalid UTF-8, bad close codes, etc.) usually mean
    // a non-relay client connected by mistake. Log tersely and close cleanly.
    const isFrameError = err.code?.startsWith('WS_ERR_') ?? false;
    if (isFrameError) {
      log.warn(`[WS] Frame error from ${clientData.relayId ?? 'unauthenticated'}: ${err.code}`);
    } else {
      log.error('[WS] Error:', err.message);
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PERIODIC CLEANUP
// ─────────────────────────────────────────────────────────────────────────

setInterval(() => {
  cleanupExpiredMessages();
}, CLEANUP_INTERVAL_MS).unref();

// Heartbeat sweep — see WS_HEARTBEAT_INTERVAL_MS. Pings every connection;
// any connection that hasn't answered the *previous* ping by the time this
// tick runs again is treated as dead and terminated. This both keeps
// Cloudflare-fronted (and similarly idle-timing-out) connections alive and
// reaps genuinely dead sockets (e.g. a client whose machine slept/lost
// network without a clean TCP close) that would otherwise sit in `clients`
// forever.
// Session re-validation: `hello`-time ticket verification is a one-time
// check — nothing else on an already-open socket previously re-confirmed
// the session was still valid, so revoking a session elsewhere (logout-
// everywhere, WebAuthn "revoke", the account-retention prune sweep, or now
// the idle-timeout check in isSessionValidByHash) left the attacker's/
// stale device's live WebSocket working indefinitely — kept alive by the
// heartbeat below — until it happened to drop and try to reconnect (which
// would then correctly fail). Piggybacking this on the existing heartbeat
// tick re-checks every connected client against the same session-store
// index the initial hello check used. Combined with session-store.ts's own
// periodic disk refresh (REFRESH_INTERVAL_MS), this closes a revocation
// made from the separate Next.js app process within roughly one heartbeat
// interval — without a new IPC channel between the two processes, since
// they already share the on-disk session store (see docker-compose.yml).
async function revalidateActiveSessions(): Promise<void> {
  const entries = Array.from(clients.entries());
  await Promise.all(entries.map(async ([relayId, client]) => {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    let stillValid: boolean;
    try {
      stillValid = await isSessionValidByHash(client.sessionHash, relayId);
    } catch (err) {
      // Fail OPEN on a transient lookup error (disk hiccup) — this is a
      // re-check of an already-trusted, already-open connection, not the
      // initial authentication, so a flaky read shouldn't mass-disconnect
      // every active user. A real revocation returns `false` cleanly, not
      // an exception, so this doesn't weaken the actual security check.
      log.error(`[SESSION] Revalidation lookup failed for ${relayId}:`, err);
      return;
    }
    if (!stillValid && clients.get(relayId)?.socket === client.socket) {
      log.debug(`[SESSION] ${relayId} session revoked or idle-expired — closing connection`);
      client.socket.close(4001, 'Session revoked');
    }
  }));
}

const heartbeatInterval = setInterval(() => {
  for (const socket of wss.clients) {
    const s = socket as any;
    if (s.isAlive === false) {
      socket.terminate();
      continue;
    }
    s.isAlive = false;
    // Without this, one socket throwing on ping() (mid-teardown, a
    // transport-level error) would break out of this loop entirely,
    // skipping every remaining socket for this heartbeat tick — they'd
    // then look falsely idle on the next tick since their isAlive flag
    // never got refreshed.
    try {
      socket.ping();
    } catch (err) {
      log.error('[Heartbeat] ping() failed:', err);
    }
  }
  void revalidateActiveSessions();
}, WS_HEARTBEAT_INTERVAL_MS);
heartbeatInterval.unref();

// ─────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────

// Exported so tests can start a real instance on an ephemeral port (pass 0)
// instead of relying on the module-load side effect below, which is skipped
// entirely under NODE_ENV=test (see IS_TEST_ENV guard) so importing this
// file from a test suite doesn't bind PORT or install process-wide signal
// handlers that would tear down the test runner.
export function startServer(port: number = PORT): http.Server {
  server.listen(port, () => {
    log.debug(`\nRelay Server listening on ws://localhost:${port}\n`);
  });
  return server;
}

// Graceful shutdown — Docker/Kubernetes send SIGTERM, not SIGINT; without a
// handler for it Node's default action is an immediate exit, killing every
// in-flight WS connection instead of draining them.
function shutdown(signal: string) {
  log.debug(`\n${signal} received, shutting down...`);
  for (const client of clients.values()) {
    try { client.socket.close(1001, 'Server shutting down'); } catch { /* already closed */ }
  }
  server.close(() => {
    log.debug('Server closed');
    process.exit(0);
  });
  // Force-exit if connections don't drain in time (e.g. a stuck socket).
  setTimeout(() => process.exit(0), 5000).unref();
}

// This module is imported directly (not spawned as a subprocess) by tests
// exercising the real WS server (see lib/__tests__/relay-node.test.ts), so
// the process-level side effects below — binding the default PORT and
// installing signal/exit handlers that would tear down the test runner —
// must not run under the test environment. isDevLikeEnv() already treats
// 'test' as dev-like for the same reason (see SESSION_SECRET/origin setup
// above); production/staging always have NODE_ENV set to something else.
const IS_TEST_ENV = process.env.NODE_ENV === 'test';
if (!IS_TEST_ENV) {
  startServer(PORT);

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A single unhandled throw in a message handler must not take down every
  // connected user's session — log and keep the process alive. An uncaught
  // exception is more likely to indicate corrupted in-memory state, so exit
  // and let the process manager (Docker restart policy/PM2) restart clean.
  process.on('unhandledRejection', (reason) => {
    log.error('[Relay] Unhandled rejection:', reason);
    captureException(reason);
  });
  process.on('uncaughtException', (err) => {
    log.error('[Relay] Uncaught exception, exiting for restart:', err);
    captureException(err);
    // captureException only queues the event — flush before exiting or the
    // report never actually reaches Sentry.
    void flushErrorMonitoring().finally(() => process.exit(1));
  });
}
