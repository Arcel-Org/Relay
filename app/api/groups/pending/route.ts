import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { findByGroupId, resolvePendingJoin } from '@/lib/db/public-groups-db';
import { requireSession } from '@/lib/db/server-session';
import { checkRateLimit } from '@/lib/security/rate-limit';

// Owner-only: list the pending joiners/requesters for a public group. This
// is the read half of the join flow that was previously write-only —
// joinGroup() appended relayIds to pendingMembers/pendingRequests, but
// nothing ever surfaced them to the owner (round 2/3 audit finding).
export const GET = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'groups:pending-list', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get('groupId');
  if (!groupId) return apiError('VALIDATION_ERROR', 'Missing groupId', 400);

  const record = await findByGroupId(groupId);
  if (!record) return apiError('NOT_FOUND', 'Group not found', 404);
  if (record.ownerRelayId !== auth.relayId) {
    return apiError('FORBIDDEN', 'Not the group owner', 403);
  }

  return NextResponse.json({
    pendingMembers: record.pendingMembers || [],
    pendingRequests: record.pendingRequests || [],
  }, { status: 200 });
});

// Owner-only: clear a relayId from the pending lists once handled. Whether
// this was an "approve" or a "deny" only matters to the caller — approving
// means the client separately delivers the actual E2E group invite
// (addGroupMembers) after this call succeeds; denying just drops the entry.
// The server holds no real membership state either way (see file header of
// public-groups-db.ts), so there's nothing else for this endpoint to do.
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'groups:pending-resolve', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null) as { groupId?: string; relayId?: string } | null;
  if (!body || !body.groupId || !body.relayId) {
    return apiError('VALIDATION_ERROR', 'Missing required fields', 400);
  }

  const existing = await findByGroupId(body.groupId);
  if (!existing) return apiError('NOT_FOUND', 'Group not found', 404);
  if (existing.ownerRelayId !== auth.relayId) {
    return apiError('FORBIDDEN', 'Not the group owner', 403);
  }

  const record = await resolvePendingJoin(body.groupId, body.relayId);
  return NextResponse.json({
    ok: true,
    pendingMembers: record?.pendingMembers || [],
    pendingRequests: record?.pendingRequests || [],
  }, { status: 200 });
});
