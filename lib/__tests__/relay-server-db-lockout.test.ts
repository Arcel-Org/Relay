/**
 * @vitest-environment node
 *
 * Direct coverage for relay-server-db.ts's per-account brute-force lockout
 * (recordFailedLogin, isLocked, updateLastLogin, withLoginAttemptLock) —
 * previously zero direct test coverage despite being the shared defense
 * gating login, recovery-login, regenerate-recovery-code, delete-account,
 * and webauthn register-verify. Runs against a real throwaway on-disk
 * SQLite DB, same pattern as relay-server-db-shortcode.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-lockout-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeUser(relayId: string) {
  return {
    id: relayId,
    relayId,
    publicKeyHex: 'ab'.repeat(32),
    encryptedTOTPSecret: 'cd'.repeat(20),
    encryptedTOTPSecretForRecovery: '',
    createdAt: Date.now(),
  };
}

const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

describe('recordFailedLogin / isLocked', () => {
  it('does not lock before the threshold is reached', async () => {
    const { saveUser, recordFailedLogin, getUserByRelayId } = await import('../db/relay-server-db');
    await saveUser(makeUser('alice'));

    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
      const result = await recordFailedLogin('alice');
      expect(result.locked).toBe(false);
    }

    const user = await getUserByRelayId('alice');
    expect(user?.failedLoginAttempts).toBe(LOCKOUT_THRESHOLD - 1);
    const { isLocked } = await import('../db/relay-server-db');
    expect(isLocked(user!)).toBeNull();
  });

  it('locks the account on the Nth failure and isLocked reflects it', async () => {
    const { saveUser, recordFailedLogin, getUserByRelayId, isLocked } = await import('../db/relay-server-db');
    await saveUser(makeUser('bob'));

    let last;
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      last = await recordFailedLogin('bob');
    }

    expect(last!.locked).toBe(true);
    expect(last!.lockedUntil).toBeGreaterThan(Date.now());

    const user = await getUserByRelayId('bob');
    expect(isLocked(user!)).toBe(last!.lockedUntil);
  });

  it('isLocked returns null once lockedUntil has passed', async () => {
    const { isLocked } = await import('../db/relay-server-db');
    expect(isLocked({ lockedUntil: Date.now() - 1000 })).toBeNull();
    expect(isLocked({ lockedUntil: undefined })).toBeNull();
    expect(isLocked({ lockedUntil: Date.now() + 60_000 })).toEqual(expect.any(Number));
  });

  it('an expired lock resets the counter instead of re-locking on the very next failure', async () => {
    vi.useFakeTimers();
    const { saveUser, recordFailedLogin, getUserByRelayId } = await import('../db/relay-server-db');
    await saveUser(makeUser('carol'));

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await recordFailedLogin('carol');
    }
    const lockedUser = await getUserByRelayId('carol');
    expect(lockedUser?.failedLoginAttempts).toBe(LOCKOUT_THRESHOLD);

    // Advance well past the lockout window.
    vi.setSystemTime(Date.now() + LOCKOUT_DURATION_MS + 1000);

    // A single failure right after expiry must NOT immediately re-lock —
    // the whole point of resetting the counter on an elapsed lock.
    const result = await recordFailedLogin('carol');
    expect(result.locked).toBe(false);

    const user = await getUserByRelayId('carol');
    expect(user?.failedLoginAttempts).toBe(1);
  });

  it('recordFailedLogin for a nonexistent relayId is a safe no-op', async () => {
    const { recordFailedLogin } = await import('../db/relay-server-db');
    const result = await recordFailedLogin('nobody-here');
    expect(result.locked).toBe(false);
  });
});

describe('updateLastLogin', () => {
  it('clears failedLoginAttempts and lockedUntil on a successful login', async () => {
    const { saveUser, recordFailedLogin, updateLastLogin, getUserByRelayId, isLocked } = await import('../db/relay-server-db');
    await saveUser(makeUser('dave'));

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await recordFailedLogin('dave');
    }
    let user = await getUserByRelayId('dave');
    expect(isLocked(user!)).not.toBeNull();

    await updateLastLogin('dave');

    user = await getUserByRelayId('dave');
    expect(user?.failedLoginAttempts).toBe(0);
    expect(user?.lockedUntil).toBeFalsy();
    expect(isLocked(user!)).toBeNull();
  });
});

describe('withLoginAttemptLock', () => {
  it('serializes concurrent calls for the SAME relayId — the second call only starts after the first resolves', async () => {
    const { withLoginAttemptLock } = await import('../db/relay-server-db');
    const order: string[] = [];

    const first = withLoginAttemptLock('erin', async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('first-end');
      return 1;
    });
    // Fired immediately after, while `first` is still in-flight.
    const second = withLoginAttemptLock('erin', async () => {
      order.push('second-start');
      return 2;
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('does NOT serialize calls for DIFFERENT relayIds', async () => {
    const { withLoginAttemptLock } = await import('../db/relay-server-db');
    const order: string[] = [];

    const slow = withLoginAttemptLock('frank', async () => {
      order.push('slow-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow-end');
    });
    const fast = withLoginAttemptLock('grace', async () => {
      order.push('fast-start-and-end');
    });

    await Promise.all([slow, fast]);
    // The independent relayId's call ran to completion WHILE the slow one
    // was still in flight, not queued behind it.
    expect(order[0]).toBe('slow-start');
    expect(order[1]).toBe('fast-start-and-end');
    expect(order[2]).toBe('slow-end');
  });

  it('a rejected fn still releases the lock for the next call on the same relayId', async () => {
    const { withLoginAttemptLock } = await import('../db/relay-server-db');

    await expect(
      withLoginAttemptLock('henry', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // If the failed call's lock chain wasn't released, this would hang
    // forever instead of resolving.
    const result = await withLoginAttemptLock('henry', async () => 'recovered');
    expect(result).toBe('recovered');
  });
});
