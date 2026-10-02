/**
 * @vitest-environment node
 *
 * Direct coverage for lib/db/account-retention-scheduler.ts — previously
 * zero test coverage for either its env-var parsing (disabled by default;
 * MAX_INACTIVE_DAYS vs NEXT_PUBLIC_MAX_INACTIVE_DAYS fallback; invalid
 * values) or its enable/disable gating (getting either wrong means either
 * silently deleting no one's stale account ever, or the opposite —
 * accidentally running a real account-deletion sweep on every server
 * start).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/account-retention', () => ({
  pruneInactiveAccounts: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  delete process.env.MAX_INACTIVE_DAYS;
  delete process.env.NEXT_PUBLIC_MAX_INACTIVE_DAYS;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MAX_INACTIVE_DAYS;
  delete process.env.NEXT_PUBLIC_MAX_INACTIVE_DAYS;
});

describe('startAccountRetentionScheduler — disabled by default', () => {
  it('does nothing when neither env var is set', async () => {
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    const stop = startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(pruneInactiveAccounts).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('treats a non-numeric value as disabled', async () => {
    process.env.MAX_INACTIVE_DAYS = 'not-a-number';
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(pruneInactiveAccounts).not.toHaveBeenCalled();
  });

  it('treats zero and negative values as disabled', async () => {
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    process.env.MAX_INACTIVE_DAYS = '0';
    startAccountRetentionScheduler();
    process.env.MAX_INACTIVE_DAYS = '-5';
    startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(pruneInactiveAccounts).not.toHaveBeenCalled();
  });
});

describe('startAccountRetentionScheduler — enabled', () => {
  it('MAX_INACTIVE_DAYS enables it and runs an immediate sweep', async () => {
    process.env.MAX_INACTIVE_DAYS = '30';
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    vi.mocked(pruneInactiveAccounts).mockResolvedValue({ deletedCount: 0, deletedRelayIds: [], failedRelayIds: [] });
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(pruneInactiveAccounts).toHaveBeenCalledWith(30);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('enabled'));
  });

  it('falls back to NEXT_PUBLIC_MAX_INACTIVE_DAYS when MAX_INACTIVE_DAYS is unset', async () => {
    process.env.NEXT_PUBLIC_MAX_INACTIVE_DAYS = '14';
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    vi.mocked(pruneInactiveAccounts).mockResolvedValue({ deletedCount: 0, deletedRelayIds: [], failedRelayIds: [] });
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(pruneInactiveAccounts).toHaveBeenCalledWith(14);
  });

  it('MAX_INACTIVE_DAYS takes priority over NEXT_PUBLIC_MAX_INACTIVE_DAYS when both are set', async () => {
    process.env.MAX_INACTIVE_DAYS = '7';
    process.env.NEXT_PUBLIC_MAX_INACTIVE_DAYS = '99';
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    vi.mocked(pruneInactiveAccounts).mockResolvedValue({ deletedCount: 0, deletedRelayIds: [], failedRelayIds: [] });
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(pruneInactiveAccounts).toHaveBeenCalledWith(7);
  });

  it('sweeps again after the daily interval elapses', async () => {
    process.env.MAX_INACTIVE_DAYS = '30';
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    vi.mocked(pruneInactiveAccounts).mockResolvedValue({ deletedCount: 0, deletedRelayIds: [], failedRelayIds: [] });
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(pruneInactiveAccounts).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(pruneInactiveAccounts).toHaveBeenCalledTimes(2);
  });

  it('the returned stop function clears the interval — no further sweeps after stopping', async () => {
    process.env.MAX_INACTIVE_DAYS = '30';
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    vi.mocked(pruneInactiveAccounts).mockResolvedValue({ deletedCount: 0, deletedRelayIds: [], failedRelayIds: [] });
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    const stop = startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 * 3);
    expect(pruneInactiveAccounts).toHaveBeenCalledTimes(1); // only the initial immediate sweep
  });

  it('logs deletions and failures from a completed sweep', async () => {
    process.env.MAX_INACTIVE_DAYS = '30';
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    vi.mocked(pruneInactiveAccounts).mockResolvedValue({
      deletedCount: 2,
      deletedRelayIds: ['alice', 'bob'],
      failedRelayIds: ['carol'],
    });
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    startAccountRetentionScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('pruned 2'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed to prune 1'));
  });

  it('a thrown/rejected sweep is caught, not left to crash the process', async () => {
    process.env.MAX_INACTIVE_DAYS = '30';
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    vi.mocked(pruneInactiveAccounts).mockRejectedValue(new Error('db down'));
    const { startAccountRetentionScheduler } = await import('../db/account-retention-scheduler');

    expect(() => startAccountRetentionScheduler()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('sweep failed'), expect.any(Error));
  });
});
