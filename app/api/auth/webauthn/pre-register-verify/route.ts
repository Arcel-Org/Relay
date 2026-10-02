import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isValidRelayId } from '@/lib/crypto/relay-id';
import { getUserByRelayId } from '@/lib/db/relay-server-db';
import { verifyPreRegistrationAndIssueTicket } from '@/lib/crypto/webauthn-server';
import { log } from '@/lib/platform/logger';

/**
 * Verifies the hardware-key registration ceremony completed during signup.
 * Returns a short-lived signed ticket — nothing is persisted here. The
 * signup route consumes the ticket and inserts the credential atomically
 * with the new user row, so an abandoned signup leaves no server state.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'webauthn:pre-register-verify', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => null);
  const relayId = body?.relayId;
  const response = body?.response;
  if (!isValidRelayId(relayId) || !response || typeof response !== 'object') {
    return apiError('VALIDATION_ERROR', 'Invalid request', 400);
  }

  const existing = await getUserByRelayId(relayId);
  if (existing) return apiError('CONFLICT', 'relayId already registered', 409);

  const result = await verifyPreRegistrationAndIssueTicket(relayId, response);
  if ('error' in result) {
    log.error(`[WebAuthn] pre-register-verify failed for relayId "${relayId}":`, result.error);
    return apiError('VALIDATION_ERROR', result.error, 400);
  }

  return NextResponse.json({ ticket: result.ticket }, { status: 200 });
});
