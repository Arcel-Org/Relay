import { NextRequest, NextResponse } from 'next/server';
import {
  updateUserProfile, getUserByRelayId, UsernameConflictError, ReservedUsernameError,
  generateAndAssignShortCode, clearShortCode,
} from '@/lib/db/relay-server-db';
import { requireSession } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { hasSuspiciousTextControlChars } from '@/lib/security/sanitize';

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — requireSession does a DB read
  // (session verification + account-existence check), so checking it first
  // let unauthenticated/garbage-cookie traffic cost a DB query per request
  // with no rate limiting at all.
  //
  // This endpoint updates displayName/username/bio/isUnlisted together, but
  // a settings UI that saves per-field (or on every keystroke of a
  // debounced bio edit) can legitimately fire several requests in quick
  // succession, e.g. a user changing their display name, then bio, then
  // toggling "unlisted" within the same minute. 20/min gives comfortable
  // headroom for that kind of rapid multi-field editing session while still
  // bounding the DB-write + username-uniqueness-check cost of an abusive
  // client hammering this route.
  const rateLimited = checkRateLimit(request, 'profile:update', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  // avatarEmoji and avatarColor are intentionally excluded — they are immutable after signup
  const {
    relayId, displayName, username, bio, isUnlisted,
    // Short code is opt-in and auto-generated (not user-typed like username),
    // so it's a request for an ACTION rather than a value to set directly —
    // mutually exclusive with each other, independent of the other fields.
    generateShortCode: shouldGenerateShortCode,
    removeShortCode,
  } = await request.json();

  if (!relayId) {
    return apiError('VALIDATION_ERROR', 'Missing relayId', 400);
  }

  if (typeof displayName === 'string' && displayName.length > 64) {
    return apiError('VALIDATION_ERROR', 'displayName too long', 400);
  }
  if (typeof bio === 'string' && bio.length > 500) {
    return apiError('VALIDATION_ERROR', 'bio too long', 400);
  }
  // Length caps alone don't catch bidi-override spoofing (a single control
  // character) or Zalgo-style stacked combining marks — both get echoed
  // back to every viewer via profile lookup/search.
  if (typeof displayName === 'string' && hasSuspiciousTextControlChars(displayName)) {
    return apiError('VALIDATION_ERROR', 'displayName contains disallowed characters', 400);
  }
  if (typeof bio === 'string' && hasSuspiciousTextControlChars(bio)) {
    return apiError('VALIDATION_ERROR', 'bio contains disallowed characters', 400);
  }

  // Enforce ownership — the session must belong to the relayId being updated
  if (auth.relayId !== relayId) {
    return apiError('FORBIDDEN', 'Forbidden', 403);
  }

  const user = await getUserByRelayId(relayId);
  if (!user) {
    return apiError('NOT_FOUND', 'User not found', 404);
  }

  const normalizedUsername =
    typeof username === 'string' ? username.trim().toLowerCase() : username;

  if (normalizedUsername !== undefined && normalizedUsername !== null) {
    if (!/^[a-z0-9_]{1,20}$/.test(normalizedUsername)) {
      return apiError('VALIDATION_ERROR', 'Invalid username format', 400);
    }
  }

  // Z2: uniqueness check is now inside updateUserProfile's write lock — no TOCTOU race
  let updated;
  try {
    updated = await updateUserProfile(relayId, {
      displayName,
      username: normalizedUsername,
      bio,
      isUnlisted,
    });
  } catch (err) {
    if (err instanceof UsernameConflictError) {
      return apiError('CONFLICT', 'Username is already taken', 409);
    }
    if (err instanceof ReservedUsernameError) {
      return apiError('VALIDATION_ERROR', 'This username is reserved', 400);
    }
    throw err;
  }

  // Deliberately its own try/catch, separate from updateUserProfile above —
  // by this point displayName/username/bio/isUnlisted may have already been
  // committed. Letting a shortCode-action failure fall through to
  // withErrorHandler's generic 500 would report the WHOLE request as failed
  // even though those other edits already saved, and the client would have
  // no way to know that. Report the short-code action's own failure
  // separately instead, alongside the profile fields that did succeed.
  let shortCode: string | null | undefined = updated?.shortCode;
  let shortCodeError: string | undefined;
  if (shouldGenerateShortCode) {
    try {
      shortCode = await generateAndAssignShortCode(relayId);
    } catch (err) {
      shortCodeError = err instanceof Error ? err.message : 'Failed to generate short code';
    }
  } else if (removeShortCode) {
    try {
      await clearShortCode(relayId);
      shortCode = null;
    } catch (err) {
      shortCodeError = err instanceof Error ? err.message : 'Failed to remove short code';
    }
  }

  return NextResponse.json(
    {
      success: true,
      profile: {
        relayId: updated?.relayId,
        displayName: updated?.displayName,
        username: updated?.username,
        bio: updated?.bio,
        isUnlisted: updated?.isUnlisted,
        shortCode,
      },
      ...(shortCodeError ? { shortCodeError } : {}),
    },
    { status: 200 }
  );
});
