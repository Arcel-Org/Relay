import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/admin-auth';
import { getCanaryStatus } from '@/lib/db/canary-db';
import { withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

/** Operator-only: current warrant-canary confirmation status, for the admin dashboard's overdue/due-soon indicator. */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:canary-status', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const status = await getCanaryStatus();
  return NextResponse.json({ status }, { status: 200 });
});
