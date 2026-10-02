import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isValidRelayId } from '@/lib/crypto/relay-id';
import { getUserByRelayId, isLocked } from '@/lib/db/relay-server-db';
import { generateLoginOptions } from '@/lib/crypto/webauthn-server';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'webauthn:login-options', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => null);
  const relayId = body?.relayId;
  if (!isValidRelayId(relayId)) return apiError('VALIDATION_ERROR', 'Invalid relayId', 400);

  // Unified response for missing/locked/wrong-method accounts — avoid
  // leaking which relayIds exist or their configured 2FA method (E1/E5 precedent).
  const GENERIC_ERROR = () => apiError('VALIDATION_ERROR', 'Unable to start hardware-key login', 400);

  const user = await getUserByRelayId(relayId);
  if (!user || user.twoFactorMethod !== 'webauthn' || isLocked(user)) return GENERIC_ERROR();

  const result = await generateLoginOptions(relayId);
  if ('error' in result) return GENERIC_ERROR();

  return NextResponse.json({ options: result.options }, { status: 200 });
});
