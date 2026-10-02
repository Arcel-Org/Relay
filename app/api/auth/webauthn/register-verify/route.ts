import { NextRequest, NextResponse } from 'next/server';
import { requireSession, revokeAllSessions, setSessionCookie } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { getUserByRelayId, recordFailedLogin, isLocked, withLoginAttemptLock } from '@/lib/db/relay-server-db';
import { verifyAndStoreAdditionalKey, verifyLoginResponse } from '@/lib/crypto/webauthn-server';
import { log } from '@/lib/platform/logger';

/**
 * Complete adding an additional hardware key to an already-existing,
 * authenticated account.
 *
 * Step-up auth: a valid session cookie alone used to be enough to call this
 * — a stolen session cookie (XSS, malware) could plant an attacker-owned
 * hardware key as a permanent, independent login credential, surviving the
 * original cookie's expiry. This now requires a fresh WebAuthn assertion
 * from an EXISTING credential (obtained the same way login does, via
 * /api/auth/webauthn/login-options) before accepting the new one, mirroring
 * regenerate-recovery-code/route.ts's step-up pattern, and revokes every
 * other live session afterward so a device holding a stale cookie is logged
 * out by the same change that would let it plant a backdoor.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'webauthn:register-verify', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const response = body?.response;
  const webauthnAssertion = body?.webauthnAssertion;
  if (!response || typeof response !== 'object') return apiError('VALIDATION_ERROR', 'Invalid request', 400);
  if (!webauthnAssertion || typeof webauthnAssertion !== 'object') {
    return apiError('VALIDATION_ERROR', 'Second-factor verification is required', 400);
  }

  // Serializes check-lock -> verify -> record-outcome per relayId — see
  // login/route.ts's matching comment for why (shared lockout, same race
  // otherwise possible here).
  return withLoginAttemptLock(auth.relayId, async () => {
    const user = await getUserByRelayId(auth.relayId);
    if (!user) return apiError('NOT_FOUND', 'User not found', 404);
    if (user.twoFactorMethod !== 'webauthn') {
      return apiError('VALIDATION_ERROR', 'This account uses an authenticator app, not hardware keys', 400);
    }

    // Share the per-account lockout with login/recovery-login/regen-recovery-
    // code (A1) — without this, repeated wrong assertions against this
    // endpoint specifically never count toward the account-wide lockout a
    // hijacked session cookie could otherwise use to guess indefinitely.
    if (isLocked(user)) {
      log.error('[WebAuthn] register-verify: account temporarily locked:', user.id);
      return apiError(
        'UNAUTHORIZED',
        'Account temporarily locked due to repeated failed attempts. Try again later.',
        423
      );
    }

    const stepUp = await verifyLoginResponse(auth.relayId, webauthnAssertion);
    if (!stepUp.verified) {
      log.error('[WebAuthn] register-verify: step-up verification failed for user:', auth.relayId, stepUp.error);
      await recordFailedLogin(auth.relayId);
      return apiError('UNAUTHORIZED', 'Invalid credentials', 401);
    }

    const result = await verifyAndStoreAdditionalKey(auth.relayId, response);
    if (!result.success) {
      log.error('[WebAuthn] register-verify failed for user:', auth.relayId, result.error);
      return apiError('VALIDATION_ERROR', result.error, 400);
    }

    // A newly planted credential could be the attacker's own (riding a
    // stolen session cookie alongside a legitimate add) — revoke every
    // other live session so a device holding a stale cookie doesn't stay
    // logged in past this credential change, then re-mint a fresh session
    // for this response so the caller (who just proved possession of an
    // existing factor) isn't logged out by their own action.
    await revokeAllSessions(auth.relayId);
    const res = NextResponse.json({ success: true }, { status: 200 });
    await setSessionCookie(res, auth.relayId);
    return res;
  });
});
