/**
 * Direct coverage for server/relay-schemas.ts — previously only exercised
 * indirectly through relay-node.test.ts's "malformed frame fails schema
 * validation" / oversized-payload checks, never asserting on individual
 * schema fields or parseRelayMessage's alias-normalization behavior.
 */
import { describe, it, expect } from 'vitest';
import { parseRelayMessage, relayMessageSchema } from '../../server/relay-schemas';

describe('parseRelayMessage: accepts every known message type', () => {
  it('hello', () => {
    expect(() => parseRelayMessage({ type: 'hello', relayId: 'relay:aaaa-bbbb', ticket: 'tkt' })).not.toThrow();
  });

  it('message (canonical fields)', () => {
    expect(() => parseRelayMessage({
      type: 'message', toRelayId: 'relay:aaaa-bbbb', encryptedMessage: 'ciphertexthex', messageId: 'm1',
    })).not.toThrow();
  });

  it('key_exchange', () => {
    expect(() => parseRelayMessage({
      type: 'key_exchange', toRelayId: 'relay:aaaa-bbbb', publicKey: 'ab'.repeat(32),
    })).not.toThrow();
  });

  it('ack', () => {
    expect(() => parseRelayMessage({ type: 'ack', messageId: 'm1' })).not.toThrow();
  });

  it('typing / burn_request / burn_confirm / read_receipt / reaction / delete_message', () => {
    expect(() => parseRelayMessage({ type: 'typing', isTyping: true })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'burn_request', conversationId: 'c1' })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'burn_confirm', conversationId: 'c1' })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'read_receipt', messageId: 'm1' })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'reaction', messageId: 'm1', emoji: '🔥' })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'delete_message', messageId: 'm1' })).not.toThrow();
  });

  it('call signaling: offer/answer/ice (object form) and hangup/ring/peers', () => {
    expect(() => parseRelayMessage({ type: 'call_offer', callId: 'c1', offer: { type: 'offer', sdp: 'v=0...' } })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'call_answer', callId: 'c1', answer: { type: 'answer', sdp: 'v=0...' } })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'call_ice', callId: 'c1', candidate: { candidate: 'cand', sdpMLineIndex: 0 } })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'call_hangup', callId: 'c1', reason: 'hangup' })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'call_ring', callId: 'c1' })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'call_peers', peerIds: ['relay:aaaa-bbbb'] })).not.toThrow();
  });

  it('call_offer/call_answer/call_ice with an encrypted-string signal (no per-contact session case)', () => {
    expect(() => parseRelayMessage({ type: 'call_offer', callId: 'c1', offer: 'deadbeef'.repeat(4) })).not.toThrow();
    expect(() => parseRelayMessage({ type: 'call_ice', callId: 'c1', candidate: 'deadbeef'.repeat(4) })).not.toThrow();
  });
});

describe('parseRelayMessage: rejects malformed input', () => {
  it('rejects an unknown message type', () => {
    expect(() => parseRelayMessage({ type: 'not_a_real_type' })).toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => parseRelayMessage('just a string')).toThrow();
    expect(() => parseRelayMessage(null)).toThrow();
    expect(() => parseRelayMessage(42)).toThrow();
  });

  it('message: requires at least one of toRelayId/to', () => {
    expect(() => parseRelayMessage({ type: 'message', encryptedMessage: 'ct', messageId: 'm1' })).toThrow();
  });

  it('message: requires at least one of encryptedMessage/blob', () => {
    expect(() => parseRelayMessage({ type: 'message', toRelayId: 'relay:aaaa-bbbb', messageId: 'm1' })).toThrow();
  });

  it('message: requires at least one of messageId/msgId', () => {
    expect(() => parseRelayMessage({ type: 'message', toRelayId: 'relay:aaaa-bbbb', encryptedMessage: 'ct' })).toThrow();
  });

  it('message: rejects an oversized encryptedMessage (>64KB)', () => {
    expect(() => parseRelayMessage({
      type: 'message', toRelayId: 'relay:aaaa-bbbb', encryptedMessage: 'a'.repeat(65537), messageId: 'm1',
    })).toThrow();
  });

  it('key_exchange: publicKey is required (unlike pqPublicKey)', () => {
    expect(() => parseRelayMessage({ type: 'key_exchange', toRelayId: 'relay:aaaa-bbbb' })).toThrow();
  });

  it('delete_message: messageId is required (not optional, unlike most control messages)', () => {
    expect(() => parseRelayMessage({ type: 'delete_message' })).toThrow();
  });

  it('call_hangup: reason must be one of the closed set, not free text', () => {
    expect(() => parseRelayMessage({ type: 'call_hangup', reason: 'anything-goes' })).toThrow();
  });

  it('relayId field: rejects a too-short or too-long relayId', () => {
    expect(() => parseRelayMessage({ type: 'hello', relayId: 'ab', ticket: 't' })).toThrow();
    expect(() => parseRelayMessage({ type: 'hello', relayId: 'n'.repeat(200), ticket: 't' })).toThrow();
  });
});

describe('parseRelayMessage: alias normalization', () => {
  it('message: fills toRelayId/encryptedMessage/messageId from their aliases (to/blob/msgId)', () => {
    const parsed = parseRelayMessage({
      type: 'message', to: 'relay:aaaa-bbbb', blob: 'ciphertexthex', msgId: 'm1',
    }) as any;
    expect(parsed.toRelayId).toBe('relay:aaaa-bbbb');
    expect(parsed.encryptedMessage).toBe('ciphertexthex');
    expect(parsed.messageId).toBe('m1');
  });

  it('message: canonical field wins when both canonical and alias are present', () => {
    const parsed = parseRelayMessage({
      type: 'message', toRelayId: 'relay:canonical1', to: 'relay:alias0001', encryptedMessage: 'ct', messageId: 'm1',
    }) as any;
    expect(parsed.toRelayId).toBe('relay:canonical1');
  });

  it('ack: fills messageId from msgId', () => {
    const parsed = parseRelayMessage({ type: 'ack', msgId: 'm1' }) as any;
    expect(parsed.messageId).toBe('m1');
  });

  it('key_exchange: alias normalization does not apply toRelayId incorrectly when only `to` given', () => {
    const parsed = parseRelayMessage({ type: 'key_exchange', to: 'relay:aaaa-bbbb', publicKey: 'ab'.repeat(32) }) as any;
    expect(parsed.toRelayId).toBe('relay:aaaa-bbbb');
  });
});

describe('relayMessageSchema (raw schema, no alias normalization)', () => {
  it('safeParse reports success/failure without throwing', () => {
    expect(relayMessageSchema.safeParse({ type: 'ack', messageId: 'm1' }).success).toBe(true);
    expect(relayMessageSchema.safeParse({ type: 'ack' }).success).toBe(false);
  });
});
