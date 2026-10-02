import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { findByGroupId, removePublicGroup } from '@/lib/db/public-groups-db';
import { requireSession } from '@/lib/db/server-session';
import { checkRateLimit } from '@/lib/security/rate-limit';

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — requireSession does a DB read
  // (session verification + account-existence check), so checking it first
  // let unauthenticated/garbage-cookie traffic cost a DB query per request
  // with no rate limiting at all. See lib/security/rate-limit.ts.
  const rateLimited = checkRateLimit(request, 'groups:leave-directory', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null) as { groupId?: string } | null;
  if (!body || !body.groupId) {
    return apiError('VALIDATION_ERROR', 'Missing groupId', 400);
  }

  const record = await findByGroupId(body.groupId);
  if (!record) return apiError('NOT_FOUND', 'Group not found', 404);
  if (record.ownerRelayId !== auth.relayId) {
    return apiError('FORBIDDEN', 'Not the group owner', 403);
  }

  await removePublicGroup(body.groupId);
  return NextResponse.json({ ok: true }, { status: 200 });
});
