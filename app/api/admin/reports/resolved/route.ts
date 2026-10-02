import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/admin-auth';
import { listRecentResolutions } from '@/lib/db/abuse-reports-db';
import { withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** Operator-only audit trail: most recently resolved (banned/dismissed) reports. */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:reports-resolved', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const requested = parseInt(request.nextUrl.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

  const reports = await listRecentResolutions(limit);
  return NextResponse.json({ reports }, { status: 200 });
});
