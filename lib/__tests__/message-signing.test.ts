/**
 * @vitest-environment node
 *
 * Direct unit tests for lib/crypto/message-signing.ts. The functions here are
 * only exercised incidentally today, as plumbing inside messaging-integration.test.ts
 * and receive-signature-verification.test.ts (which test the surrounding
 * envelope/receive wiring, not message-signing's own edge cases like tamper
 * detection, timestamp-window boundaries, or getMessageFingerprint). This
 * suite covers those directly.
 *
 * node environment (not the project default jsdom): message-signing.ts
 * round-trips signatures through Node's Buffer.from(hex), and @noble/curves'
 * instanceof Uint8Array checks fail across jsdom's separate Uint8Array realm
 * — same reasoning documented in receive-signature-verification.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deriveSigningKeypair,
  signMessage,
  verifyMessageSignature,
  getMessageFingerprint,
  type SignedMessage,
} from '../crypto/message-signing';

function fakeIdentityPrivateKey(seed: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i++) key[i] = (seed + i * 11) % 256;
  return key;
}

describe('deriveSigningKeypair', () => {
  it('is deterministic for the same identity private key', () => {
    const key = fakeIdentityPrivateKey(1);
    const a = deriveSigningKeypair(key);
    const b = deriveSigningKeypair(key);
    expect(Buffer.from(a.privateKey).equals(Buffer.from(b.privateKey))).toBe(true);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
  });

  it('derives different signing keypairs for different identity keys', () => {
    const a = deriveSigningKeypair(fakeIdentityPrivateKey(1));
    const b = deriveSigningKeypair(fakeIdentityPrivateKey(2));
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(false);
  });

  it('the derived signing public key differs from the raw X25519 seed bytes (domain separation)', () => {
    const identityKey = fakeIdentityPrivateKey(3);
    const { publicKey } = deriveSigningKeypair(identityKey);
    expect(Buffer.from(publicKey).equals(Buffer.from(identityKey))).toBe(false);
  });
});

describe('signMessage / verifyMessageSignature', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function makeSigned(overrides: Partial<{ msgId: string; text: string; relayId: string }> = {}) {
    const identityKey = fakeIdentityPrivateKey(5);
    const signingKeypair = deriveSigningKeypair(identityKey);
    const signed = await signMessage(
      overrides.msgId ?? 'msg-1',
      overrides.text ?? 'hello world',
      overrides.relayId ?? 'relay:aaaa-bbbb',
      signingKeypair.privateKey,
    );
    return { signed, signingKeypair };
  }

  it('a freshly signed message verifies successfully', async () => {
    const { signed, signingKeypair } = await makeSigned();
    expect(verifyMessageSignature(signed, signingKeypair.publicKey)).toBe(true);
  });

  it('rejects a message whose content was tampered with after signing', async () => {
    const { signed, signingKeypair } = await makeSigned();
    const tampered: SignedMessage = { ...signed, content: 'hello world (edited by attacker)' };
    expect(() => verifyMessageSignature(tampered, signingKeypair.publicKey)).toThrow(/tampered/i);
  });

  it('rejects a message whose messageId was tampered with', async () => {
    const { signed, signingKeypair } = await makeSigned();
    const tampered: SignedMessage = { ...signed, messageId: 'msg-2-swapped' };
    expect(() => verifyMessageSignature(tampered, signingKeypair.publicKey)).toThrow(/tampered/i);
  });

  it('rejects a message signed by a different key', async () => {
    const { signed } = await makeSigned();
    const otherKeypair = deriveSigningKeypair(fakeIdentityPrivateKey(99));
    expect(() => verifyMessageSignature(signed, otherKeypair.publicKey)).toThrow(/tampered/i);
  });

  it('accepts a message right at the edge of the delayed-delivery tolerance (25 minutes old)', async () => {
    const { signed, signingKeypair } = await makeSigned();
    vi.setSystemTime(new Date('2026-01-01T00:24:00.000Z')); // 24 min later, inside 25 min window
    expect(verifyMessageSignature(signed, signingKeypair.publicKey)).toBe(true);
  });

  it('rejects a message older than the 25-minute delayed-delivery tolerance', async () => {
    const { signed, signingKeypair } = await makeSigned();
    vi.setSystemTime(new Date('2026-01-01T00:26:00.000Z')); // 26 min later, outside 25 min window
    expect(() => verifyMessageSignature(signed, signingKeypair.publicKey)).toThrow(/timestamp/i);
  });

  it('accepts a message timestamped up to 60s in the future (clock skew tolerance)', async () => {
    // Build a signed message with a timestamp 60s ahead of "now" directly,
    // since signMessage always stamps Date.now() at call time.
    const identityKey = fakeIdentityPrivateKey(5);
    const signingKeypair = deriveSigningKeypair(identityKey);
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
    const futureSigned = await signMessage('msg-future', 'hi', 'relay:aaaa-bbbb', signingKeypair.privateKey);
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); // "now" is 60s before the message's timestamp
    expect(verifyMessageSignature(futureSigned, signingKeypair.publicKey)).toBe(true);
  });

  it('rejects a message timestamped more than 60s in the future', async () => {
    const identityKey = fakeIdentityPrivateKey(5);
    const signingKeypair = deriveSigningKeypair(identityKey);
    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
    const futureSigned = await signMessage('msg-future', 'hi', 'relay:aaaa-bbbb', signingKeypair.privateKey);
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); // 61s before the message's timestamp
    expect(() => verifyMessageSignature(futureSigned, signingKeypair.publicKey)).toThrow(/timestamp/i);
  });

  it('the expired-timestamp error message is wrapped (does not contain "tampered")', async () => {
    // verifyMessageSignature's catch block only rethrows as-is when the
    // caught error's message includes "verification"; the timestamp check's
    // error message doesn't, so it gets wrapped in a generic
    // "Signature verification failed: <reason>" message. Pin that exact
    // current behavior so a future refactor of the error wrapping is visible.
    const { signed, signingKeypair } = await makeSigned();
    vi.setSystemTime(new Date('2026-01-01T00:30:00.000Z'));
    try {
      verifyMessageSignature(signed, signingKeypair.publicKey);
      expect.unreachable('expected verifyMessageSignature to throw');
    } catch (err) {
      expect((err as Error).message).toBe('Signature verification failed: Message timestamp is invalid or too old');
    }
  });

  it('rejects a malformed (non-hex) signature without crashing the process', async () => {
    const { signed, signingKeypair } = await makeSigned();
    const malformed: SignedMessage = { ...signed, signature: 'not-a-hex-signature' };
    expect(() => verifyMessageSignature(malformed, signingKeypair.publicKey)).toThrow();
  });
});

describe('getMessageFingerprint', () => {
  it('produces a 16-character uppercase hex fingerprint', async () => {
    const identityKey = fakeIdentityPrivateKey(7);
    const signingKeypair = deriveSigningKeypair(identityKey);
    const signed = await signMessage('msg-1', 'hello', 'relay:aaaa-bbbb', signingKeypair.privateKey);
    const fingerprint = getMessageFingerprint(signed);
    expect(fingerprint).toMatch(/^[0-9A-F]{16}$/);
  });

  it('is deterministic for the same messageId/senderRelayId/content, independent of signature/timestamp', async () => {
    const base: SignedMessage = {
      messageId: 'msg-1',
      content: 'hello',
      senderRelayId: 'relay:aaaa-bbbb',
      signature: 'deadbeef',
      timestamp: 1000,
    };
    const differentSigAndTime: SignedMessage = { ...base, signature: 'cafebabe', timestamp: 999999 };
    expect(getMessageFingerprint(base)).toBe(getMessageFingerprint(differentSigAndTime));
  });

  it('changes when the content changes', () => {
    const base: SignedMessage = {
      messageId: 'msg-1',
      content: 'hello',
      senderRelayId: 'relay:aaaa-bbbb',
      signature: 'deadbeef',
      timestamp: 1000,
    };
    const changed: SignedMessage = { ...base, content: 'goodbye' };
    expect(getMessageFingerprint(base)).not.toBe(getMessageFingerprint(changed));
  });
});
