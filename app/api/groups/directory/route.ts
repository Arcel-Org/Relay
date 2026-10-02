import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { upsertPublicGroup, findByHandle, findByGroupId } from '@/lib/db/public-groups-db';
import { requireSession } from '@/lib/db/server-session';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { hasSuspiciousTextControlChars } from '@/lib/security/sanitize';

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate-limit before the session check — see groups/leave-directory's
  // matching comment for why.
  const rateLimited = checkRateLimit(request, 'groups:create', { maxRequests: 5, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null) as {
    groupId?: string;
    publicHandle?: string;
    name?: string;
    description?: string;
    avatarEmoji?: string;
    avatarColor?: string;
    memberCount?: number;
    ownerRelayId?: string;
    joinPolicy?: 'open' | 'request';
  } | null;

  if (!body || !body.groupId || !body.publicHandle || !body.name || !body.ownerRelayId) {
    return apiError('VALIDATION_ERROR', 'Missing required fields', 400);
  }

  if (auth.relayId !== body.ownerRelayId) {
    return apiError('FORBIDDEN', 'Forbidden', 403);
  }

  const handle = body.publicHandle.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_\-]{3,32}$/.test(handle)) {
    return apiError('VALIDATION_ERROR', 'Invalid handle', 400);
  }

  if (body.name.length < 1 || body.name.length > 100) {
    return apiError('VALIDATION_ERROR', 'Name must be 1-100 characters', 400);
  }
  if (body.description !== undefined && body.description.length > 500) {
    return apiError('VALIDATION_ERROR', 'Description must be 500 characters or fewer', 400);
  }
  // Length caps alone don't catch bidi-override spoofing or Zalgo-style
  // stacked combining marks — both get echoed back to every viewer via
  // groups/search and the directory listing.
  if (hasSuspiciousTextControlChars(body.name)) {
    return apiError('VALIDATION_ERROR', 'Name contains disallowed characters', 400);
  }
  if (body.description !== undefined && hasSuspiciousTextControlChars(body.description)) {
    return apiError('VALIDATION_ERROR', 'Description contains disallowed characters', 400);
  }
  // Unlike user avatars (generateAvatar() in avatar-constants.ts — always
  // server-generated, never client-submitted), group avatars come straight
  // from the request body with no prior validation — an arbitrarily large
  // value here would persist and get re-served on every groups/search hit.
  if (body.avatarEmoji !== undefined && (
    typeof body.avatarEmoji !== 'string' ||
    body.avatarEmoji.length > 16 ||
    hasSuspiciousTextControlChars(body.avatarEmoji)
  )) {
    return apiError('VALIDATION_ERROR', 'Invalid avatarEmoji', 400);
  }
  if (body.avatarColor !== undefined && (typeof body.avatarColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.avatarColor))) {
    return apiError('VALIDATION_ERROR', 'Invalid avatarColor — must be a #rrggbb hex color', 400);
  }

  const existing = await findByHandle(handle);
  if (existing && existing.groupId !== body.groupId) {
    return apiError('VALIDATION_ERROR', 'Handle already taken', 409);
  }

  const existingById = await findByGroupId(body.groupId);
  if (existingById && existingById.ownerRelayId !== auth.relayId) {
    return apiError('FORBIDDEN', 'Not the group owner', 403);
  }

  const record = await upsertPublicGroup({
    groupId: body.groupId,
    publicHandle: handle,
    name: body.name,
    description: body.description,
    avatarEmoji: body.avatarEmoji,
    avatarColor: body.avatarColor,
    memberCount: Math.max(1, Math.min(100_000, Math.trunc(Number(body.memberCount) || 1))),
    ownerRelayId: body.ownerRelayId,
    joinPolicy: body.joinPolicy || 'open',
  });

  return NextResponse.json({ ok: true, record }, { status: 200 });
});

// Handle uniqueness check — requires auth to prevent public handle enumeration
export const GET = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'groups:handle-check', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const handle = (searchParams.get('handle') || '').trim().replace(/^@/, '').toLowerCase();
  if (!handle) return apiError('VALIDATION_ERROR', 'Missing handle', 400);
  const existing = await findByHandle(handle);
  return NextResponse.json({ available: !existing, handle }, { status: 200 });
});
