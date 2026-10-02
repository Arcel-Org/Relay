import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isValidRelayId } from '@/lib/crypto/relay-id';
import { getUserByRelayId } from '@/lib/db/relay-server-db';
import { generatePreRegistrationOptions } from '@/lib/crypto/webauthn-server';

/**
 * Pre-account WebAuthn registration challenge — used during signup, before
 * the account row exists. Unauthenticated by necessity (no session yet), so
 * strictly validate relayId format and reject if that relayId is already
 * claimed (prevents an attacker from generating credential-registration
 * challenges against someone else's already-registered relayId).
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'webauthn:pre-register-options', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => null);
  const relayId = body?.relayId;
  if (!isValidRelayId(relayId)) return apiError('VALIDATION_ERROR', 'Invalid relayId', 400);

  const existing = await getUserByRelayId(relayId);
  if (existing) return apiError('CONFLICT', 'relayId already registered', 409);

  const options = await generatePreRegistrationOptions(relayId);
  return NextResponse.json({ options }, { status: 200 });
});
