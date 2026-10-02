import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { joinGroup } from '@/lib/db/public-groups-db';
import { requireSession } from '@/lib/db/server-session';
import { checkRateLimit } from '@/lib/security/rate-limit';

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'groups:join', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null) as {
    groupId?: string;
    publicHandle?: string;
  } | null;

  if (!body || (!body.groupId && !body.publicHandle)) {
    return apiError('VALIDATION_ERROR', 'Missing required fields', 400);
  }

  const result = await joinGroup({ groupId: body.groupId, publicHandle: body.publicHandle }, auth.relayId);
  if (result === null) return apiError('NOT_FOUND', 'Group not found', 404);
  if (result === 'full') return apiError('LIMIT_EXCEEDED', 'Group pending list is full', 429);

  // Strip pending lists — joiner should not see who else is waiting
  return NextResponse.json({
    ok: true,
    record: {
      groupId: result.groupId,
      publicHandle: result.publicHandle,
      name: result.name,
      description: result.description,
      avatarEmoji: result.avatarEmoji,
      avatarColor: result.avatarColor,
      memberCount: result.memberCount,
      joinPolicy: result.joinPolicy,
      ownerRelayId: result.ownerRelayId,
    },
    joinPolicy: result.joinPolicy,
    ownerRelayId: result.ownerRelayId,
  }, { status: 200 });
});
