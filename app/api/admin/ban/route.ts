import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/admin-auth';
import { normalizeRelayId } from '@/lib/crypto/relay-id';
import { getUserByRelayId, deleteUser } from '@/lib/db/relay-server-db';
import { revokeAllSessions } from '@/lib/db/server-session';
import { resolveReports } from '@/lib/db/abuse-reports-db';
import { banRelayId } from '@/lib/db/banned-relay-ids-db';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { log } from '@/lib/platform/logger';

/**
 * Operator-only, manual ban — this is a deliberate human decision made from
 * the admin dashboard's report queue, never an automatic consequence of
 * report volume (see abuse-reports-db.ts). Reuses the same full-account
 * deleteUser() the self-service "Delete account" flow uses, PLUS a
 * permanent tombstone (banned-relay-ids-db.ts) — deleteUser() alone doesn't
 * stop the exact same signup request from being replayed to get the
 * identical relayId back (it's deterministic from the account's public
 * key, and the client's local keypair survives a server-side ban
 * untouched). The tombstone is what actually makes this permanent and
 * irreversible, matching the Terms' "permanently banned" language.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:ban', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const body = await request.json();
  const targetRelayId = typeof body?.targetRelayId === 'string' ? normalizeRelayId(body.targetRelayId) : null;
  if (!targetRelayId) {
    return apiError('VALIDATION_ERROR', 'Invalid targetRelayId', 400);
  }

  const user = await getUserByRelayId(targetRelayId);
  if (user) {
    await deleteUser(user.id);
    await revokeAllSessions(targetRelayId);
  }
  // Tombstoned regardless of whether an account row still existed — an
  // operator may be banning a relayId that already self-deleted, and the
  // whole point is to block it from ever coming back either way.
  await banRelayId(targetRelayId);
  await resolveReports(targetRelayId, 'banned');

  log.warn('[Admin] Account banned:', targetRelayId, 'by', auth.relayId);

  return NextResponse.json({ success: true, accountExisted: !!user }, { status: 200 });
});
