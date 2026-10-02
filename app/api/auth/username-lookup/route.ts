import { NextRequest, NextResponse } from 'next/server';
import { getUserByUsername, getUserByRelayId, getUserByShortCode } from '@/lib/db/relay-server-db';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit, checkMissRateLimit, recordMiss } from '@/lib/security/rate-limit';
import { normalizeRelayId, normalizeShortCode } from '@/lib/crypto/relay-id';
import { getSessionRelayId } from '@/lib/db/server-session';

/**
 * Username/RelayID/ShortCode Lookup Endpoint
 * Resolves a username, Relay ID, or opt-in short code to a Relay ID
 * Called from lib/crypto/relay-auth-store-v2.ts's login flow — resolves
 * whatever identifier the user typed to a relayId before deriving keys.
 *
 * No personal data leaked - only returns relayId if found
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // E1: rate-limit username/relayId resolution to prevent bulk enumeration.
  //
  // This endpoint is called from the login flow (relay-auth-store-v2.ts) to
  // resolve whatever identifier the user typed before deriving keys — a
  // legitimate login can retry a handful of times in a minute (typo in the
  // handle, trying a different one after a "not found"). 20/min is still
  // slow enough that bulk username enumeration is impractical (worst case
  // 28.8k guesses/day from a single IP), while giving normal retry headroom.
  const rateLimited = checkRateLimit(request, 'auth:username-lookup', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const body = await request.json();
  const { input } = body;

  if (!input || typeof input !== 'string') {
    return apiError('VALIDATION_ERROR', 'Missing or invalid input', 400);
  }

  const trimmedInput = input.trim().toLowerCase();

  // Detect format: Relay ID (8 dash-separated hex groups), short code
  // (4 letters-4 digits), or username — tried in that order since the first
  // two are unambiguous shapes that can't collide with a valid username.
  let user;

  const canonicalRelayId = normalizeRelayId(trimmedInput);
  const canonicalShortCode = normalizeShortCode(trimmedInput);
  const isShortCodeLookup = !canonicalRelayId && !!canonicalShortCode;

  // Short codes are a small, exhaustively enumerable space (4 letters + 4
  // digits, ~4.57B combinations) — unlike usernames (unbounded string space)
  // or the Relay ID (128 bits). The per-route request-count limit above
  // doesn't stop a scanner rotating IPs; this miss-tracked budget targets
  // what scanning actually looks like (mostly-404 traffic). See
  // app/api/profile/lookup/route.ts's identical guard.
  if (isShortCodeLookup) {
    const missLimited = checkMissRateLimit(request, 'auth:username-lookup:shortcode-miss', { maxRequests: 10, windowMs: 10 * 60_000 });
    if (missLimited) return missLimited;
  }

  if (canonicalRelayId) {
    user = await getUserByRelayId(canonicalRelayId);
  } else if (canonicalShortCode) {
    user = await getUserByShortCode(canonicalShortCode);
  } else {
    // Username lookup — strip a leading @ if present.
    const username = trimmedInput.replace(/^@/, '');

    // Real usernames are capped at 20 chars (see profile/update/route.ts's
    // ^[a-z0-9_]{1,20}$ validation at claim time) — anything longer can
    // never match a real user, so reject before wasting a lower()-query
    // round trip on it. Character-class alone didn't bound length.
    if (username.length > 20) {
      return apiError('VALIDATION_ERROR', 'Invalid username format', 400);
    }
    // Validate username format: alphanumeric + underscore
    if (!username.match(/^[a-z0-9_]+$/)) {
      return apiError('VALIDATION_ERROR', 'Invalid username format', 400);
    }

    user = await getUserByUsername(username);
  }

  // E1 (matches app/api/profile/lookup/route.ts's guard): unlisted users are
  // invisible here too, except to themselves. Previously missing on this
  // route — an unlisted user's opt-in short code or claimed username still
  // resolved to their relayId through this endpoint, undermining the
  // "hide from directory" guarantee every other lookup path enforces.
  const requesterRelayId = await getSessionRelayId(request);
  if (!user || (user.isUnlisted && requesterRelayId !== user.relayId)) {
    // Count as a miss for the shortCode miss-tracker regardless of whether
    // this was a genuine not-found or an isUnlisted block — both look
    // identical to the caller (404), and a privacy-gated match must not
    // give a scanner a way to skip the miss budget.
    if (isShortCodeLookup) recordMiss(request, 'auth:username-lookup:shortcode-miss', 10 * 60_000);
    // Don't leak whether it's a username/relayId/shortCode issue or a
    // privacy-gated match
    return apiError('NOT_FOUND', 'User not found', 404);
  }

  // Return only the relayId - nothing else to preserve privacy
  return NextResponse.json({
    relayId: user.relayId,
  });
});
