import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie, revokeCurrentSession } from '@/lib/db/server-session';
import { withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'auth:logout', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  // Revoke server-side so a stolen/copied token stops working immediately,
  // not just once the cookie is gone from this browser.
  await revokeCurrentSession(request);

  const response = NextResponse.json({ ok: true }, { status: 200 });
  clearSessionCookie(response);
  return response;
});
