import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/db/server-session';
import { normalizeRelayId } from '@/lib/crypto/relay-id';
import { getUserByRelayId } from '@/lib/db/relay-server-db';
import { insertReport, REPORT_CATEGORIES, type ReportCategory } from '@/lib/db/abuse-reports-db';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

const MAX_NOTE_LENGTH = 500;

/**
 * Report a Relay ID for abuse. Session-authenticated (so this isn't a fully
 * anonymous spam vector) but the caller's own relayId is NEVER written to
 * the report row — see abuse-reports-db.ts. There is no evidence/attachment
 * upload here: the operator reviews category + optional note only, never
 * message content, so this never creates the "actual knowledge of specific
 * content" trigger that a screenshot/evidence intake would.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'reports:create', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json();
  const targetRelayId = typeof body?.targetRelayId === 'string' ? normalizeRelayId(body.targetRelayId) : null;
  if (!targetRelayId) {
    return apiError('VALIDATION_ERROR', 'Invalid targetRelayId', 400);
  }
  if (targetRelayId === auth.relayId) {
    return apiError('VALIDATION_ERROR', 'Cannot report yourself', 400);
  }
  // Without this, a well-formatted but made-up relayId (passes the regex,
  // belongs to no one) could still flood the operator's review queue —
  // there's no cryptographic reason a report target must be a real account,
  // so nothing else would catch this.
  if (!(await getUserByRelayId(targetRelayId))) {
    return apiError('NOT_FOUND', 'No account with that Relay ID', 404);
  }

  const category = body?.category as ReportCategory;
  if (!REPORT_CATEGORIES.includes(category)) {
    return apiError('VALIDATION_ERROR', `category must be one of: ${REPORT_CATEGORIES.join(', ')}`, 400);
  }

  let note: string | undefined;
  if (body?.note !== undefined) {
    if (typeof body.note !== 'string') {
      return apiError('VALIDATION_ERROR', 'note must be a string', 400);
    }
    note = body.note.trim().slice(0, MAX_NOTE_LENGTH) || undefined;
  }

  await insertReport({ targetRelayId, category, note });

  return NextResponse.json({ success: true }, { status: 200 });
});
