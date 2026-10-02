# Arcel Relay Wire Protocol Specification

Version: 1.0
Transport: WebSocket (JSON frames over `ws://` or `wss://`)

---

## 1. Overview

The Arcel relay is a stateless message router for end-to-end encrypted communication. It never decrypts message payloads. All frames are UTF-8 JSON objects with a `type` field that determines the message schema.

The relay server accepts WebSocket connections on the root path (`/`) or `/ws`. All other paths are rejected during the upgrade handshake.

---

## 2. Connection Lifecycle

### 2.1 WebSocket Connect

Clients open a WebSocket connection to the relay endpoint. No query parameters or HTTP headers are required for authentication; identity is established via the `hello` message after the connection is open.

### 2.2 `hello` (client -> server)

The first message a client must send after connecting. It associates the socket with a `relayId`.

```json
{
  "type": "hello",
  "relayId": "a1b2c3d4"
}
```

**Fields:**

| Field     | Type   | Required | Description                              |
|-----------|--------|----------|------------------------------------------|
| `type`    | string | yes      | Must be `"hello"`                        |
| `relayId` | string | yes      | The client's relay identifier (`XXXXXXXX`) |

**Server behavior:**

1. If a connection already exists for the same `relayId`, the existing socket is closed with code `1000` ("Duplicate connection").
2. The new socket is registered in the client map.
3. The server broadcasts a **presence online** notification to all other connected clients.
4. The server sends a **presence online** notification for every already-connected client back to the newly connected client.
5. Any pending (queued) messages for this `relayId` are delivered immediately.

**Error:** If `relayId` is missing, the server responds with an error and closes the socket with code `1002`.

```json
{
  "type": "error",
  "from": "server",
  "message": "Missing relayId"
}
```

### 2.3 Presence Notifications (server -> client)

Sent automatically when any client connects or disconnects.

```json
{
  "type": "presence",
  "relayId": "a1b2c3d4",
  "online": true
}
```

| Field     | Type    | Description                                  |
|-----------|---------|----------------------------------------------|
| `type`    | string  | `"presence"`                                 |
| `relayId` | string  | The relay ID whose status changed            |
| `online`  | boolean | `true` if online, `false` if disconnected    |

### 2.4 Disconnection

When a WebSocket closes, the server:

1. Removes the client from the connection map.
2. Broadcasts a **presence offline** notification (`online: false`) to all remaining clients.

### 2.5 Initialization Requirement

All messages except `hello` require prior initialization. If a client sends any other message type before `hello`, the server responds with an error and closes the socket with code `1002`:

```json
{
  "type": "error",
  "from": "server",
  "message": "Not initialized (send hello first)"
}
```

---

## 3. Key Exchange Protocol

### 3.1 `key_exchange` (client -> server -> client)

Used to establish a shared secret between two peers via X25519 Diffie-Hellman key exchange.

**Client sends:**

```json
{
  "type": "key_exchange",
  "toRelayId": "recipient1",
  "publicKey": "abcdef0123456789...64hex"
}
```

| Field       | Type   | Required | Description                               |
|-------------|--------|----------|-------------------------------------------|
| `type`      | string | yes      | `"key_exchange"`                          |
| `toRelayId` | string | yes      | The recipient's relay ID                  |
| `publicKey` | string | yes      | The sender's ephemeral public key (hex)   |

**Server relays to recipient:**

```json
{
  "type": "key_exchange",
  "fromRelayId": "sender01",
  "publicKey": "abcdef0123456789...64hex"
}
```

If the recipient is offline, the key exchange is logged but not queued (key exchanges are not persisted).

---

## 4. Message Sending and Delivery

### 4.1 `message` (client -> server)

Send an encrypted message to another client.

```json
{
  "type": "message",
  "toRelayId": "recipient1",
  "encryptedMessage": "<base64-or-hex-encoded ciphertext>",
  "messageId": "uuid-v4-string"
}
```

| Field              | Type   | Required | Description                              |
|--------------------|--------|----------|------------------------------------------|
| `type`             | string | yes      | `"message"`                              |
| `toRelayId`        | string | yes      | The recipient's relay ID                 |
| `encryptedMessage` | string | yes      | The encrypted payload (opaque to server) |
| `messageId`        | string | yes      | A unique message identifier (UUID)       |

**Server behavior:**

1. **Deduplication:** If `messageId` has been seen before, the message is silently dropped.
2. **Immediate delivery:** If the recipient is connected, the message is forwarded immediately and a `delivered` notification is sent to the sender.
3. **Queuing:** If the recipient is offline, the message is stored in-memory with a TTL (default 20 minutes) and a `pending` notification is sent to the sender.

### 4.2 `message` (server -> recipient)

The forwarded message as received by the recipient:

```json
{
  "type": "message",
  "fromRelayId": "sender01",
  "encryptedMessage": "<ciphertext>",
  "messageId": "uuid-v4-string"
}
```

### 4.3 `delivered` (server -> sender)

Confirms that a message was delivered to the recipient's socket.

```json
{
  "type": "delivered",
  "msgId": "uuid-v4-string"
}
```

### 4.4 `pending` (server -> sender)

Indicates the recipient is offline and the message has been queued.

```json
{
  "type": "pending",
  "msgId": "uuid-v4-string",
  "expiresAt": 1700000000000
}
```

| Field       | Type   | Description                                           |
|-------------|--------|-------------------------------------------------------|
| `msgId`     | string | The `messageId` of the queued message                 |
| `expiresAt` | number | Unix timestamp (ms) when the message will be purged   |

### 4.5 `ack` (client -> server)

Acknowledges receipt of a message. This clears the message from the deduplication set.

```json
{
  "type": "ack",
  "msgId": "uuid-v4-string"
}
```

---

## 5. Message TTL and Expiry

- Messages queued for offline recipients have a default TTL of **20 minutes** (configurable via the `MESSAGE_TTL_MINUTES` environment variable).
- A cleanup sweep runs every **60 seconds**, purging all messages whose `expiresAt` has passed.
- Expired messages are removed from the pending queue and their IDs are removed from the deduplication set.
- Maximum delivery attempts per message: **3** (with a 5-second retry delay).
- The relay does not persist messages to disk. All queued messages are lost on server restart.

---

## 6. Control Messages (Relayed Transparently)

The following message types are forwarded directly from sender to recipient without server-side processing beyond routing. The server adds a `fromRelayId` field to each relayed message.

All control messages require a `toRelayId` (or `to`) field to identify the recipient.

### 6.1 `typing` (client -> server -> client)

Indicates a user is typing.

```json
{
  "type": "typing",
  "toRelayId": "recipient1"
}
```

Relayed as:

```json
{
  "type": "typing",
  "toRelayId": "recipient1",
  "fromRelayId": "sender01"
}
```

### 6.2 `burn_request` / `burn_confirm`

Used for message destruction ("burn") flow.

**burn_request (sender -> server -> recipient):**

```json
{
  "type": "burn_request",
  "toRelayId": "recipient1",
  "messageId": "uuid-of-message-to-burn"
}
```

**burn_confirm (recipient -> server -> sender):**

```json
{
  "type": "burn_confirm",
  "toRelayId": "sender01",
  "messageId": "uuid-of-message-to-burn"
}
```

### 6.3 `read_receipt`

Notifies a peer that messages have been read.

```json
{
  "type": "read_receipt",
  "toRelayId": "sender01",
  "messageId": "uuid-of-read-message"
}
```

### 6.4 `reaction` / `reaction_revoke`

Adds or removes an emoji reaction on a message.

```json
{
  "type": "reaction",
  "toRelayId": "recipient1",
  "messageId": "uuid-of-target-message",
  "emoji": "..."
}
```

```json
{
  "type": "reaction_revoke",
  "toRelayId": "recipient1",
  "messageId": "uuid-of-target-message",
  "emoji": "..."
}
```

### 6.5 `message_edit`

Relays an edited message to the peer.

```json
{
  "type": "message_edit",
  "toRelayId": "recipient1",
  "messageId": "uuid-of-edited-message",
  "encryptedMessage": "<updated ciphertext>"
}
```

### 6.6 `delivered` (client -> server -> client)

A client-to-client delivery receipt (distinct from the server-generated `delivered` in section 4.3). Routed as a control message when sent by a client with a `toRelayId`.

```json
{
  "type": "delivered",
  "toRelayId": "sender01",
  "messageId": "uuid-v4-string"
}
```

---

## 7. Call Signaling

All call signaling messages are relayed transparently between peers. The server does not interpret SDP or ICE payloads.

### 7.1 `call_offer`

Initiates a call with an SDP offer.

```json
{
  "type": "call_offer",
  "toRelayId": "recipient1",
  "sdp": "<SDP offer string>",
  "callId": "uuid"
}
```

### 7.2 `call_answer`

Responds to a call offer with an SDP answer.

```json
{
  "type": "call_answer",
  "toRelayId": "caller01",
  "sdp": "<SDP answer string>",
  "callId": "uuid"
}
```

### 7.3 `call_ice`

Exchanges ICE candidates for NAT traversal.

```json
{
  "type": "call_ice",
  "toRelayId": "peer01",
  "candidate": { "candidate": "...", "sdpMLineIndex": 0 },
  "callId": "uuid"
}
```

### 7.4 `call_ring`

Signals that the callee's device is ringing.

```json
{
  "type": "call_ring",
  "toRelayId": "caller01",
  "callId": "uuid"
}
```

### 7.5 `call_hangup`

Ends or rejects a call.

```json
{
  "type": "call_hangup",
  "toRelayId": "peer01",
  "callId": "uuid"
}
```

### 7.6 `call_peers`

Exchanges peer connection metadata.

```json
{
  "type": "call_peers",
  "toRelayId": "peer01",
  "callId": "uuid"
}
```

---

## 8. Username System

Usernames are handled entirely by the HTTP API (see `API.md`), backed by SQLite — not by the WebSocket relay. There is no `claim_username`/`lookup_username`/`release_username` WS message type.

---

## 9. Error Messages (server -> client)

All server errors follow this format:

```json
{
  "type": "error",
  "from": "server",
  "message": "<human-readable description>"
}
```

Known error messages:

| Condition                   | `message` value                          | Close code |
|-----------------------------|------------------------------------------|------------|
| `hello` missing `relayId`  | `"Missing relayId"`                      | 1002       |
| Message before `hello`     | `"Not initialized (send hello first)"`   | 1002       |

---

## 10. Unknown Message Types

Any message with an unrecognized `type` that includes a `toRelayId` or `to` field is forwarded to the specified recipient as a control message. This allows forward-compatible extension of the protocol without relay changes.

Messages with unknown types and no recipient field are logged and dropped.

---

## 11. WebSocket Close Codes

| Code | Meaning                                      |
|------|----------------------------------------------|
| 1000 | Normal closure (e.g., duplicate connection replaced) |
| 1002 | Protocol error (missing `hello`, missing `relayId`) |

---

## 12. Transport Notes

- All frames are **text** (JSON-encoded UTF-8).
- Binary frames are not used.
- The relay accepts connections on paths `/` and `/ws` only; other paths are rejected during the WebSocket upgrade.
- There is no heartbeat/ping mechanism at the application layer; WebSocket-level ping/pong is handled by the underlying library.
- The relay runs on the port specified by the `PORT` environment variable (default: `8080`).
