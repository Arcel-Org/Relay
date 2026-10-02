/**
 * Tests for lib/crypto/hex-utils.ts — toHex/fromHex have no dedicated
 * coverage anywhere; they're only exercised incidentally as a helper import
 * inside key-exchange-binding.test.ts. This suite covers round-tripping,
 * boundary lengths, and the (undocumented) behavior of fromHex on malformed
 * input — it does no validation of its own, so odd-length or non-hex input
 * degrades silently rather than throwing.
 */
import { describe, it, expect } from 'vitest';
import { toHex, fromHex } from '../crypto/hex-utils';

describe('toHex', () => {
  it('encodes an empty array to an empty string', () => {
    expect(toHex(new Uint8Array(0))).toBe('');
  });

  it('encodes bytes to lowercase, zero-padded hex', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
  });

  it('pads single-digit hex values with a leading zero', () => {
    expect(toHex(new Uint8Array([1]))).toBe('01');
    expect(toHex(new Uint8Array([9]))).toBe('09');
  });

  it('round-trips through fromHex for arbitrary bytes', () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 5) % 256;
    expect(Array.from(fromHex(toHex(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('fromHex', () => {
  it('decodes an empty string to an empty array', () => {
    expect(fromHex('').length).toBe(0);
  });

  it('decodes a well-formed hex string', () => {
    expect(Array.from(fromHex('00010f10ff'))).toEqual([0, 1, 15, 16, 255]);
  });

  it('accepts uppercase hex digits (parseInt is case-insensitive)', () => {
    expect(Array.from(fromHex('ABCD'))).toEqual(Array.from(fromHex('abcd')));
    expect(Array.from(fromHex('ABCD'))).toEqual([171, 205]);
  });

  it('DOCUMENTS current behavior: odd-length input silently drops the trailing nibble', () => {
    // hex.length / 2 = 1.5 -> Uint8Array(1.5) truncates to length 1, so the
    // dangling final hex digit ("c" in "abc") is parsed but never written
    // (its target index is out of bounds and silently ignored on a typed
    // array). No error is thrown; the caller gets a shorter-than-expected
    // result instead of a decode failure.
    const result = fromHex('abc');
    expect(result.length).toBe(1);
    expect(Array.from(result)).toEqual([0xab]);
  });

  it('DOCUMENTS current behavior: non-hex characters decode to 0 rather than throwing', () => {
    // parseInt('gg', 16) is NaN, and assigning NaN into a Uint8Array slot
    // coerces to 0 — invalid input is silently accepted as zero bytes
    // instead of being rejected.
    expect(Array.from(fromHex('gg'))).toEqual([0]);
    expect(Array.from(fromHex('zz00'))).toEqual([0, 0]);
  });
});
