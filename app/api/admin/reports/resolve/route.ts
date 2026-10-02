import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/admin-auth';
import { normalizeRelayId } from '@/lib/crypto/relay-id';
import { resolveReports } from '@/lib/db/abuse-reports-db';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

/**
 * Operator-only: dismiss a relayId's unresolved reports without banning —
 * e.g. reviewed and judged not actionable (including a suspected mass-report
 * brigade). Does not touch the account itself.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:reports-resolve', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const body = await request.json();
  const targetRelayId = typeof body?.targetRelayId === 'string' ? normalizeRelayId(body.targetRelayId) : null;
  if (!targetRelayId) {
    return apiError('VALIDATION_ERROR', 'Invalid targetRelayId', 400);
  }

  await resolveReports(targetRelayId, 'dismissed');
  return NextResponse.json({ success: true }, { status: 200 });
});
