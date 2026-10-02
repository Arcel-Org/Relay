import { NextResponse, type NextRequest } from 'next/server';
import { getUserByRelayId, updateRecoveryCode, recordFailedLogin, isLocked, withLoginAttemptLock } from '@/lib/db/relay-server-db';
import { requireSession, revokeAllSessions, setSessionCookie } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { verifyTOTPCode, createTOTPFromSecret } from '@/lib/crypto/relay-auth';
import { isTotpCodeReplayed, markTotpCodeUsed } from '@/lib/crypto/totp-replay-guard';
import { decryptServerSecret } from '@/lib/crypto/totp-server-encryption';
import { verifyLoginResponse } from '@/lib/crypto/webauthn-server';
import { log } from '@/lib/platform/logger';

/**
 * Regenerate Recovery Code Endpoint
 *
 * The recovery code itself is generated and hashed client-side (pure crypto,
 * no server secret involved — see lib/crypto/recovery-code.ts) so the new
 * hash and the TOTP secret re-encrypted under it can be submitted together
 * in one request. See updateRecoveryCode() in relay-server-db.ts for why
 * that atomicity matters — the previous two-step design (server generates
 * the code, client uploads the re-encrypted TOTP secret in a follow-up call)
 * could permanently break recovery for an account if the second call never
 * arrived.
 *
 * Step-up auth: a valid session cookie alone used to be enough to call this —
 * a stolen session cookie (XSS, malware) could silently overwrite the
 * account's recovery code, both destroying the real owner's recovery path
 * and planting a persistent backdoor. This now requires the same live second
 * factor as login (TOTP code or WebAuthn assertion) before honoring the
 * regeneration, mirroring app/api/auth/login/route.ts's verification.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'auth:regen-recovery', { maxRequests: 3, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json();
  const { relayId, recoveryCodeHash, encryptedTOTPSecretForRecovery, totpCode, webauthnAssertion } = body;

  if (!relayId || !recoveryCodeHash || !encryptedTOTPSecretForRecovery) {
    return apiError('VALIDATION_ERROR', 'Missing required fields', 400);
  }

  if (typeof recoveryCodeHash !== 'string' || !/^[a-f0-9]{32,128}$/i.test(recoveryCodeHash)) {
    return apiError('VALIDATION_ERROR', 'Invalid recoveryCodeHash format', 400);
  }

  if (typeof encryptedTOTPSecretForRecovery !== 'string' || !/^[a-f0-9]{1,512}$/i.test(encryptedTOTPSecretForRecovery)) {
    return apiError('VALIDATION_ERROR', 'Invalid encryptedTOTPSecretForRecovery format', 400);
  }

  if (!totpCode && !webauthnAssertion) {
    return apiError('VALIDATION_ERROR', 'Second-factor verification is required', 400);
  }
  if (totpCode !== undefined && (typeof totpCode !== 'string' || totpCode.length !== 6)) {
    return apiError('VALIDATION_ERROR', 'Invalid TOTP code format', 400);
  }

  if (auth.relayId !== relayId) {
    return apiError('FORBIDDEN', 'Forbidden', 403);
  }

  // Serializes check-lock -> verify -> record-outcome per relayId — see
  // login/route.ts's matching comment for why (shared lockout, same race
  // otherwise possible here).
  return withLoginAttemptLock(relayId, async () => {
    const user = await getUserByRelayId(relayId);
    if (!user) {
      return apiError('NOT_FOUND', 'User not found', 404);
    }

    // Share the per-account lockout with login/recovery-login (A1) — without
    // this, repeated wrong TOTP/WebAuthn attempts against this endpoint
    // specifically never count toward or respect the account-wide lockout
    // every other second-factor check in this codebase enforces, so a
    // hijacked session cookie (XSS, malware, unattended device) could be used
    // to guess indefinitely, bounded only by this route's own 3/min IP limit.
    if (isLocked(user)) {
      log.error('[RegenRecoveryCode] Account temporarily locked:', user.id);
      return apiError(
        'UNAUTHORIZED',
        'Account temporarily locked due to repeated failed attempts. Try again later.',
        423
      );
    }

    const method = user.twoFactorMethod ?? 'totp';
    let secondFactorValid = false;

    if (method === 'webauthn') {
      if (webauthnAssertion) {
        const result = await verifyLoginResponse(relayId, webauthnAssertion);
        secondFactorValid = result.verified;
      }
    } else if (totpCode) {
      if (isTotpCodeReplayed(user.relayId, totpCode)) {
        secondFactorValid = false;
      } else {
        try {
          const totpSecretBytes = decryptServerSecret(user.encryptedTOTPSecret);
          const totp = createTOTPFromSecret(totpSecretBytes);
          secondFactorValid = verifyTOTPCode(totp, totpCode);
          if (secondFactorValid) markTotpCodeUsed(user.relayId, totpCode);
        } catch {
          secondFactorValid = false;
        }
      }
    }

    if (!secondFactorValid) {
      log.error('[RegenRecoveryCode] Second factor mismatch for user:', user.id);
      await recordFailedLogin(relayId);
      return apiError('UNAUTHORIZED', 'Invalid credentials', 401);
    }

    await updateRecoveryCode(relayId, recoveryCodeHash, encryptedTOTPSecretForRecovery);

    // Regenerating the recovery code invalidates the old one for anyone who
    // might have captured it (e.g. from a compromised device that also stole
    // a session cookie) — revoke every other live session so that device is
    // logged out too, not just left holding a now-stale but still-valid
    // cookie. Re-mint a fresh session for THIS request/response so the
    // caller (who just proved possession of the second factor) isn't logged
    // out by their own action.
    await revokeAllSessions(relayId);
    const response = NextResponse.json({ success: true });
    await setSessionCookie(response, relayId);
    return response;
  });
});
