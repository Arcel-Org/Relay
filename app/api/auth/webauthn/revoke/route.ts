import { NextRequest, NextResponse } from 'next/server';
import { requireSession, revokeAllSessions, setSessionCookie } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { getUserByRelayId } from '@/lib/db/relay-server-db';
import { deleteCredentialIfAllowed } from '@/lib/db/webauthn-credentials-db';
import { log } from '@/lib/platform/logger';

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'webauthn:revoke', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const credentialId = body?.credentialId;
  if (typeof credentialId !== 'string' || !credentialId) {
    return apiError('VALIDATION_ERROR', 'Missing credentialId', 400);
  }

  const user = await getUserByRelayId(auth.relayId);
  const requireAtLeastOne = user?.twoFactorMethod === 'webauthn';

  // Atomic check-and-delete — closes the TOCTOU window where two concurrent
  // revoke requests could each see "more than one remains" and both delete.
  const result = await deleteCredentialIfAllowed(credentialId, auth.relayId, requireAtLeastOne);

  if (result === 'not_found') {
    log.warn('[WebAuthn] revoke: credential not found for user:', auth.relayId);
    return apiError('NOT_FOUND', 'Credential not found', 404);
  }
  if (result === 'last_remaining') {
    log.warn('[WebAuthn] revoke: refused to remove last remaining credential for user:', auth.relayId);
    return apiError(
      'VALIDATION_ERROR',
      'Cannot remove your only hardware key — register another one first, or you will be locked out of normal login.',
      400
    );
  }

  log.warn('[WebAuthn] revoke: credential removed, revoking all sessions for user:', auth.relayId);

  // A revoked hardware key could have been the one an attacker registered
  // (or a stolen session cookie could be riding alongside a legitimate
  // revoke) — revoke every other live session so a device holding a stale
  // cookie doesn't stay logged in past this credential change, then
  // re-mint a fresh session for this response so the caller isn't logged
  // out by their own action.
  await revokeAllSessions(auth.relayId);
  const response = NextResponse.json({ success: true }, { status: 200 });
  await setSessionCookie(response, auth.relayId);
  return response;
});
