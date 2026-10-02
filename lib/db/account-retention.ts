/**
 * Account auto-deletion after prolonged inactivity.
 *
 * "Inactive" is measured from the user's `lastLogin` timestamp
 * (lib/db/relay-server-db.ts, set on every successful login by
 * app/api/auth/login/route.ts and app/api/auth/recovery-login/route.ts).
 * Accounts that have never logged in since signup have no `lastLogin`
 * value yet — those fall back to `createdAt`, so a signed-up-but-never-used
 * account is also eligible for pruning once it's old enough, rather than
 * being retained forever.
 */
import { getAllUsers, deleteUser, type RelayUser } from './relay-server-db';
import { revokeAllSessions } from './server-session';
import { log } from '@/lib/platform/logger';

export interface PruneResult {
  deletedCount: number;
  deletedRelayIds: string[];
  /** relayIds whose deletion threw — left in place for the next day's sweep to retry. */
  failedRelayIds: string[];
}

function lastActivityMs(user: RelayUser): number {
  return user.lastLogin ?? user.createdAt;
}

/**
 * Delete every user whose last known activity is older than
 * `maxInactiveDays`. Returns the relayIds that were deleted so callers can
 * log/audit the sweep.
 *
 * `maxInactiveDays <= 0` is treated as "disabled" and prunes nothing — the
 * caller (the scheduler) is expected to gate on this too, but the check is
 * repeated here so this function is never accidentally destructive when
 * called directly (e.g. from a script or test) with an unset/zero value.
 */
export async function pruneInactiveAccounts(maxInactiveDays: number): Promise<PruneResult> {
  if (!maxInactiveDays || maxInactiveDays <= 0) {
    return { deletedCount: 0, deletedRelayIds: [], failedRelayIds: [] };
  }

  const cutoff = Date.now() - maxInactiveDays * 24 * 60 * 60 * 1000;
  const users = await getAllUsers();
  const inactive = users.filter((user) => lastActivityMs(user) < cutoff);

  const deletedRelayIds: string[] = [];
  const failedRelayIds: string[] = [];
  for (const user of inactive) {
    // Per-user try/catch — without this, one failure (a transient DB
    // hiccup, a row some other request is concurrently touching) aborted
    // the entire remaining sweep, silently leaving every inactive account
    // after the failing one un-pruned until the next scheduled run. The
    // cutoff is an absolute age, so a skipped account is picked up again
    // next sweep rather than lost — this only bounds the blast radius of
    // one bad row to itself.
    try {
      await deleteUser(user.id);
      await revokeAllSessions(user.relayId);
      deletedRelayIds.push(user.relayId);
    } catch (err) {
      log.error(`[account-retention] Failed to prune account ${user.relayId}:`, err);
      failedRelayIds.push(user.relayId);
    }
  }

  return { deletedCount: deletedRelayIds.length, deletedRelayIds, failedRelayIds };
}
