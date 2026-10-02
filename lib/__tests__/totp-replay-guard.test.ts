/**
 * Coverage for lib/crypto/totp-replay-guard.ts — previously zero direct
 * unit tests despite being the actual defense against a captured TOTP code
 * being replayed within its ~60s validity window.
 *
 * usedCodes is a plain module-level Map with no reset hook, so each test
 * uses its OWN unique relayId (rather than a shared constant) to stay fully
 * isolated from every other test's entries — sharing one relayId across
 * tests that also fake/reset system time would let leftover entries from
 * an earlier test (recorded under that test's own advanced fake clock)
 * confuse the "oldest entry" eviction/TTL comparisons in a later test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTotpCodeReplayed, markTotpCodeUsed } from '../crypto/totp-replay-guard';

let testCounter = 0;
function freshRelayId(): string {
  testCounter += 1;
  return `relay-totp-test-${testCounter}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isTotpCodeReplayed / markTotpCodeUsed', () => {
  it('a code is not replayed before it has ever been marked used', () => {
    const relayId = freshRelayId();
    expect(isTotpCodeReplayed(relayId, '123456')).toBe(false);
  });

  it('a code IS replayed once marked used', () => {
    const relayId = freshRelayId();
    markTotpCodeUsed(relayId, '123456');
    expect(isTotpCodeReplayed(relayId, '123456')).toBe(true);
  });

  it('marking a code for one relayId does not affect a different relayId', () => {
    const relayId = freshRelayId();
    markTotpCodeUsed(relayId, '123456');
    expect(isTotpCodeReplayed(freshRelayId(), '123456')).toBe(false);
  });

  it('a DIFFERENT code for the same user is not flagged as replayed', () => {
    const relayId = freshRelayId();
    markTotpCodeUsed(relayId, '123456');
    expect(isTotpCodeReplayed(relayId, '654321')).toBe(false);
  });

  it('multi-slot: using a second code does not resurrect the first as replayable (the bug this guard specifically closes)', () => {
    const relayId = freshRelayId();
    markTotpCodeUsed(relayId, '111111');
    markTotpCodeUsed(relayId, '222222');
    // A naive single-entry-per-user guard would have overwritten '111111'
    // with '222222', silently making '111111' replayable again.
    expect(isTotpCodeReplayed(relayId, '111111')).toBe(true);
    expect(isTotpCodeReplayed(relayId, '222222')).toBe(true);
  });

  it('bounds memory per user — the oldest code is evicted once more than MAX_CODES_PER_USER (4) are tracked', () => {
    const relayId = freshRelayId();
    markTotpCodeUsed(relayId, 'code-1');
    vi.advanceTimersByTime(1000);
    markTotpCodeUsed(relayId, 'code-2');
    vi.advanceTimersByTime(1000);
    markTotpCodeUsed(relayId, 'code-3');
    vi.advanceTimersByTime(1000);
    markTotpCodeUsed(relayId, 'code-4');
    vi.advanceTimersByTime(1000);
    markTotpCodeUsed(relayId, 'code-5');

    expect(isTotpCodeReplayed(relayId, 'code-1')).toBe(false); // evicted — oldest
    expect(isTotpCodeReplayed(relayId, 'code-2')).toBe(true);
    expect(isTotpCodeReplayed(relayId, 'code-5')).toBe(true);
  });

  it('a code is no longer considered replayed once it ages out of the TTL window', () => {
    const relayId = freshRelayId();
    markTotpCodeUsed(relayId, '123456');
    expect(isTotpCodeReplayed(relayId, '123456')).toBe(true);

    vi.advanceTimersByTime(2 * 60 * 1000 + 1); // just past ENTRY_TTL_MS
    expect(isTotpCodeReplayed(relayId, '123456')).toBe(false);
  });

  it('a code just under the TTL window is still considered replayed', () => {
    const relayId = freshRelayId();
    markTotpCodeUsed(relayId, '123456');
    vi.advanceTimersByTime(2 * 60 * 1000 - 1000);
    expect(isTotpCodeReplayed(relayId, '123456')).toBe(true);
  });
});
