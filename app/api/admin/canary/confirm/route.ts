import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/admin-auth';
import { recordCanaryConfirmation, getCanaryStatus } from '@/lib/db/canary-db';
import { withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { log } from '@/lib/platform/logger';

/**
 * Operator-only: confirm the six statements on /legal/canary are still true,
 * right now. Stamps the exact server time — the public page displays this
 * verbatim. This deliberately does NOT touch the statement text itself; an
 * admin who has real legal process to disclose must edit
 * app/legal/canary/page.tsx by hand before (or instead of) confirming.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:canary-confirm', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  await recordCanaryConfirmation(auth.relayId);
  log.warn('[Admin] Warrant canary confirmed by', auth.relayId);

  const status = await getCanaryStatus();
  return NextResponse.json({ success: true, status }, { status: 200 });
});
