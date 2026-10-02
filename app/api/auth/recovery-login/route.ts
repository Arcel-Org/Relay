import { NextRequest, NextResponse } from 'next/server';
import { getUserByRelayId, recordFailedLogin, isLocked, updateLastLogin, withLoginAttemptLock } from '@/lib/db/relay-server-db';
import { verifyTOTPForRecovery } from '@/lib/crypto/relay-auth';
import { verifyRecoveryCode } from '@/lib/crypto/recovery-code';
import { isTotpCodeReplayed, markTotpCodeUsed } from '@/lib/crypto/totp-replay-guard';
import { isValidRelayId } from '@/lib/crypto/relay-id';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { setSessionCookie } from '@/lib/db/server-session';
import { log } from '@/lib/platform/logger';

/**
 * Recovery Login Endpoint
 * Allows users to login with recovery code instead of PIN
 * Used when account needs to be recovered (e.g., after clearing site data)
 *
 * Security: Verifies recovery code hash AND TOTP code (TOTP decrypted using recovery code)
 * No compromises - requires both recovery code AND current TOTP code
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // A3: rate-limit recovery attempts — stricter than login (3/min, not 5/min)
  const rateLimited = checkRateLimit(request, 'auth:recovery-login', { maxRequests: 3, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const body = await request.json();
  const { relayId, recoveryCode, totpCode } = body;

  // Validate inputs
  if (!relayId || !recoveryCode || !totpCode) {
    return apiError('VALIDATION_ERROR', 'Missing required fields', 400);
  }
  if (!isValidRelayId(relayId)) {
    return apiError('VALIDATION_ERROR', 'Invalid relayId format', 400);
  }

  if (totpCode.length !== 6) {
    return apiError('VALIDATION_ERROR', 'Invalid TOTP code format', 400);
  }

  const INVALID = () => apiError('UNAUTHORIZED', 'Invalid credentials', 401);

  // Serializes check-lock -> verify -> record-outcome per relayId — see
  // login/route.ts's matching comment for why (shared lockout, same race
  // otherwise possible here).
  return withLoginAttemptLock(relayId, async () => {
    const user = await getUserByRelayId(relayId);
    if (!user) {
      log.error(`[RecoveryLogin] User not found for relayId: "${relayId}"`);
      return INVALID();
    }

    // Share the per-account lockout with /api/auth/login (A1).
    if (isLocked(user)) {
      log.error('[RecoveryLogin] Account temporarily locked:', user.id);
      return apiError(
        'UNAUTHORIZED',
        'Account temporarily locked due to repeated failed attempts. Try again later.',
        423
      );
    }

    // Verify recovery code against hash (irreversible check)
    if (!user.recoveryCodeHash || !verifyRecoveryCode(recoveryCode, user.recoveryCodeHash).valid) {
      log.error('[RecoveryLogin] Invalid recovery code for user:', user.id);
      await recordFailedLogin(relayId);
      return INVALID();
    }

    // Verify TOTP code using recovery code to decrypt the TOTP secret
    // This ensures account recovery requires BOTH valid recovery code AND valid TOTP
    if (!user.encryptedTOTPSecretForRecovery) {
      return apiError('VALIDATION_ERROR', 'Recovery not available for this account', 400);
    }

    // Every other route that verifies a TOTP code (login, regenerate-recovery-
    // code) rejects a code already used within its validity window — without
    // this, an intercepted (recoveryCode, totpCode) pair stays usable for a
    // second, concurrent recovery-login within that same ~60s window.
    if (isTotpCodeReplayed(user.relayId, totpCode)) {
      log.error('[RecoveryLogin] Rejected replayed TOTP code for user:', user.id);
      await recordFailedLogin(relayId);
      return INVALID();
    }

    const totpVerified = verifyTOTPForRecovery(
      user.encryptedTOTPSecretForRecovery,
      recoveryCode,
      totpCode
    );

    if (!totpVerified) {
      log.error('[RecoveryLogin] TOTP verification failed for user:', user.id);
      await recordFailedLogin(relayId);
      return INVALID();
    }
    markTotpCodeUsed(user.relayId, totpCode);

    // Success! Both recovery code and TOTP code verified.
    await updateLastLogin(relayId);

    const successResponse = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        relayId: user.relayId,
        createdAt: user.createdAt,
      },
      publicKeyHex: user.publicKeyHex,
    });

    await setSessionCookie(successResponse, user.relayId);
    return successResponse;
  });
});
