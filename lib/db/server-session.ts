/**
 * Server-side session management
 *
 * Issues opaque, high-entropy session tokens (see lib/db/session-store.ts)
 * set as HttpOnly cookies on successful login/signup. Mutating API routes
 * call `requireSession` to verify the token and extract the authenticated
 * relayId.
 *
 * IMPORTANT: unlike the previous design, the cookie value carries no
 * information by itself — it is a random 256-bit token whose hash is
 * looked up in the server-side session store. Verifying a session
 * therefore requires the session to have actually been created by a
 * login/signup flow; it can no longer be forged from SESSION_SECRET plus
 * a relayId string alone.
 *
 * Backward compatibility: the previous scheme's tokens were
 * `<base64url payload>.<base64url signature>` and always contain a
 * literal '.'; opaque tokens are raw base64url random bytes and never
 * do. Old-format cookies are therefore rejected outright (clean 401,
 * not a crash) — existing logged-in users are required to log in again
 * once this change ships. This is intentional; there is no seamless
 * migration path for stateless-token holders into a server-verified
 * scheme.
 *
 * Token lifetime: 24 hours (see SESSION_LIFETIME_MS in session-store.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  verifySessionToken as verifyOpaqueToken,
  revokeSession as revokeOpaqueSession,
  revokeAllSessions as revokeAllOpaqueSessions,
  touchSessionActivity,
  setInactivityTimeout as setOpaqueInactivityTimeout,
  hashToken,
  SESSION_LIFETIME_MS,
} from './session-store';
import { isDevLikeEnv } from '@/lib/platform/env';
import { getUserByRelayId } from './relay-server-db';

export const SESSION_COOKIE = 'relay_session';

/** True for tokens minted by the retired HMAC scheme — always contain a '.'. */
function isLegacyToken(token: string): boolean {
  return token.includes('.');
}

/**
 * Create a new server-verified session for relayId and return the raw
 * opaque token. The token is single-use-to-set: it must be written to
 * the cookie immediately and is never stored anywhere in plaintext.
 */
export async function createSessionToken(relayId: string): Promise<string> {
  return createSession(relayId);
}

/**
 * Verify a session token and return the relayId it was issued for.
 * Returns null if the token is missing, invalid, expired, revoked, or in
 * the legacy (pre-hardening) format.
 */
export async function verifySessionToken(token: string): Promise<string | null> {
  if (!token || isLegacyToken(token)) return null;
  return verifyOpaqueToken(token);
}

/**
 * Set the session cookie on a NextResponse. Call this after a
 * successful login/signup. Mints a brand-new server-side session.
 */
export async function setSessionCookie(response: NextResponse, relayId: string): Promise<void> {
  const token = await createSessionToken(relayId);
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: !isDevLikeEnv(),
    path: '/',
    maxAge: SESSION_LIFETIME_MS / 1000,
  });
}

/**
 * Clear the session cookie (call on logout). This only removes the
 * client-side cookie; call `revokeCurrentSession` first if you also
 * want to invalidate the session server-side (recommended for logout).
 */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: !isDevLikeEnv(),
    path: '/',
    maxAge: 0,
  });
}

/**
 * Revoke the session tied to the request's cookie, if any (server-side
 * invalidation — a stolen/copied token stops working immediately rather
 * than staying valid until natural expiry). Safe to call even if there
 * is no session cookie or it's already invalid/legacy.
 */
export async function revokeCurrentSession(request: NextRequest): Promise<void> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token || isLegacyToken(token)) return;
  await revokeOpaqueSession(token);
}

/**
 * Revoke every session belonging to relayId ("log out everywhere", or
 * defensively after a credential change).
 */
export async function revokeAllSessions(relayId: string): Promise<void> {
  await revokeAllOpaqueSessions(relayId);
}

/**
 * Extract and verify the session from an incoming request.
 * Returns the authenticated relayId, or null if unauthenticated.
 *
 * Also confirms the account still exists. deleteUser() + revokeAllSessions()
 * (account-retention.ts's daily prune, or a future self-delete flow) are two
 * separate, non-atomic calls — a session created before the deletion can
 * otherwise stay verifiable (token itself is still valid, just now orphaned)
 * for up to its full 24h lifetime if the revoke half fails or hasn't run
 * yet. Checking against the users table closes that window.
 */
export async function getSessionRelayId(request: NextRequest): Promise<string | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const relayId = await verifySessionToken(token);
  if (!relayId) return null;
  const user = await getUserByRelayId(relayId);
  if (!user) return null;
  // Any successfully-authenticated request counts as activity — see
  // touchSessionActivity's doc comment. Fire-and-forget: this must never
  // block or fail the request it's piggybacking on.
  void touchSessionActivity(hashToken(token));
  return relayId;
}

/**
 * Set (or clear) the inactivity-timeout threshold for the CURRENT
 * request's session, mirroring the client's auto-logout setting so the
 * server can enforce it independent of the client. No-op if there is no
 * valid session cookie.
 */
export async function setSessionInactivityTimeout(
  request: NextRequest,
  timeoutMs: number | null
): Promise<void> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token || isLegacyToken(token)) return;
  await setOpaqueInactivityTimeout(token, timeoutMs);
}

/**
 * Convenience: verify the session and return a 401 response if invalid.
 * Usage:
 *   const auth = await requireSession(request);
 *   if (auth.error) return auth.error;
 *   const { relayId } = auth;
 */
export async function requireSession(
  request: NextRequest
): Promise<{ relayId: string; error?: never } | { relayId?: never; error: NextResponse }> {
  const relayId = await getSessionRelayId(request);
  if (!relayId) {
    return {
      error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    };
  }
  return { relayId };
}
