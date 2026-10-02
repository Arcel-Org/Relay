/**
 * Coverage for lib/crypto/group-crypto.ts — the inner AEAD layer wrapped
 * inside the existing pairwise-session fan-out for group content (see
 * use-group-messaging.ts). No ratchet chain backs this key (it's a shared
 * group secret, not a per-member chain), so every property that matters —
 * wrong key fails, tampering fails, AAD context binding actually binds —
 * has to be proven directly against this primitive.
 */
import { describe, it, expect } from 'vitest';
import { generateGroupKey, encryptWithGroupKey, decryptWithGroupKey, buildGroupAad, GROUP_KEY_SIZE } from '../crypto/group-crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('generateGroupKey', () => {
  it('produces a fresh 32-byte key each call', () => {
    const a = generateGroupKey();
    const b = generateGroupKey();
    expect(a.length).toBe(GROUP_KEY_SIZE);
    expect(b.length).toBe(GROUP_KEY_SIZE);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('encryptWithGroupKey / decryptWithGroupKey', () => {
  it('round-trips plaintext under the same key and AAD', () => {
    const key = generateGroupKey();
    const aad = buildGroupAad('grp1', 1, 'sender-1');
    const plaintext = encoder.encode('hello group');

    const wire = encryptWithGroupKey(key, plaintext, aad);
    const decrypted = decryptWithGroupKey(key, wire, aad);

    expect(decoder.decode(decrypted)).toBe('hello group');
  });

  it('produces a different nonce (and ciphertext) on every call, even for identical inputs', () => {
    const key = generateGroupKey();
    const aad = buildGroupAad('grp1', 1, 'sender-1');
    const plaintext = encoder.encode('same message');

    const wireA = encryptWithGroupKey(key, plaintext, aad);
    const wireB = encryptWithGroupKey(key, plaintext, aad);

    expect(Buffer.from(wireA).equals(Buffer.from(wireB))).toBe(false);
  });

  it('fails to decrypt with the wrong key', () => {
    const key = generateGroupKey();
    const wrongKey = generateGroupKey();
    const aad = buildGroupAad('grp1', 1, 'sender-1');
    const wire = encryptWithGroupKey(key, encoder.encode('secret'), aad);

    expect(() => decryptWithGroupKey(wrongKey, wire, aad)).toThrow();
  });

  it('fails to decrypt with mismatched AAD (wrong groupId, epoch, or sender)', () => {
    const key = generateGroupKey();
    const wire = encryptWithGroupKey(key, encoder.encode('secret'), buildGroupAad('grp1', 1, 'sender-1'));

    expect(() => decryptWithGroupKey(key, wire, buildGroupAad('grp2', 1, 'sender-1'))).toThrow();
    expect(() => decryptWithGroupKey(key, wire, buildGroupAad('grp1', 2, 'sender-1'))).toThrow();
    expect(() => decryptWithGroupKey(key, wire, buildGroupAad('grp1', 1, 'sender-2'))).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const key = generateGroupKey();
    const aad = buildGroupAad('grp1', 1, 'sender-1');
    const wire = encryptWithGroupKey(key, encoder.encode('secret'), aad);

    const tampered = new Uint8Array(wire);
    tampered[tampered.length - 1] ^= 0xff; // flip a bit in the tag/ciphertext tail

    expect(() => decryptWithGroupKey(key, tampered, aad)).toThrow();
  });

  it('rejects a too-short wire blob rather than reading out of bounds', () => {
    const key = generateGroupKey();
    expect(() => decryptWithGroupKey(key, new Uint8Array(4), buildGroupAad('grp1', 1, 'sender-1'))).toThrow(/too short/);
  });
});
