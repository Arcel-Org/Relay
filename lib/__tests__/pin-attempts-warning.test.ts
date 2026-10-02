/**
 * @vitest-environment node
 *
 * pinAttemptsRemainingMessage (lib/crypto/relay-auth-store-v2.ts) is the
 * user-facing "N attempts remaining" warning shown on wrong-PIN guesses
 * (round-3 finding: 5 wrong guesses wiped local identity with zero warning).
 * The one invariant that actually matters here is security-relevant, not
 * just UX: it must return null (no count shown) on and after the exact
 * attempt that triggers the wipe, so that guess is never visibly
 * distinguishable from a covert duress-PIN wipe triggered at the same
 * position — see the function's own doc comment and the duress-PIN
 * handling in app/auth/login/page.tsx.
 */
import { describe, it, expect } from 'vitest';
import { pinAttemptsRemainingMessage, MAX_PIN_ATTEMPTS } from '../crypto/relay-auth-store-v2';

describe('pinAttemptsRemainingMessage', () => {
  it('counts down correctly for attempts before the wipe threshold', () => {
    expect(pinAttemptsRemainingMessage(1)).toContain('4 attempts remaining');
    expect(pinAttemptsRemainingMessage(2)).toContain('3 attempts remaining');
    expect(pinAttemptsRemainingMessage(3)).toContain('2 attempts remaining');
  });

  it('uses singular "attempt" when exactly one remains', () => {
    expect(pinAttemptsRemainingMessage(4)).toContain('1 attempt remaining');
    expect(pinAttemptsRemainingMessage(4)).not.toContain('1 attempts');
  });

  it('returns null on the exact attempt that triggers the wipe (never reveals the destructive guess)', () => {
    expect(pinAttemptsRemainingMessage(MAX_PIN_ATTEMPTS)).toBeNull();
  });

  it('returns null for any attempt number past the wipe threshold too', () => {
    expect(pinAttemptsRemainingMessage(MAX_PIN_ATTEMPTS + 1)).toBeNull();
    expect(pinAttemptsRemainingMessage(999)).toBeNull();
  });

  it('MAX_PIN_ATTEMPTS is 5, matching the wipe threshold used by the login flows', () => {
    expect(MAX_PIN_ATTEMPTS).toBe(5);
  });
});
