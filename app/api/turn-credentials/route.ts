import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { requireSession } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isDevLikeEnv } from '@/lib/platform/env';

// Standard TURN REST API credential mechanism (coturn's --use-auth-secret):
// username = "<expiryUnixSeconds>:<relayId>", credential = base64(HMAC-SHA1(secret, username)).
// coturn independently recomputes and checks this HMAC — nothing is stored
// per-credential, so there is NO server-side revocation list: a credential
// issued while the session was valid keeps working until it expires, even
// if the session is logged out/revoked in the meantime (unlike ws-ticket,
// which binds to a hash of the session cookie so a session revocation
// invalidates outstanding tickets too — coturn's stock auth-secret mechanism
// has no equivalent binding). Bounding TTL is the only lever available
// without adding a stateful TURN REST backend, so it's kept short — long
// enough for one call, short enough to bound a leaked-credential's exposure
// window to well under a session's typical lifetime.
const CREDENTIAL_TTL_SECONDS = 60 * 60; // 1 hour

function getTurnSecret(): string | null {
  const secret = process.env.TURN_SECRET;
  if (!secret || secret.length < 16) {
    if (!isDevLikeEnv()) return null;
    return 'dev-only-turn-secret-change-me';
  }
  return secret;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'turn:credentials', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const secret = getTurnSecret();
  if (!secret) {
    // No TURN server configured for this deployment — callers fall back to
    // STUN/P2P (iceTransportPolicy 'all') rather than crashing the call setup.
    return NextResponse.json({ configured: false });
  }

  const expiry = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL_SECONDS;
  const username = `${expiry}:${auth.relayId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');

  const host = request.headers.get('host')?.split(':')[0] || 'localhost';
  const turnHost = process.env.TURN_PUBLIC_HOST || host;

  return NextResponse.json({
    configured: true,
    username,
    credential,
    urls: [
      `turn:${turnHost}:3478`,
      `turn:${turnHost}:3478?transport=tcp`,
    ],
    ttlSeconds: CREDENTIAL_TTL_SECONDS,
  });
});
