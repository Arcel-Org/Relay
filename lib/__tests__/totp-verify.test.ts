/**
 * Tests for TOTP derivation/verification in lib/crypto/relay-auth.ts.
 *
 * Note: this codebase has no persistent TOTP replay-guard module (no
 * `isTotpCodeReplayed`/`markTotpCodeUsed`-style store) — `verifyTOTPCode`
 * is a pure, stateless RFC 6238 check with a one-window clock-skew
 * tolerance. This suite covers that real logic: correct-code acceptance,
 * wrong-code rejection, the previous-window tolerance, rejection outside
 * that tolerance, and per-secret isolation. It also has an explicit test
 * that documents (not asserts as correct) the current replay-acceptance
 * behavior — see the last test and the report for why this is flagged
 * rather than silently "fixed" here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deriveTOTPSecret,
  createTOTPFromKey,
  createTOTPFromSecret,
  getCurrentTOTPCode,
  verifyTOTPCode,
} from '../crypto/relay-auth';

function fakePrivateKey(seed: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i++) key[i] = (seed + i) % 256;
  return key;
}

describe('TOTP derive + verify', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives a deterministic 20-byte secret from a private key', () => {
    const key = fakePrivateKey(1);
    const secretA = deriveTOTPSecret(key);
    const secretB = deriveTOTPSecret(key);
    expect(secretA.length).toBe(20);
    expect(Buffer.from(secretA).equals(Buffer.from(secretB))).toBe(true);
  });

  it('derives different secrets for different private keys', () => {
    const secretA = deriveTOTPSecret(fakePrivateKey(1));
    const secretB = deriveTOTPSecret(fakePrivateKey(2));
    expect(Buffer.from(secretA).equals(Buffer.from(secretB))).toBe(false);
  });

  it('accepts the current, correctly generated code', () => {
    const totp = createTOTPFromKey(fakePrivateKey(1));
    const code = getCurrentTOTPCode(totp);
    expect(verifyTOTPCode(totp, code)).toBe(true);
  });

  it('rejects an arbitrary wrong code', () => {
    const totp = createTOTPFromKey(fakePrivateKey(1));
    const code = getCurrentTOTPCode(totp);
    const wrongCode = code === '000000' ? '111111' : '000000';
    expect(verifyTOTPCode(totp, wrongCode)).toBe(false);
  });

  it('accepts a code from the previous 30s window (clock skew tolerance)', () => {
    const totp = createTOTPFromKey(fakePrivateKey(1));
    const previousWindowCode = getCurrentTOTPCode(totp);

    // Advance into the next window.
    vi.setSystemTime(new Date('2026-01-01T00:00:31.000Z'));

    expect(verifyTOTPCode(totp, previousWindowCode)).toBe(true);
  });

  it('rejects a code from two windows back (outside tolerance)', () => {
    const totp = createTOTPFromKey(fakePrivateKey(1));
    const staleCode = getCurrentTOTPCode(totp);

    // Advance two full windows (61s+) so staleCode is neither current nor previous.
    vi.setSystemTime(new Date('2026-01-01T00:01:05.000Z'));

    expect(verifyTOTPCode(totp, staleCode)).toBe(false);
  });

  it('a code valid for one user\'s secret is rejected against a different user\'s secret', () => {
    const totpAlice = createTOTPFromKey(fakePrivateKey(1));
    const totpBob = createTOTPFromKey(fakePrivateKey(99));

    const aliceCode = getCurrentTOTPCode(totpAlice);
    expect(verifyTOTPCode(totpBob, aliceCode)).toBe(false);
  });

  it('createTOTPFromSecret and createTOTPFromKey produce interoperable codes for the same key', () => {
    const key = fakePrivateKey(5);
    const secret = deriveTOTPSecret(key);
    const totpFromKey = createTOTPFromKey(key);
    const totpFromSecret = createTOTPFromSecret(secret);

    const code = getCurrentTOTPCode(totpFromKey);
    expect(verifyTOTPCode(totpFromSecret, code)).toBe(true);
  });

  it('DOCUMENTS current behavior: verifyTOTPCode has no replay guard, so the same code verifies repeatedly within its window', () => {
    // This is not asserting desired security behavior — it demonstrates a
    // real gap: there is no isTotpCodeReplayed/markTotpCodeUsed mechanism
    // anywhere in this codebase. A TOTP code intercepted once (e.g. via a
    // shoulder-surf or compromised transport) can be replayed by an
    // attacker for the remainder of its ~60s validity window. Flagged in
    // the report rather than silently patched, since closing it requires a
    // stateful used-code store (with a decision on storage backend/TTL)
    // that's a feature addition, not a test-coverage fix.
    const totp = createTOTPFromKey(fakePrivateKey(7));
    const code = getCurrentTOTPCode(totp);
    expect(verifyTOTPCode(totp, code)).toBe(true);
    expect(verifyTOTPCode(totp, code)).toBe(true); // replay — currently still accepted
  });
});
