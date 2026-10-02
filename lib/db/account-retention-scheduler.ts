/**
 * Periodic sweep for account-retention (see account-retention.ts).
 *
 * server.js has no existing periodic-task hook to attach to and is
 * actively being worked on elsewhere, so this is intentionally a
 * standalone module: call `startAccountRetentionScheduler()` once from
 * server startup (e.g. top-level in server.js, alongside other
 * process-lifetime setup) to activate it. Until something calls it, this
 * file is inert — importing it has no side effects.
 */
import { pruneInactiveAccounts } from './account-retention';

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

function getMaxInactiveDays(): number {
  const raw = process.env.MAX_INACTIVE_DAYS ?? process.env.NEXT_PUBLIC_MAX_INACTIVE_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function runSweep(): Promise<void> {
  const maxInactiveDays = getMaxInactiveDays();
  if (maxInactiveDays <= 0) return;

  try {
    const { deletedCount, deletedRelayIds, failedRelayIds } = await pruneInactiveAccounts(maxInactiveDays);
    if (deletedCount > 0) {
      console.log(
        `[account-retention] pruned ${deletedCount} account(s) inactive > ${maxInactiveDays}d: ${deletedRelayIds.join(', ')}`
      );
    }
    if (failedRelayIds.length > 0) {
      console.error(
        `[account-retention] failed to prune ${failedRelayIds.length} account(s), will retry next sweep: ${failedRelayIds.join(', ')}`
      );
    }
  } catch (err) {
    console.error('[account-retention] sweep failed:', err);
  }
}

/**
 * Starts the daily inactive-account sweep. No-op (logs once and returns a
 * no-op handle) if MAX_INACTIVE_DAYS / NEXT_PUBLIC_MAX_INACTIVE_DAYS is
 * unset or <= 0 — disabled is the default, this must be opted into.
 *
 * Returns a stop function so callers (or tests) can clear the interval.
 */
export function startAccountRetentionScheduler(): () => void {
  const maxInactiveDays = getMaxInactiveDays();
  if (maxInactiveDays <= 0) {
    console.log('[account-retention] disabled (set MAX_INACTIVE_DAYS to enable)');
    return () => {};
  }

  console.log(`[account-retention] enabled: deleting accounts inactive > ${maxInactiveDays}d, checked daily`);
  const timer = setInterval(runSweep, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  void runSweep();

  return () => clearInterval(timer);
}
