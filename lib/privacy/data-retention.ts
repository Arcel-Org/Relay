/**
 * Arcel — Data Retention Policy (single source of truth)
 *
 * Any subsystem that retains user-adjacent data MUST import its retention
 * constant from this file. Changing a value here must be reflected in the
 * public Privacy Policy (`app/legal/privacy/page.tsx`) in the same commit.
 *
 * Rule of thumb: if you can't name the user-visible reason a piece of data
 * needs to be kept for N seconds, it should be kept for zero seconds.
 */

export const RETENTION = {
  /** Undelivered ciphertext in the relay queue. Never written to disk. */
  MESSAGE_TTL_MS: 20 * 60 * 1000, // 20 minutes

  /**
   * Sliding-window rate-limit entry age. IPs are hashed before storage
   * (see `rate-limit.ts`). Entries are purged both on window expiry and
   * by the periodic sweeper.
   */
  RATE_LIMIT_WINDOW_MAX_MS: 30 * 60 * 1000, // hard ceiling — 30 minutes
} as const;

/**
 * Per the Privacy Policy, the operator commits to a periodic sweeper that
 * enforces these windows. Subsystems that store user-adjacent data should
 * register a purge function here and it will be called on the cadence below.
 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

type PurgeFn = () => void | Promise<void>;
const purgeRegistry = new Set<PurgeFn>();

export function registerPurge(fn: PurgeFn): void {
  purgeRegistry.add(fn);
}

let sweeperStarted = false;

/**
 * Start the global data-retention sweeper. Safe to call multiple times;
 * only starts one interval. No-op in the browser.
 */
export function startRetentionSweeper(): void {
  if (sweeperStarted) return;
  if (typeof window !== 'undefined') return;
  if (typeof setInterval === 'undefined') return;

  sweeperStarted = true;
  setInterval(async () => {
    for (const fn of purgeRegistry) {
      try {
        await fn();
      } catch {
        // A failing purge must not wedge the sweeper.
      }
    }
  }, CLEANUP_INTERVAL_MS);
}
