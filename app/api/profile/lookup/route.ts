import { NextRequest, NextResponse } from 'next/server';
import { getUserByUsername, getUserByRelayId, getUserByShortCode, updateAvatarIfMissing } from '@/lib/db/relay-server-db';
import { generateAvatar } from '@/lib/avatar-constants';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit, checkMissRateLimit, recordMiss } from '@/lib/security/rate-limit';
import { normalizeRelayId, normalizeShortCode } from '@/lib/crypto/relay-id';
import { getSessionRelayId } from '@/lib/db/server-session';

// Lazily assign an avatar to legacy accounts that predate the avatar feature.
// Fire-and-forget — we don't block the response on the write.
function ensureAvatarAsync(user: NonNullable<Awaited<ReturnType<typeof getUserByRelayId>>>) {
  if (user.avatarEmoji && user.avatarColor) return;
  const avatar = generateAvatar();
  user.avatarEmoji = avatar.emoji;
  user.avatarColor = avatar.color;
  // Targeted, conditional update — not a full-row saveUser() upsert, which
  // would revert any concurrent profile edit made from this stale snapshot.
  updateAvatarIfMissing(user.relayId, avatar.emoji, avatar.color).catch(() => undefined);
}

function publicProfile(user: NonNullable<Awaited<ReturnType<typeof getUserByRelayId>>>) {
  return {
    relayId: user.relayId,
    displayName: user.displayName,
    username: user.username,
    bio: user.bio,
    avatarEmoji: user.avatarEmoji,
    avatarColor: user.avatarColor,
    // Public key material — both are, by design, public (that's the point of
    // a key exchange). Exposing them here gives the client an authenticated
    // (HTTPS/TLS) channel to learn a peer's PQ capability BEFORE the first
    // WS key-exchange message ever arrives — see username-lookup.ts's
    // lookupUserProfile, which pre-seeds the contact-key-cache from this so
    // key-exchange.ts's existing "known PQ-capable peer sent a classical-only
    // offer" downgrade-refusal check also covers true first contact, not
    // just re-negotiation with an already-known contact. publicKeyHex is
    // self-certifying (relayId = hash(publicKeyHex)) so the client verifies
    // it against the requested relayId before trusting it.
    publicKeyHex: user.publicKeyHex,
    pqPublicKeyHex: user.pqPublicKeyHex,
    // Opt-in discoverability alias — only present if the user generated one.
    // Safe to include on every lookup regardless of how the caller found
    // this profile (username/relayId/shortCode): a short code's whole point
    // is being freely shareable, so revealing it to someone who already
    // resolved the identity by some other means isn't a new exposure.
    shortCode: user.shortCode,
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  // E2: rate-limit profile harvesting — 30 req/min per IP
  const rateLimited = checkRateLimit(request, 'profile:lookup', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const username = searchParams.get('username');
  const relayId = searchParams.get('relayId');
  const shortCode = searchParams.get('shortCode');

  if (!username && !relayId && !shortCode) {
    return apiError('VALIDATION_ERROR', 'Missing username, relayId, or shortCode parameter', 400);
  }

  if (username !== null && !username.trim()) {
    return apiError('VALIDATION_ERROR', 'Username cannot be empty', 400);
  }

  if (relayId !== null && (!relayId.trim() || relayId === ':1')) {
    return apiError('VALIDATION_ERROR', 'Invalid relayId parameter', 400);
  }

  // Authenticated requester — used to allow self-lookup of unlisted accounts.
  const requesterRelayId = await getSessionRelayId(request);

  if (username) {
    const trimmedUsername = username.toLowerCase().trim();
    const user = await getUserByUsername(trimmedUsername);

    // E1: unlisted users are invisible to unauthenticated requesters and to
    // other users — they can only look themselves up.
    if (!user || (user.isUnlisted && requesterRelayId !== user.relayId)) {
      return apiError('NOT_FOUND', 'User not found', 404);
    }

    ensureAvatarAsync(user);
    return NextResponse.json(publicProfile(user), { status: 200 });
  }

  if (shortCode) {
    // Short codes are a small, fully-structured, exhaustively enumerable
    // space (4 letters + 4 digits, ~4.57B combinations) — unlike usernames
    // (unbounded string space) or the Relay ID (128 bits). The per-IP
    // request-count limit above doesn't stop a scanner rotating IPs; this
    // miss-tracking limiter targets what scanning actually looks like
    // (mostly-404 traffic) with a much stricter budget, independent of the
    // general per-route counter. See lib/security/rate-limit.ts.
    const missLimited = checkMissRateLimit(request, 'profile:lookup:shortcode-miss', { maxRequests: 10, windowMs: 10 * 60_000 });
    if (missLimited) return missLimited;

    const canonicalShortCode = normalizeShortCode(shortCode);
    if (!canonicalShortCode) {
      return apiError('VALIDATION_ERROR', 'Invalid shortCode format', 400);
    }
    const user = await getUserByShortCode(canonicalShortCode);
    if (!user || (user.isUnlisted && requesterRelayId !== user.relayId)) {
      recordMiss(request, 'profile:lookup:shortcode-miss', 10 * 60_000);
      return apiError('NOT_FOUND', 'User not found', 404);
    }
    ensureAvatarAsync(user);
    return NextResponse.json(publicProfile(user), { status: 200 });
  }

  const canonical = normalizeRelayId(relayId!);
  if (!canonical) {
    return apiError('VALIDATION_ERROR', 'Invalid relayId format', 400);
  }

  const user = await getUserByRelayId(canonical);

  if (!user || (user.isUnlisted && requesterRelayId !== user.relayId)) {
    return apiError('NOT_FOUND', 'User not found', 404);
  }

  ensureAvatarAsync(user);
  return NextResponse.json(publicProfile(user), { status: 200 });
});
