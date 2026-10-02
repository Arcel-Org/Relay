import { NextRequest, NextResponse } from 'next/server';
import { getUserByRelayId, deleteUser, recordFailedLogin, isLocked, withLoginAttemptLock } from '@/lib/db/relay-server-db';
import { requireSession, revokeAllSessions, clearSessionCookie } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { verifyTOTPCode, createTOTPFromSecret } from '@/lib/crypto/relay-auth';
import { isTotpCodeReplayed, markTotpCodeUsed } from '@/lib/crypto/totp-replay-guard';
import { decryptServerSecret } from '@/lib/crypto/totp-server-encryption';
import { verifyLoginResponse } from '@/lib/crypto/webauthn-server';
import { log } from '@/lib/platform/logger';

/**
 * Permanently delete the CALLING session's own account — session-
 * authenticated only, never trusts a client-supplied relayId, so this can
 * only ever delete the account the request is actually authenticated as.
 *
 * Step-up auth: a valid session cookie alone used to be enough to call this
 * — a stolen session cookie (XSS, malware) could permanently and
 * irreversibly destroy the victim's account, the single most destructive
 * action in this API. This now requires a live second factor (TOTP code or
 * WebAuthn assertion), mirroring login and regenerate-recovery-code.
 *
 * Two callers rely on this route:
 * 1. Settings' interactive "Delete account" action — now prompts for a
 *    fresh second factor before calling this (see SettingsPanel.tsx).
 * 2. relay-auth-store-v2.ts's duress-PIN and 5-failed-PIN-attempt wipe
 *    flows, which call deleteAccountOnServerBestEffort() with no second
 *    factor available (there's no user present to type a code — that's the
 *    entire point of an automatic panic wipe). Those calls will now get a
 *    401 here and no-op server-side, same as before server-side deletion
 *    for this path existed at all — already documented and handled as
 *    best-effort; the LOCAL wipe (IndexedDB/localStorage) never depended on
 *    this call succeeding. Losing server-side cleanup for the panic-wipe
 *    case is an accepted, bounded trade-off for closing a real stolen-
 *    cookie account-destruction vector on the interactive path.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'auth:delete-account', { maxRequests: 5, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const totpCode = typeof body?.totpCode === 'string' ? body.totpCode : undefined;
  const webauthnAssertion = body?.webauthnAssertion && typeof body.webauthnAssertion === 'object' ? body.webauthnAssertion : undefined;
  if (!totpCode && !webauthnAssertion) {
    return apiError('VALIDATION_ERROR', 'Second-factor verification is required', 400);
  }

  // Serializes check-lock -> verify -> record-outcome per relayId — see
  // login/route.ts's matching comment for why (shared lockout, same race
  // otherwise possible here).
  return withLoginAttemptLock(auth.relayId, async () => {
    const user = await getUserByRelayId(auth.relayId);
    if (!user) {
      return apiError('NOT_FOUND', 'User not found', 404);
    }

    if (isLocked(user)) {
      log.error('[DeleteAccount] Account temporarily locked:', user.id);
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
        const result = await verifyLoginResponse(auth.relayId, webauthnAssertion);
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
      log.error('[DeleteAccount] Second factor mismatch for user:', user.id);
      await recordFailedLogin(auth.relayId);
      return apiError('UNAUTHORIZED', 'Invalid credentials', 401);
    }

    // deleteUser (relay-server-db.ts) already handles the full cleanup
    // transactionally: the users row (cascading to webauthn_credentials via
    // its ON DELETE CASCADE foreign key) and delisting any public group this
    // account owned.
    await deleteUser(user.id);
    await revokeAllSessions(auth.relayId);

    log.warn('[DeleteAccount] Account deleted:', auth.relayId);

    const response = NextResponse.json({ success: true }, { status: 200 });
    clearSessionCookie(response);
    return response;
  });
});
