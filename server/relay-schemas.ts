/**
 * Relay – Inbound WebSocket Message Schemas
 *
 * Uses Zod to validate every message arriving over the WebSocket before the
 * relay server processes it.  Call `parseRelayMessage(data)` with the raw
 * `JSON.parse`'d payload; it returns a fully-typed, validated message or
 * throws a ZodError.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────
// SHARED FIELD SCHEMAS
// ─────────────────────────────────────────────────────────────────────────

// Any string id (relay server trusts ticket auth, not format alone)
const relayIdField = z.string().min(3).max(128);
const publicKeyField = z.string().min(1).max(4096); // hex public key
const msgIdField = z.string().min(1).max(128); // UUID or similar

// ─────────────────────────────────────────────────────────────────────────
// INDIVIDUAL MESSAGE SCHEMAS
// ─────────────────────────────────────────────────────────────────────────

/** Client hello – establishes identity on the relay */
export const helloSchema = z.object({
  type: z.literal("hello"),
  relayId: relayIdField,
  ticket: z.string().min(1).max(512), // HMAC-signed ws-ticket
  publicKey: publicKeyField.optional(),
  // Settings' "Show online status" toggle — opts this connection out of
  // presence broadcast. Purely a courtesy the client requests; the relay
  // still knows this relayId is connected regardless (it has to, to route
  // messages), this only suppresses telling OTHER clients about it.
  hidePresence: z.boolean().optional(),
});

/** Encrypted chat message */
export const messageSchema = z.object({
  type: z.literal("message"),
  toRelayId: relayIdField.optional(),
  to: relayIdField.optional(),
  encryptedMessage: z.string().min(1).max(65536).optional(), // 64KB max
  blob: z.string().min(1).max(65536).optional(),
  messageId: msgIdField.optional(),
  msgId: msgIdField.optional(),
}).refine(
  (d) => !!(d.toRelayId || d.to),
  { message: "Either toRelayId or to is required" },
).refine(
  (d) => !!(d.encryptedMessage || d.blob),
  { message: "Either encryptedMessage or blob is required" },
).refine(
  (d) => !!(d.messageId || d.msgId),
  { message: "Either messageId or msgId is required" },
);

/** Key exchange between peers */
export const keyExchangeSchema = z.object({
  type: z.literal("key_exchange"),
  toRelayId: relayIdField.optional(),
  to: relayIdField.optional(),
  publicKey: publicKeyField,
  // Ed25519 signing public key (hex) — see lib/crypto/message-signing.ts's
  // deriveSigningKeypair. Optional so an older peer that hasn't sent one yet
  // doesn't fail validation; the receiving side just can't verify their
  // signatures until it gets one.
  signingPublicKey: publicKeyField.optional(),
  // ML-KEM768 (hybrid PQ) fields — both optional, absent means classical-only.
  // publicKeyField's 4096-char cap comfortably covers both (hex-encoded
  // ML-KEM768 public key ~2368 chars, ciphertext ~2176 chars).
  pqPublicKey: publicKeyField.optional(),
  pqCipherText: publicKeyField.optional(),
}).refine(
  (d) => !!(d.toRelayId || d.to),
  { message: "Either toRelayId or to is required" },
);

/** Client acknowledges receipt of a message */
export const ackSchema = z.object({
  type: z.literal("ack"),
  messageId: msgIdField.optional(),
  msgId: msgIdField.optional(),
  status: z.string().optional(),
}).refine(
  (d) => !!(d.messageId || d.msgId),
  { message: "Either messageId or msgId is required" },
);

// ─────────────────────────────────────────────────────────────────────────
// CONTROL / SIGNALING SCHEMAS
// ─────────────────────────────────────────────────────────────────────────

/** Base shape shared by all peer-routed control messages */
const controlBase = z.object({
  fromRelayId: relayIdField.optional(),
  toRelayId: relayIdField.optional(),
  to: relayIdField.optional(),
}); // no passthrough — extra keys are stripped, not forwarded

export const typingSchema = controlBase.extend({
  type: z.literal("typing"),
  isTyping: z.boolean().optional(),
});

export const burnRequestSchema = controlBase.extend({
  type: z.literal("burn_request"),
  conversationId: z.string().optional(),
});

export const burnConfirmSchema = controlBase.extend({
  type: z.literal("burn_confirm"),
  conversationId: z.string().optional(),
  // AEAD ciphertext proving the confirming party held the shared session
  // secret — opaque to the relay, verified client-side by the sender.
  receipt: z.string().max(2048).optional(),
});

export const readReceiptSchema = controlBase.extend({
  type: z.literal("read_receipt"),
  messageId: msgIdField.optional(),
  readAt: z.number().optional(),
});

export const reactionSchema = controlBase.extend({
  type: z.literal("reaction"),
  messageId: msgIdField.optional(),
  emoji: z.string().optional(),
});

export const reactionRevokeSchema = controlBase.extend({
  type: z.literal("reaction_revoke"),
  messageId: msgIdField.optional(),
  emoji: z.string().optional(),
});

export const messageEditSchema = controlBase.extend({
  type: z.literal("message_edit"),
  messageId: msgIdField.optional(),
  text: z.string().optional(),
  timestamp: z.string().optional(),
});

export const deliveredSchema = controlBase.extend({
  type: z.literal("delivered"),
  messageId: msgIdField.optional(),
});

export const deleteMessageSchema = controlBase.extend({
  type: z.literal("delete_message"),
  messageId: msgIdField,
});

// Authenticated ratchet-resync request/response — see lib/messaging/resync.ts.
// The relay only ever forwards these opaquely; `signature` is verified
// client-side against the peer's already-pinned Ed25519 signing key, and
// `nonce`/`timestamp` are checked client-side against a persisted
// last-accepted-resync record so a captured request can't be replayed even
// across a relay restart. The relay itself has no way to validate any of
// this — it's just a well-formed opaque control message to it.
export const resyncRequestSchema = controlBase.extend({
  type: z.literal("resync_request"),
  nonce: z.string().min(1).max(128),
  timestamp: z.number(),
  signature: z.string().min(1).max(512),
});

export const resyncResponseSchema = controlBase.extend({
  type: z.literal("resync_response"),
  nonce: z.string().min(1).max(128),
  timestamp: z.number(),
  signature: z.string().min(1).max(512),
});

// ─────────────────────────────────────────────────────────────────────────
// CALL SIGNALING SCHEMAS
// ─────────────────────────────────────────────────────────────────────────

const callBase = controlBase.extend({
  callId: z.string().optional(),
});

// SDP size cap: real WebRTC offers are typically 2-8 KB. 16 KB is generous.
const sdpField = z.string().max(16 * 1024).optional();

// Encrypted hex form — the relay never sees plaintext SDP/ICE when a
// per-contact session exists (see lib/hooks/use-call-signaling.ts). Capped
// generously above the largest realistic encrypted+padded SDP payload.
const encryptedSignalField = z.string().max(32 * 1024);

export const callOfferSchema = callBase.extend({
  type: z.literal("call_offer"),
  offer: z.union([z.object({ type: z.string().max(32), sdp: sdpField }), encryptedSignalField]).optional(),
});

export const callAnswerSchema = callBase.extend({
  type: z.literal("call_answer"),
  answer: z.union([z.object({ type: z.string().max(32), sdp: sdpField }), encryptedSignalField]).optional(),
});

export const callIceSchema = callBase.extend({
  type: z.literal("call_ice"),
  candidate: z.union([
    z.object({
      candidate: sdpField,
      sdpMid: z.string().max(64).optional().nullable(),
      sdpMLineIndex: z.number().int().min(0).max(16).optional().nullable(),
    }),
    encryptedSignalField,
  ]).optional(),
});

export const callHangupSchema = callBase.extend({
  type: z.literal("call_hangup"),
  // Closed set, not free text — see CallHangupReason in lib/relay/relay-websocket.ts.
  reason: z.enum(["hangup", "declined", "busy", "rejected", "missed", "timeout"]).optional(),
});

export const callRingSchema = callBase.extend({
  type: z.literal("call_ring"),
});

export const callPeersSchema = callBase.extend({
  type: z.literal("call_peers"),
  peerIds: z.array(z.string()).optional(),
});

export const callHoldSchema = callBase.extend({
  type: z.literal("call_hold"),
});

export const callResumeSchema = callBase.extend({
  type: z.literal("call_resume"),
});

export const callScreenShareSchema = callBase.extend({
  type: z.literal("call_screen_share"),
});

// ─────────────────────────────────────────────────────────────────────────
// DISCRIMINATED UNION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Union of every known inbound message type.
 *
 * We use `z.union` rather than `z.discriminatedUnion` because several
 * schemas use `.refine()` which is incompatible with discriminatedUnion.
 */
export const relayMessageSchema = z.union([
  helloSchema,
  messageSchema,
  keyExchangeSchema,
  ackSchema,
  // Control
  typingSchema,
  burnRequestSchema,
  burnConfirmSchema,
  readReceiptSchema,
  reactionSchema,
  reactionRevokeSchema,
  messageEditSchema,
  deliveredSchema,
  deleteMessageSchema,
  resyncRequestSchema,
  resyncResponseSchema,
  // Call signaling
  callOfferSchema,
  callAnswerSchema,
  callIceSchema,
  callHangupSchema,
  callRingSchema,
  callPeersSchema,
  callHoldSchema,
  callResumeSchema,
  callScreenShareSchema,
]);

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────

export type RelayMessage = z.infer<typeof relayMessageSchema>;

/**
 * Parse and validate a raw WebSocket payload.
 *
 * @param data  The value returned by `JSON.parse(raw)`.
 * @returns     A fully-typed, validated relay message.
 * @throws      `ZodError` when the payload does not match any known schema.
 */
// messageSchema/keyExchangeSchema/ackSchema accept alternate field names
// (to/blob/msgId) as equally valid to toRelayId/encryptedMessage/messageId,
// but the handlers in server/relay-node.ts only ever read the canonical
// names. Without normalizing here, a schema-valid message using only the
// alternates passes validation but is then silently dropped by the
// handler's own `if (!to || ...)` guard, with no error sent back to the
// sender. Fill in the canonical field from its alias so every schema-valid
// message is actually handled the same way regardless of which name the
// client used.
function normalizeAliases(msg: RelayMessage): RelayMessage {
  const m = msg as Record<string, unknown>;
  if (m.toRelayId === undefined) m.toRelayId = m.to;
  if (m.encryptedMessage === undefined) m.encryptedMessage = m.blob;
  if (m.messageId === undefined) m.messageId = m.msgId;
  return msg;
}

export function parseRelayMessage(data: unknown): RelayMessage {
  return normalizeAliases(relayMessageSchema.parse(data));
}
