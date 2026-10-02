import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { requireSession, SESSION_COOKIE } from '@/lib/db/server-session';
import { hashToken } from '@/lib/db/session-store';
import { withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isDevLikeEnv } from '@/lib/platform/env';

const TICKET_LIFETIME_MS = 15 * 60 * 1000;

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (!isDevLikeEnv()) {
      throw new Error('SESSION_SECRET is required (only development/test may use the insecure dev fallback)');
    }
    return 'dev-only-session-secret-change-me-in-production!!';
  }
  return secret;
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'auth:ws-ticket', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  // requireSession does a DB-backed lookup, so this fails closed for a
  // revoked or expired session — a ticket can never be minted from one.
  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  // Bind the ticket to the specific session that minted it (via a hash of
  // the session cookie, never the raw token) so the relay server can
  // independently confirm — at connect time — that the session is still
  // live. This means revoking a session invalidates any outstanding,
  // not-yet-expired ticket too, not just future ticket mints.
  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value ?? '';
  const sessionHash = hashToken(sessionToken);

  const payload = Buffer.from(`${auth.relayId}:${Date.now()}:${sessionHash}`).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(payload).digest('base64url');
  const ticket = `${payload}.${sig}`;

  return NextResponse.json({ ticket, expiresIn: TICKET_LIFETIME_MS / 1000 });
});
