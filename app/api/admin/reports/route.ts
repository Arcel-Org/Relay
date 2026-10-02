import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/admin-auth';
import { listReportSummaries } from '@/lib/db/abuse-reports-db';
import { withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Operator-only: the aggregate, unresolved-report queue — paginated. See abuse-reports-db.ts. */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:reports-list', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const requestedLimit = parseInt(request.nextUrl.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const requestedOffset = parseInt(request.nextUrl.searchParams.get('offset') || '', 10);
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;

  const { summaries, totalCount } = await listReportSummaries({ limit, offset });
  return NextResponse.json({ summaries, totalCount }, { status: 200 });
});
