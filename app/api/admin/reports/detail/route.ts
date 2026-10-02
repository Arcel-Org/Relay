import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/admin-auth';
import { normalizeRelayId } from '@/lib/crypto/relay-id';
import { getReportsForRelayId } from '@/lib/db/abuse-reports-db';
import { getUserByRelayId } from '@/lib/db/relay-server-db';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

/**
 * Operator-only: the individual reports (with notes/timestamps) behind one
 * relayId's aggregate row, plus whether the account still exists and its
 * basic profile facts — enough context for a manual judgment call without
 * ever exposing message content (there is none to expose here).
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:reports-detail', { maxRequests: 60, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const targetRelayId = normalizeRelayId(request.nextUrl.searchParams.get('targetRelayId') || '');
  if (!targetRelayId) {
    return apiError('VALIDATION_ERROR', 'Invalid targetRelayId', 400);
  }

  const [{ reports, totalCount }, user] = await Promise.all([
    getReportsForRelayId(targetRelayId),
    getUserByRelayId(targetRelayId),
  ]);

  return NextResponse.json(
    {
      reports,
      totalCount,
      account: user
        ? {
            relayId: user.relayId,
            displayName: user.displayName ?? null,
            username: user.username ?? null,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin ?? null,
          }
        : null,
    },
    { status: 200 }
  );
});
