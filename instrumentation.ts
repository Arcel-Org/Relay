/**
 * Runs once when the Next.js server process starts (dev and prod, both
 * `next dev`/`next start` invocations and the custom server.js wrapper —
 * Next calls this itself before serving any request). This is the wiring
 * point for the account-retention sweep: server.js is plain Node with no
 * TS transpilation for arbitrary requires, but this file goes through
 * Next's own build pipeline, so it can import lib/db/*.ts directly.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { initErrorMonitoring } = await import('@/lib/platform/error-monitoring');
  initErrorMonitoring();

  const { startAccountRetentionScheduler } = await import('@/lib/db/account-retention-scheduler');
  startAccountRetentionScheduler();

  const { startCanaryMonitor } = await import('@/lib/legal/canary-monitor');
  startCanaryMonitor();
}
