/**
 * Relay WebSocket Client
 *
 * Handles WebSocket connection to relay server
 * - Connection management with exponential backoff
 * - Message queueing
 * - Event emitters for message handling
 */

import { relayIdFromPublicKeyHex } from "@/lib/crypto/relay-id";
import { log } from "@/lib/platform/logger";
import { getBoolSetting } from "@/lib/settings/relay-settings";

// Closed set only — this rides through the relay (and anything terminating
// TLS in front of it) unencrypted, so it must never carry free-form text
// that could leak metadata beyond "why this call ended".
export type CallHangupReason = 'hangup' | 'declined' | 'busy' | 'rejected' | 'missed' | 'timeout';

type EventType =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "auth_required"
  | "error"
  | "hello_ack"
  | "key_exchange"
  | "key_exchange_hint"
  | "message"
  | "ack"
  | "delivered"
  | "pending"
  | "purge_notice"
  | "burn_request"
  | "burn_confirm"
  | "resync_request"
  | "resync_response"
  | "typing"
  | "presence"
  | "read_receipt"
  | "call_offer"
  | "call_answer"
  | "call_ice"
  | "call_hangup"
  | "call_ring"
  | "call_peers"
  | "delete_message";

type EventHandler = (data?: any) => void;

interface PendingMessage {
  type: "message" | "key_exchange" | "ack" | "call_offer" | "call_answer" | "call_ice" | "call_hangup" | "call_ring" | "call_peers";
  data: any;
  timestamp: number;
}

export class RelayWebSocketClient {
  private socket: WebSocket | null = null;
  private url: string;
  private relayId: string | null = null;
  private listeners = new Map<EventType, Set<EventHandler>>();
  private isConnecting = false;
  // Bumped on every _connect() attempt. Handlers on a socket close over the
  // generation they were created with, so if a newer attempt supersedes an
  // older one (e.g. a manual "Retry" racing an already-scheduled automatic
  // reconnect), the older socket's onopen/onmessage/onerror/onclose become
  // no-ops instead of mutating shared state (this.socket/isInitialized) or
  // emitting events out from under the newer connection.
  private connectionGeneration = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Infinity; // Keep retrying indefinitely
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 30000; // Cap at 30 seconds
  private messageQueue: PendingMessage[] = [];
  private isInitialized = false;
  private permanentlyDisconnected = false;

  // Batching: group rapid sends into single frames
  private sendBatchQueue: string[] = [];
  private sendBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BATCH_DELAY_MS = 16; // ~1 frame at 60fps
  private static readonly BACKPRESSURE_THRESHOLD = 65536; // 64KB buffered

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Initialize and connect with relayId
   */
  async connect(publicKeyHex: string): Promise<void> {
    if (this.isConnecting) return;
    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) return;

    // A prior disconnect() (e.g. a manual "Retry") sets this permanently —
    // an explicit connect() call is exactly the signal that we want to be
    // reconnectable again. Without this reset, one manual reconnect earlier
    // in the session silently disables all future automatic reconnects for
    // its remainder (every _scheduleReconnect() call below bails out on
    // this flag).
    this.permanentlyDisconnected = false;
    this.isConnecting = true;

    try {
      // Compute relayId from public key
      this.relayId = relayIdFromPublicKeyHex(publicKeyHex);

      // Create WebSocket connection
      await this._connect();
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
    } catch (err) {
      this.isConnecting = false;
      this._scheduleReconnect();
      throw err;
    }
  }

  private _connect(): Promise<void> {
    const myGeneration = ++this.connectionGeneration;
    const isStale = () => myGeneration !== this.connectionGeneration;

    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.url);

        // Settle exactly once, whichever path gets there first, and always
        // clear the timeout when we do. Previously the 10s timer was cleared
        // as soon as the raw socket opened — but the ticket fetch + hello
        // send that run inside onopen (below) happen AFTER that, with no
        // timeout of their own. If that fetch ever hung (server accepts the
        // TCP/TLS handshake but never answers /api/auth/ws-ticket — a real
        // degraded-network failure mode, not just a dropped connection),
        // this promise never resolved or rejected: isConnecting stayed true
        // forever, silently blocking every future connect()/reconnect call
        // (see the `if (this.isConnecting) return` guard in connect()) with
        // no error ever surfaced to the UI. Keeping the timeout alive across
        // the whole handshake — and rejecting from onclose as a fallback if
        // nothing else has settled — closes that hang.
        let settled = false;
        const settleResolve = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const settleReject = (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(err);
        };

        const timeout = setTimeout(() => {
          log.error("[WS] Connection timeout");
          settleReject(new Error("WebSocket connection timeout"));
          this.socket?.close();
        }, 10000);

        this.socket.onopen = async () => {
          if (isStale()) return;
          log.debug("[WS] Connected");

          // Fetch a short-lived WS auth ticket from the app (requires session).
          let ticket: string | null = null;
          try {
            const res = await fetch('/api/auth/ws-ticket', {
              method: 'POST',
              credentials: 'include',
            });
            // A newer connection attempt may have superseded this one while
            // the ticket fetch was in flight — don't let a stale attempt
            // finish the handshake and clobber the current connection.
            if (isStale()) return;
            if (res.status === 401 || res.status === 403) {
              // Session expired or invalid — stop retrying, tell the app to re-auth.
              log.warn("[WS] Session invalid (ws-ticket returned " + res.status + "); stopping reconnect");
              this.permanentlyDisconnected = true;
              this.socket?.close();
              this.emit("auth_required");
              settleReject(new Error("Session expired"));
              return;
            }
            if (res.ok) {
              const body = await res.json();
              ticket = body.ticket;
            }
          } catch (err) {
            log.error("[WS] Failed to fetch auth ticket:", err);
          }

          if (!ticket) {
            log.error("[WS] No auth ticket; aborting");
            this.socket?.close();
            settleReject(new Error("Missing WS auth ticket"));
            return;
          }

          // Send hello message
          if (this.relayId) {
            try {
              this.socket!.send(JSON.stringify({
                type: "hello",
                relayId: this.relayId,
                ticket,
                // Settings' "Show online status" toggle — server honors this
                // by not broadcasting presence for this connection at all.
                hidePresence: !getBoolSetting('online-status', true),
              }));
              log.debug("[WS] Sent hello message");
              this.isInitialized = true;

              // Flush message queue
              this._flushQueue();

              this.emit("connected");
              settleResolve();
            } catch (err) {
              log.error("[WS] Failed to send hello:", err);
              settleReject(err);
            }
          }
        };

        this.socket.onmessage = (event) => {
          if (isStale()) return;
          try {
            this._handleMessage(event.data);
          } catch (err) {
            log.error("[WS] Error handling message:", err);
          }
        };

        this.socket.onerror = (err) => {
          if (isStale()) return;
          log.error("[WS] Socket error:", err);
          this.emit("error", err);
          if (!this.isInitialized) {
            settleReject(err);
          }
        };

        this.socket.onclose = () => {
          if (isStale()) return;
          // Capture whether this connection was ever fully established before
          // clearing the flag so we can decide who owns the reconnect schedule.
          const wasInitialized = this.isInitialized;
          log.debug("[WS] Socket closed, isInitialized=" + wasInitialized);
          this.isInitialized = false;
          this.emit("disconnected");
          // Fallback settle: if the socket closes before onopen/onerror ever
          // resolved or rejected this promise (e.g. closed synchronously
          // during the handshake), make sure connect() still rejects instead
          // of hanging forever.
          settleReject(new Error("WebSocket closed before handshake completed"));
          // Only reschedule from onclose when the connection WAS open (clean
          // drop or server-side close). For connections that never opened,
          // onerror already rejected the promise and the catch block in
          // _scheduleReconnect's timer will schedule the retry — calling
          // _scheduleReconnect here too would double the attempt counter and
          // eventually create an exponential reconnect storm.
          if (wasInitialized) {
            this._scheduleReconnect();
          }
        };
      } catch (err) {
        log.error("[WS] Failed to create socket:", err);
        reject(err);
      }
    });
  }

  private _scheduleReconnect(): void {
    if (this.permanentlyDisconnected) return;

    this.reconnectAttempts++;
    // After many attempts the delay is already at maxReconnectDelay; cap the
    // exponent so Math.pow doesn't produce Infinity for very large attempt counts.
    const cappedAttempt = Math.min(this.reconnectAttempts, 20);
    const baseDelay = Math.min(
      this.reconnectDelay * Math.pow(1.5, cappedAttempt - 1),
      this.maxReconnectDelay
    );
    // Jitter (+/-20%) — without it, every client computes the identical
    // deterministic delay from the same disconnect event (e.g. a relay
    // restart disconnecting everyone at once), so all of them retry in
    // lockstep waves against the just-restarted server instead of spreading
    // out.
    const delay = baseDelay * (0.8 + Math.random() * 0.4);

    log.debug(
      `[WS] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`
    );
    this.emit("reconnecting");

    setTimeout(async () => {
      if (this.permanentlyDisconnected) return;
      // A manual reconnect (connect(), guarded by the same flag) may already
      // be in flight — without this check, both could call _connect()
      // concurrently and race to own `this.socket`.
      if (this.isConnecting) return;
      if (!this.isInitialized) {
        this.isConnecting = true;
        try {
          if (this.relayId) {
            await this._connect();
            // Only the public connect() entry point reset these on success —
            // an automatic reconnect via THIS path never did, so backoff
            // ratcheted up to maxReconnectDelay after a handful of drop/
            // reconnect cycles and never recovered for the rest of the
            // session, even after a long run of healthy connectivity.
            this.reconnectAttempts = 0;
            this.reconnectDelay = 1000;
          }
        } catch (err) {
          log.error("[WS] Reconnect failed:", err);
          this._scheduleReconnect();
        } finally {
          this.isConnecting = false;
        }
      }
    }, delay);
  }

  private _handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "hello_ack":
          this.emit("hello_ack", message);
          break;
        case "key_exchange":
          this.emit("key_exchange", message);
          break;
        case "key_exchange_hint":
          // A user tried to message us but our session was lost (e.g., page refresh).
          // Only treat as key_exchange if it actually contains a publicKey.
          // Otherwise emit as a separate hint so the app can initiate a fresh exchange.
          log.debug(`[WS] Received key_exchange_hint from ${message.fromRelayId} - re-establishing session`);
          if (message.publicKey) {
            this.emit("key_exchange", message);
          } else {
            this.emit("key_exchange_hint", message);
          }
          break;
        case "message":
          this.emit("message", message);
          break;
        case "ack":
          this.emit("ack", message);
          break;
        case "delivered":
          this.emit("delivered", message);
          break;
        case "pending":
          this.emit("pending", message);
          break;
        case "purge_notice":
          this.emit("purge_notice", message);
          break;
        case "burn_request":
          this.emit("burn_request", message);
          break;
        case "burn_confirm":
          this.emit("burn_confirm", message);
          break;
        case "resync_request":
          this.emit("resync_request", message);
          break;
        case "resync_response":
          this.emit("resync_response", message);
          break;
        case "typing":
          this.emit("typing", message);
          break;
        case "read_receipt":
          this.emit("read_receipt", message);
          break;
        case "presence":
          this.emit("presence", message);
          break;
        case "call_offer":
          this.emit("call_offer", message);
          break;
        case "call_answer":
          this.emit("call_answer", message);
          break;
        case "call_ice":
          this.emit("call_ice", message);
          break;
        case "call_hangup":
          this.emit("call_hangup", message);
          break;
        case "call_ring":
          this.emit("call_ring", message);
          break;
        case "call_peers":
          this.emit("call_peers", message);
          break;
        case "delete_message":
          this.emit("delete_message", message);
          break;
        case "error":
          log.error("[WS] Server error:", message);
          this.emit("error", message);
          break;
        case "cover_traffic":
          // Dummy padding frame from the server to defeat traffic analysis —
          // intentionally dropped here, never reaches app code.
          break;
        default:
          log.warn("[WS] Unknown message type:", message.type);
      }
    } catch (err) {
      log.error("[WS] Error parsing message:", err);
    }
  }

  /**
   * Send key exchange request
   */
  sendKeyExchange(to: string, publicKeyHex: string, pqPublicKeyHex?: string, pqCipherTextHex?: string, signingPublicKeyHex?: string): void {
    const message: any = {
      type: "key_exchange",
      fromRelayId: this.relayId,
      toRelayId: to,
      publicKey: publicKeyHex,
      messageId: `kex_${Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2,'0')).join('')}`,
    };

    // Include PQ data for hybrid key exchange (optional for backward compat)
    if (pqPublicKeyHex) {
      message.pqPublicKey = pqPublicKeyHex;
    }
    if (pqCipherTextHex) {
      message.pqCipherText = pqCipherTextHex;
    }
    if (signingPublicKeyHex) {
      message.signingPublicKey = signingPublicKeyHex;
    }

    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else {
      this.messageQueue.push({
        type: "key_exchange",
        data: message,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Low-level send with backpressure check.
   * Returns true if sent, false if socket buffer is full (message queued instead).
   */
  private sendWithBackpressure(json: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > RelayWebSocketClient.BACKPRESSURE_THRESHOLD) {
      log.warn('[WS] Backpressure: socket buffer full, deferring send');
      this.sendBatchQueue.push(json);
      this.scheduleBatchFlush();
      return false;
    }
    this.socket.send(json);
    return true;
  }

  /**
   * Schedule a batched flush of queued messages (coalesces rapid sends).
   */
  private scheduleBatchFlush(): void {
    if (this.sendBatchTimer) return;
    this.sendBatchTimer = setTimeout(() => {
      this.sendBatchTimer = null;
      const queue = this.sendBatchQueue.splice(0);
      for (const json of queue) {
        if (this.socket?.readyState === WebSocket.OPEN) {
          if (this.socket.bufferedAmount > RelayWebSocketClient.BACKPRESSURE_THRESHOLD) {
            // Still under pressure — re-queue remaining
            this.sendBatchQueue.push(...queue.slice(queue.indexOf(json)));
            this.scheduleBatchFlush();
            return;
          }
          this.socket.send(json);
        } else {
          // Socket disconnected while this batch was waiting — don't drop
          // the message, fall back to the reconnect-safe queue that gets
          // flushed once the connection is re-established.
          try {
            this.messageQueue.push({ type: 'message', data: JSON.parse(json), timestamp: Date.now() });
          } catch {
            log.error('[WS] Failed to re-queue dropped batch message (unparseable)');
          }
        }
      }
    }, RelayWebSocketClient.BATCH_DELAY_MS);
  }

  /**
   * Send encrypted message (uses backpressure-aware sending)
   */
  sendMessage(to: string, blob: string, msgId: string): void {
    const message = {
      type: "message",
      fromRelayId: this.relayId,
      toRelayId: to,
      messageId: msgId,
      encryptedMessage: blob,
    };

    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      this.sendWithBackpressure(JSON.stringify(message));
    } else {
      log.debug(`[WS] Queueing message to ${to} (not ready yet)`);
      this.messageQueue.push({
        type: "message",
        data: message,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Send read receipt to indicate a message was read
   */
  sendReadReceipt(to: string, messageId: string): void {
    const message = {
      type: "read_receipt",
      fromRelayId: this.relayId,
      toRelayId: to,
      messageId,
      readAt: Date.now(),
    };

    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
    // Read receipts are best-effort, don't queue
  }

  /**
   * Send typing indicator
   */
  sendTyping(to: string, isTyping: boolean = true): void {
    const message = {
      type: "typing",
      fromRelayId: this.relayId,
      toRelayId: to,
      isTyping,
    };

    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
    // Typing indicators are best-effort, don't queue
  }

  /**
   * Send acknowledgment
   */
  sendAck(msgId: string): void {
    const message = {
      type: "ack",
      messageId: msgId,  // ✓ Match server expectation: messageId not msgId
    };

    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      log.debug(`[WS] Sending ACK for ${msgId}`);
      this.socket.send(JSON.stringify(message));
    } else {
      // ACKs are best-effort, don't queue
      log.warn("[WS] ACK not sent, connection not ready");
    }
  }

  /**
   * Confirm a burn request — clears conversation on the requesting peer's side
   */
  sendBurnConfirm(to: string, receipt?: string): void {
    const message = {
      type: "burn_confirm",
      fromRelayId: this.relayId,
      toRelayId: to,
      receipt,
    };
    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /**
   * Notify peer that a specific message was deleted
   */
  sendDeleteMessage(to: string, messageId: string): void {
    const message = {
      type: "delete_message",
      fromRelayId: this.relayId,
      toRelayId: to,
      messageId,
    };
    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
    // Best-effort; no queue
  }

  private sendControl(type: PendingMessage['type'], to: string, payload: Record<string, any> = {}): void {
    const message = {
      type,
      fromRelayId: this.relayId,
      toRelayId: to,
      messageId: payload.messageId || `${type}_${Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2,'0')).join('')}`,
      ...payload,
    };

    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }

    this.messageQueue.push({
      type,
      data: message,
      timestamp: Date.now(),
    });
  }

  // offer/answer/candidate are either the real RTC object (no session yet —
  // unencrypted fallback) or an opaque encrypted hex string — see
  // lib/hooks/use-call-signaling.ts's encryptSignalPayload for why.
  sendCallOffer(to: string, offer: RTCSessionDescriptionInit | string, callId: string): void {
    this.sendControl('call_offer', to, { offer, callId });
  }

  sendCallAnswer(to: string, answer: RTCSessionDescriptionInit | string, callId: string): void {
    this.sendControl('call_answer', to, { answer, callId });
  }

  sendCallIce(to: string, candidate: RTCIceCandidateInit | string, callId: string): void {
    this.sendControl('call_ice', to, { candidate, callId });
  }

  sendCallRing(to: string, callId: string): void {
    this.sendControl('call_ring', to, { callId });
  }

  sendCallHangup(to: string, callId: string, reason?: CallHangupReason): void {
    this.sendControl('call_hangup', to, { callId, reason });
  }

  /** Tell a peer about other participants in the same call so they can mesh-connect. */
  sendCallPeers(to: string, callId: string, peerIds: string[]): void {
    this.sendControl('call_peers', to, { callId, peerIds });
  }

  /**
   * Send a raw JSON message through the socket (best-effort, not queued).
   * Used for control messages like burn requests that don't need guaranteed delivery.
   */
  sendRaw(message: Record<string, unknown>): void {
    if (this.isInitialized && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private _flushQueue(): void {
    while (this.messageQueue.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      const { data } = this.messageQueue.shift()!;
      this.socket.send(JSON.stringify(data));
    }
  }

  /**
   * Register event listener
   */
  on(event: EventType, handler: EventHandler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  private emit(event: EventType, data?: any): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          log.error(`[WS] Error in ${event} handler:`, err);
        }
      }
    }
  }

  /**
   * Check if connected and initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Graceful shutdown
   */
  disconnect(): void {
    this.permanentlyDisconnected = true;
    // Invalidate any connect() attempt still in flight (e.g. mid ticket
    // fetch) so its handlers no-op instead of resurrecting a connection
    // this explicit disconnect was meant to tear down.
    this.connectionGeneration++;
    if (this.socket) {
      this.socket.close(1000, "Client disconnect");
      this.socket = null;
    }
    this.isInitialized = false;
    this.messageQueue = [];
  }
}
