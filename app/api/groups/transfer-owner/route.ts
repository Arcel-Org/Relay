import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { findByGroupId, updateGroupOwner } from '@/lib/db/public-groups-db';
import { requireSession } from '@/lib/db/server-session';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { normalizeRelayId } from '@/lib/crypto/relay-id';

// Syncs the directory's ownerRelayId after a real E2E ownership transfer
// (use-group-messaging.ts's transferGroupOwnership) — that action only ever
// mutated the group's own local state; this endpoint closes the gap where
// the directory row kept pointing at the departed owner forever (round 2
// finding). A no-op 200 if the group has no directory row at all (private
// groups have nothing here to sync).
export const POST = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'groups:transfer-owner', { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null) as { groupId?: string; newOwnerRelayId?: string } | null;
  if (!body || !body.groupId || !body.newOwnerRelayId) {
    return apiError('VALIDATION_ERROR', 'Missing required fields', 400);
  }

  const newOwnerRelayId = normalizeRelayId(body.newOwnerRelayId);
  if (!newOwnerRelayId) {
    return apiError('VALIDATION_ERROR', 'Invalid newOwnerRelayId', 400);
  }

  const existing = await findByGroupId(body.groupId);
  if (!existing) return NextResponse.json({ ok: true, synced: false }, { status: 200 });

  // Must be the CURRENT directory owner to hand it off — not the incoming
  // new owner, who has no directory authority yet.
  if (existing.ownerRelayId !== auth.relayId) {
    return apiError('FORBIDDEN', 'Not the group owner', 403);
  }

  // No-op if the directory already agrees — avoids a pointless write (and,
  // since updateGroupOwner also bumps updatedAt, a spurious churn signal to
  // anything watching that column) for a caller re-submitting a sync it
  // already succeeded at.
  if (existing.ownerRelayId === newOwnerRelayId) {
    return NextResponse.json({ ok: true, synced: true }, { status: 200 });
  }

  // NOTE: this table is discovery metadata only (see the file header) — it
  // has no member list to check newOwnerRelayId against. Real membership is
  // enforced entirely client-side by the E2E group state that
  // transferGroupOwnership (use-group-messaging.ts) already mutated before
  // this endpoint is ever called; this route only syncs the directory row
  // to match a transfer that already happened.
  await updateGroupOwner(body.groupId, newOwnerRelayId);
  return NextResponse.json({ ok: true, synced: true }, { status: 200 });
});
