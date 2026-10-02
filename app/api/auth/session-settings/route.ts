import { NextRequest, NextResponse } from 'next/server';
import { requireSession, setSessionInactivityTimeout } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

// Mirrors the longest option in AUTO_LOGOUT_OPTIONS (lib/auth/auto-logout.ts,
// 24h) — keep in sync. Anything beyond this is rejected rather than clamped,
// since a client sending an out-of-range value is more likely buggy/hostile
// than intentionally trying to opt into "almost never".
const MAX_INACTIVITY_SECONDS = 24 * 60 * 60;

/**
 * Sync the client's configured auto-logout duration (lib/auth/auto-logout.ts)
 * onto the current session so the server can enforce it independently of the
 * client (see lib/db/session-store.ts's isIdleExpired/touchSessionActivity).
 * Called whenever the setting changes and once on app load/unlock.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'auth:session-settings', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const raw = body?.inactivityTimeoutSeconds;

  let timeoutMs: number | null;
  if (raw === null) {
    timeoutMs = null;
  } else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= MAX_INACTIVITY_SECONDS) {
    timeoutMs = Math.floor(raw) * 1000;
  } else {
    return apiError('VALIDATION_ERROR', 'Invalid inactivityTimeoutSeconds', 400);
  }

  await setSessionInactivityTimeout(request, timeoutMs);
  return NextResponse.json({ success: true }, { status: 200 });
});
