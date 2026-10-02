/**
 * Warrant-canary staleness monitor.
 *
 * Once per server process start, and then daily, checks the latest
 * confirmation recorded in lib/db/canary-db.ts against its due date and logs
 * a loud, always-emitted error if it's overdue.
 *
 * This does NOT re-confirm the canary automatically, and it never could —
 * confirming requires a human to actually re-review the statements on
 * app/legal/canary/page.tsx and click "Confirm" on the admin dashboard's
 * Warrant Canary panel (/app/admin/canary). All this does is make sure
 * missing that on schedule can no longer pass by silently.
 */
import { getCanaryStatus, CANARY_CADENCE_DAYS } from '@/lib/db/canary-db';
import { log } from '@/lib/platform/logger';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

let started = false;

async function checkCanaryFreshness(): Promise<void> {
  try {
    const status = await getCanaryStatus();
    if (status?.overdue) {
      log.error(
        `[WarrantCanary] OVERDUE: last confirmed ${new Date(status.confirmedAt).toISOString()}, ` +
        `due again within ${CANARY_CADENCE_DAYS} days of that and has not been. ` +
        'An administrator needs to re-verify the statements on app/legal/canary/page.tsx are still true ' +
        'and confirm via the admin dashboard\'s Warrant Canary panel (/app/admin/canary). ' +
        'By the canary\'s own published text, staying overdue is a signal users are told to treat as a possible gag order.'
      );
    }
  } catch (err) {
    // A transient DB hiccup here should never crash the process or go
    // unnoticed — log and let the next interval retry.
    log.error('[WarrantCanary] freshness check failed:', err);
  }
}

/** Safe to call multiple times; only starts one interval. No-op in the browser. */
export function startCanaryMonitor(): void {
  if (started) return;
  if (typeof window !== 'undefined') return;
  if (typeof setInterval === 'undefined') return;
  started = true;

  void checkCanaryFreshness(); // don't wait a full day for the first check
  setInterval(() => { void checkCanaryFreshness(); }, CHECK_INTERVAL_MS);
}
