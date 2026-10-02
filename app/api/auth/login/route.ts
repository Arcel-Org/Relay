import { NextRequest, NextResponse } from 'next/server';
import { getUserByRelayId, updateLastLogin, recordFailedLogin, isLocked, withLoginAttemptLock } from '@/lib/db/relay-server-db';
import { verifyTOTPCode, createTOTPFromSecret } from '@/lib/crypto/relay-auth';
import { isTotpCodeReplayed, markTotpCodeUsed } from '@/lib/crypto/totp-replay-guard';
import { decryptServerSecret } from '@/lib/crypto/totp-server-encryption';
import { verifyLoginResponse } from '@/lib/crypto/webauthn-server';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { setSessionCookie } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { log } from '@/lib/platform/logger';
import { isValidRelayId } from '@/lib/crypto/relay-id';

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate limit: 15 attempts per minute per IP handle.
  //
  // This is IP-scoped, not account-scoped — the real per-account
  // brute-force defense is the lockout in recordFailedLogin/isLocked (10
  // failed PIN/TOTP attempts -> 15 min lock on that relayId, independent of
  // source IP). This IP limit is a secondary speed bump against
  // credential-stuffing sprays across many accounts from one IP.
  //
  // Every request behind a shared IP (office NAT, CGNAT, campus Wi-Fi, or
  // Cloudflare's edge IP when CF-Connecting-IP isn't available) shares one
  // bucket, so a low threshold here locks out unrelated legitimate users. 5
  // /min was tight enough that a handful of coworkers logging in around the
  // same minute — or anyone retrying once after a PIN typo or TOTP clock
  // skew — could exhaust the whole shared budget. 15/min still bounds spray
  // attacks to a crawl while giving a shared IP realistic headroom for
  // several real logins (each normally needs 1 request; a retry or two per
  // person is still comfortably inside budget).
  const rateLimited = checkRateLimit(request, 'auth:login', { maxRequests: 15, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const body = await request.json();
  const { relayId, totpCode, webauthnAssertion } = body;

  // Validate inputs — PIN is no longer sent to the server (client-side only)
  if (!relayId || (!totpCode && !webauthnAssertion)) {
    return apiError('VALIDATION_ERROR', 'Missing required fields', 400);
  }
  // Unlike signup/webauthn routes, this only ever truthiness-checked
  // relayId — a non-string body value would reach getUserByRelayId's
  // parameterized query as-is and throw a raw type error there instead of
  // failing cleanly here, and a valid-but-attacker-controlled string was
  // being interpolated unescaped into log.error below (log injection: a
  // newline/ANSI-escape-bearing relayId could forge fake log lines).
  if (!isValidRelayId(relayId)) {
    return apiError('VALIDATION_ERROR', 'Invalid relayId format', 400);
  }
  if (totpCode !== undefined && (typeof totpCode !== 'string' || totpCode.length !== 6)) {
    return apiError('VALIDATION_ERROR', 'Invalid TOTP code format', 400);
  }

  // Unified failure response for all auth-miss cases to avoid enumeration /
  // oracle side-channels (E5/E6).
  const INVALID_CREDS = () => apiError('UNAUTHORIZED', 'Invalid credentials', 401);

  // Serializes the whole check-lock -> verify -> record-outcome sequence per
  // relayId — without this, a burst of concurrent attempts for the same
  // relayId could each read a pre-lock snapshot of the user row and all
  // attempt verification before any of them committed a failure, letting a
  // well-timed burst get more concurrent guesses through than the 10-guess
  // lockout budget was meant to allow in one shot. The user row is
  // (re-)fetched INSIDE the lock, not before it, so a request that waited
  // in queue behind another one for the same relayId sees that request's
  // outcome (fresh lockedUntil/failedLoginAttempts), not a stale read from
  // before it even started waiting.
  return withLoginAttemptLock(relayId, async () => {
    const user = await getUserByRelayId(relayId);
    if (!user) {
      log.error(`[Login] User not found for relayId: "${relayId}"`);
      return INVALID_CREDS();
    }

    // Per-account lockout (A1). Enforced before expensive crypto so a locked
    // account also gets faster responses.
    if (isLocked(user)) {
      log.error('[Login] Account temporarily locked:', user.id);
      return apiError(
        'UNAUTHORIZED',
        'Account temporarily locked due to repeated failed attempts. Try again later.',
        423
      );
    }

    const method = user.twoFactorMethod ?? 'totp';
    let secondFactorValid = false;

    if (method === 'webauthn') {
      if (!webauthnAssertion) {
        log.error('[Login] webauthn account attempted login without an assertion:', user.id);
      } else {
        const result = await verifyLoginResponse(relayId, webauthnAssertion);
        secondFactorValid = result.verified;
        if (!result.verified) log.error('[Login] WebAuthn verification failed for user:', user.id, result.error);
      }
    } else {
      if (!totpCode) {
        log.error('[Login] totp account attempted login without a code:', user.id);
      } else if (isTotpCodeReplayed(user.relayId, totpCode)) {
        // verifyTOTPCode accepts a ~60s window either side of "now" for clock
        // skew — without this check, an intercepted code stays usable for a
        // second concurrent login within that same window.
        log.error('[Login] Rejected replayed TOTP code for user:', user.id);
      } else {
        // encryptedTOTPSecret is encrypted at rest with a server-only key
        // (TOTP_ENCRYPTION_KEY, never stored in the DB) — decrypt in-memory
        // just for this comparison.
        try {
          const totpSecretBytes = decryptServerSecret(user.encryptedTOTPSecret);
          const totp = createTOTPFromSecret(totpSecretBytes);
          secondFactorValid = verifyTOTPCode(totp, totpCode);
          if (secondFactorValid) markTotpCodeUsed(user.relayId, totpCode);
        } catch (err) {
          log.error('[Login] Failed to decrypt stored TOTP secret for user:', user.id);
        }
      }
    }

    if (!secondFactorValid) {
      log.error('[Login] Second factor mismatch for user:', user.id);
      const { locked } = await recordFailedLogin(relayId);
      // relayId is a public, contact-shared identifier by design (see
      // relay-id.ts) — anyone who has it can trigger this lockout without
      // knowing anything else about the account. There's no CAPTCHA or
      // out-of-band user notification wired up yet (this identity system has
      // no email/contact channel to notify through), so this log line is the
      // only current signal a griefing pattern (repeated relock of the same
      // relayId) is happening — needed for ops to notice and react.
      if (locked) log.warn('[Login] Account locked after repeated failed attempts:', user.id);
      return INVALID_CREDS();
    }

    // Update last login timestamp
    await updateLastLogin(relayId);

    // Return minimal user info — private key material stays on the client only.
    const successResponse = NextResponse.json(
      {
        success: true,
        user: {
          id: user.id,
          relayId: user.relayId,
          createdAt: user.createdAt,
          username: user.username || null,
          displayName: user.displayName || null,
        },
      },
      { status: 200 }
    );

    // Set HttpOnly session cookie for authenticated API calls
    await setSessionCookie(successResponse, user.relayId);
    return successResponse;
  });
});
