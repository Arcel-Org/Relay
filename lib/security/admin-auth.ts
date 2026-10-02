/**
 * Single-operator admin gate for the abuse-report review dashboard/API.
 *
 * There is no role/permission system anywhere else in this app (see
 * abuse-reports-db.ts's header) — this is deliberately the one place that
 * exists, scoped to exactly the admin surface that needs it. Fail-closed: an
 * unset ADMIN_RELAY_IDS means nobody can reach the admin routes, not
 * everybody.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/db/server-session';
import { normalizeRelayId } from '@/lib/crypto/relay-id';
import { isDevLikeEnv } from '@/lib/platform/env';
import { log } from '@/lib/platform/logger';

function getAdminRelayIds(): Set<string> {
  const raw = process.env.ADMIN_RELAY_IDS || '';
  return new Set(
    raw
      .split(',')
      .map((id) => normalizeRelayId(id))
      .filter((id): id is string => id !== null)
  );
}

if (!process.env.ADMIN_RELAY_IDS && !isDevLikeEnv()) {
  log.error(
    '[admin-auth] ADMIN_RELAY_IDS is not set. The admin dashboard and abuse-report review ' +
    'API are unreachable by anyone until you set it — see .env.example.'
  );
}

/**
 * Verify the caller has a valid session AND their relayId is in
 * ADMIN_RELAY_IDS. Same return shape as requireSession so route handlers can
 * use it identically: `const auth = await requireAdmin(request); if
 * (auth.error) return auth.error;`
 */
export async function requireAdmin(
  request: NextRequest
): Promise<{ relayId: string; error?: never } | { relayId?: never; error: NextResponse }> {
  const session = await requireSession(request);
  if (session.error) return session;

  const admins = getAdminRelayIds();
  if (!admins.has(session.relayId)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { relayId: session.relayId };
}
