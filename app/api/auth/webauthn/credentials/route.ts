import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { getUserByRelayId } from '@/lib/db/relay-server-db';
import { getCredentialsByRelayId } from '@/lib/db/webauthn-credentials-db';
import { checkRateLimit } from '@/lib/security/rate-limit';

/** List the authenticated user's registered hardware keys (no secret material returned). */
export const GET = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'webauthn:credentials', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const user = await getUserByRelayId(auth.relayId);
  if (!user) return apiError('NOT_FOUND', 'User not found', 404);

  const creds = await getCredentialsByRelayId(auth.relayId);
  return NextResponse.json({
    twoFactorMethod: user.twoFactorMethod ?? 'totp',
    credentials: creds.map((c) => ({
      credentialId: c.credentialId,
      transports: c.transports,
      createdAt: c.createdAt,
    })),
  });
});
