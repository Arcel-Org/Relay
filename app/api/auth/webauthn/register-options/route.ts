import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/db/server-session';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { getUserByRelayId } from '@/lib/db/relay-server-db';
import { generateAdditionalKeyOptions } from '@/lib/crypto/webauthn-server';

/** Start adding an additional hardware key to an already-existing, authenticated account. */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'webauthn:register-options', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const user = await getUserByRelayId(auth.relayId);
  if (!user) return apiError('NOT_FOUND', 'User not found', 404);
  if (user.twoFactorMethod !== 'webauthn') {
    return apiError('VALIDATION_ERROR', 'This account uses an authenticator app, not hardware keys', 400);
  }

  const options = await generateAdditionalKeyOptions(auth.relayId);
  return NextResponse.json({ options }, { status: 200 });
});
