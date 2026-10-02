/**
 * Direct coverage for lib/features/safety-numbers.ts — the user-facing MITM
 * detection mechanism (compare a computed "safety number" over an
 * out-of-band channel to confirm no one is sitting between two identities).
 * Previously zero test coverage despite being security-load-bearing: if
 * computeSafetyNumber ever stopped being symmetric (same value regardless
 * of which side computes it), the whole feature would silently show two
 * honest parties a "mismatch" — or worse, agree on the wrong invariant and
 * never detect a real MITM.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSafetyNumber,
  hashToWords12,
  hashToDigits,
  createSafetyNumber,
  verifySafetyNumber,
  hasSafetyNumberChanged,
  formatSafetyNumberShort,
  formatSafetyNumberFull,
  formatSafetyNumberDigits,
} from '../features/safety-numbers';

const ALICE_ID = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';
const BOB_ID = 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb';
const ALICE_KEY = 'a1'.repeat(32);
const BOB_KEY = 'b2'.repeat(32);

describe('computeSafetyNumber', () => {
  it('is symmetric — both parties compute the SAME value regardless of which side calls it', () => {
    // This is the entire security property the feature depends on: if this
    // ever broke, two honest parties would see a false "mismatch" warning
    // (or worse, a real MITM could exploit an asymmetry to go undetected).
    const fromAlice = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    const fromBob = computeSafetyNumber(BOB_KEY, ALICE_KEY, BOB_ID, ALICE_ID);
    expect(fromAlice).toBe(fromBob);
  });

  it('is deterministic — the same inputs always produce the same output', () => {
    const first = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    const second = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(first).toBe(second);
  });

  it('produces a different value for a different key pair', () => {
    const original = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    const changed = computeSafetyNumber(ALICE_KEY, 'c3'.repeat(32), ALICE_ID, BOB_ID);
    expect(changed).not.toBe(original);
  });

  it('returns a 60-hex-char string (30 bytes)', () => {
    const hash = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(hash).toMatch(/^[0-9a-f]{60}$/);
  });
});

describe('hashToWords12', () => {
  it('returns exactly 12 words', () => {
    const hash = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(hashToWords12(hash)).toHaveLength(12);
  });

  it('is deterministic for the same hash', () => {
    const hash = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(hashToWords12(hash)).toEqual(hashToWords12(hash));
  });

  it('produces different words for a different hash', () => {
    const hashA = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    const hashB = computeSafetyNumber(ALICE_KEY, 'c3'.repeat(32), ALICE_ID, BOB_ID);
    expect(hashToWords12(hashA)).not.toEqual(hashToWords12(hashB));
  });
});

describe('hashToDigits', () => {
  it('returns 5 groups of exactly 6 digits, space-separated', () => {
    const hash = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(hashToDigits(hash)).toMatch(/^\d{6} \d{6} \d{6} \d{6} \d{6}$/);
  });

  it('is deterministic for the same hash', () => {
    const hash = computeSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(hashToDigits(hash)).toBe(hashToDigits(hash));
  });

  it('a hash of all-zero bytes produces all-zero digit groups (no crash on the empty/leading-zero edge case)', () => {
    expect(hashToDigits('00'.repeat(30))).toBe('000000 000000 000000 000000 000000');
  });
});

describe('createSafetyNumber', () => {
  it('assigns relayId/contactRelayId from the caller perspective, not the internal sort order', () => {
    const fromAlice = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(fromAlice.relayId).toBe(ALICE_ID);
    expect(fromAlice.contactRelayId).toBe(BOB_ID);

    const fromBob = createSafetyNumber(BOB_KEY, ALICE_KEY, BOB_ID, ALICE_ID);
    expect(fromBob.relayId).toBe(BOB_ID);
    expect(fromBob.contactRelayId).toBe(ALICE_ID);

    // Despite the swapped perspective, the underlying hash (what's actually
    // compared out-of-band) must still match.
    expect(fromAlice.hashHex).toBe(fromBob.hashHex);
  });

  it('starts unverified, with no previousHash by default', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(sn.verified).toBe(false);
    expect(sn.verifiedAt).toBeUndefined();
    expect(sn.previousHash).toBeUndefined();
  });

  it('carries previousHash through when supplied', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID, 'stale-hash');
    expect(sn.previousHash).toBe('stale-hash');
  });

  it('qrData is the raw hash hex', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(sn.qrData).toBe(sn.hashHex);
  });
});

describe('verifySafetyNumber', () => {
  it('marks verified=true and stamps verifiedAt, without mutating the input', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    const before = { ...sn };
    const verified = verifySafetyNumber(sn);

    expect(verified.verified).toBe(true);
    expect(typeof verified.verifiedAt).toBe('number');
    expect(sn).toEqual(before); // original object untouched
  });
});

describe('hasSafetyNumberChanged', () => {
  it('is false when there is no previousHash', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(hasSafetyNumberChanged(sn)).toBe(false);
  });

  it('is false when previousHash matches the current hash', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID, undefined);
    const withMatchingPrevious = { ...sn, previousHash: sn.hashHex };
    expect(hasSafetyNumberChanged(withMatchingPrevious)).toBe(false);
  });

  it('is true when previousHash differs from the current hash — the actual MITM/key-rotation signal', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID, 'a-different-old-hash');
    expect(hasSafetyNumberChanged(sn)).toBe(true);
  });
});

describe('formatters', () => {
  it('formatSafetyNumberShort shows first 3 and last 3 words with an ellipsis between', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    const short = formatSafetyNumberShort(sn);
    expect(short).toContain(sn.words12.slice(0, 3).join(' '));
    expect(short).toContain(sn.words12.slice(-3).join(' '));
    expect(short).toContain('...');
  });

  it('formatSafetyNumberFull joins all 12 words, one per line', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(formatSafetyNumberFull(sn).split('\n')).toEqual(sn.words12);
  });

  it('formatSafetyNumberDigits returns the digits string as-is', () => {
    const sn = createSafetyNumber(ALICE_KEY, BOB_KEY, ALICE_ID, BOB_ID);
    expect(formatSafetyNumberDigits(sn)).toBe(sn.digits);
  });
});
