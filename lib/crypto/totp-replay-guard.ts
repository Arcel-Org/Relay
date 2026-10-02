/**
 * Tracks recently-accepted TOTP codes per user so an intercepted code can't
 * be replayed a second time within its validity window. verifyTOTPCode
 * accepts the current window plus the previous one (~60s total) to tolerate
 * clock skew — without this guard, that same window means a captured code
 * is valid for a fresh login twice, not just once.
 *
 * Multi-slot: a single-entry-per-user guard only remembers the MOST
 * RECENTLY used code — if the user legitimately authenticates twice in a
 * row (e.g. login, then a step-up action like regenerating a recovery
 * code) with two different codes, the single stored entry gets overwritten
 * by the second use, silently making the FIRST code replayable again for
 * as long as it's still within its validity window. Tracking a small set
 * of recently-used codes per user closes that gap.
 *
 * In-memory only, matching lib/rate-limit.ts's posture: this is ephemeral
 * abuse control, not persistent accounting, and doesn't need to survive a
 * restart.
 */

const usedCodes = new Map<string, Map<string, number>>();
const ENTRY_TTL_MS = 2 * 60 * 1000; // codes are only ever valid ~60s; keep a margin
const MAX_CODES_PER_USER = 4; // bounds memory even if purgeStale lags

function purgeStale() {
  const now = Date.now();
  for (const [relayId, codes] of usedCodes) {
    for (const [code, usedAt] of codes) {
      if (now - usedAt > ENTRY_TTL_MS) codes.delete(code);
    }
    if (codes.size === 0) usedCodes.delete(relayId);
  }
}

/** True if this exact code was already accepted for this user within the TTL window. */
export function isTotpCodeReplayed(relayId: string, code: string): boolean {
  purgeStale();
  return !!usedCodes.get(relayId)?.has(code);
}

/** Call after a successful TOTP verification to block replaying the same code. */
export function markTotpCodeUsed(relayId: string, code: string): void {
  let codes = usedCodes.get(relayId);
  if (!codes) {
    codes = new Map();
    usedCodes.set(relayId, codes);
  }
  codes.set(code, Date.now());
  if (codes.size > MAX_CODES_PER_USER) {
    const oldestCode = Array.from(codes.entries()).sort((a, b) => a[1] - b[1])[0]?.[0];
    if (oldestCode !== undefined) codes.delete(oldestCode);
  }
}
