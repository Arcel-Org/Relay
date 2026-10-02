/**
 * @vitest-environment node
 *
 * Direct coverage for pruneInactiveAccounts (lib/db/account-retention.ts) —
 * destructive, date-math-dependent, previously untested. Runs against a real
 * throwaway on-disk SQLite DB, same pattern as relay-server-db-shortcode.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-retention-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function makeUser(relayId: string, overrides: Partial<{ createdAt: number; lastLogin: number }> = {}) {
  return {
    id: relayId,
    relayId,
    publicKeyHex: 'ab'.repeat(32),
    encryptedTOTPSecret: 'cd'.repeat(20),
    encryptedTOTPSecretForRecovery: '',
    createdAt: overrides.createdAt ?? Date.now(),
    lastLogin: overrides.lastLogin,
  };
}

describe('pruneInactiveAccounts', () => {
  it('maxInactiveDays <= 0 prunes nothing, even with ancient accounts present', async () => {
    const { saveUser } = await import('../db/relay-server-db');
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    await saveUser(makeUser('ancient', { createdAt: Date.now() - 9999 * DAY_MS }));

    const result = await pruneInactiveAccounts(0);
    expect(result).toEqual({ deletedCount: 0, deletedRelayIds: [], failedRelayIds: [] });

    const { getUserByRelayId } = await import('../db/relay-server-db');
    expect(await getUserByRelayId('ancient')).not.toBeNull();
  });

  it('deletes accounts whose lastLogin is older than the cutoff, keeps recently-active ones', async () => {
    const { saveUser, getUserByRelayId } = await import('../db/relay-server-db');
    const { pruneInactiveAccounts } = await import('../db/account-retention');

    await saveUser(makeUser('stale', { createdAt: Date.now() - 400 * DAY_MS, lastLogin: Date.now() - 400 * DAY_MS }));
    await saveUser(makeUser('fresh', { createdAt: Date.now() - 400 * DAY_MS, lastLogin: Date.now() - 1 * DAY_MS }));

    const result = await pruneInactiveAccounts(90);

    expect(result.deletedRelayIds).toEqual(['stale']);
    expect(result.deletedCount).toBe(1);
    expect(result.failedRelayIds).toEqual([]);
    expect(await getUserByRelayId('stale')).toBeNull();
    expect(await getUserByRelayId('fresh')).not.toBeNull();
  });

  it('falls back to createdAt for a user who has never logged in', async () => {
    const { saveUser, getUserByRelayId } = await import('../db/relay-server-db');
    const { pruneInactiveAccounts } = await import('../db/account-retention');

    // Never logged in (no lastLogin), signed up long ago — eligible.
    await saveUser(makeUser('never-logged-in-old', { createdAt: Date.now() - 400 * DAY_MS }));
    // Never logged in, signed up recently — not eligible yet.
    await saveUser(makeUser('never-logged-in-new', { createdAt: Date.now() - 1 * DAY_MS }));

    const result = await pruneInactiveAccounts(90);

    expect(result.deletedRelayIds).toEqual(['never-logged-in-old']);
    expect(await getUserByRelayId('never-logged-in-old')).toBeNull();
    expect(await getUserByRelayId('never-logged-in-new')).not.toBeNull();
  });

  it('an account just inside the cutoff window is kept (cutoff is strictly older-than)', async () => {
    const { saveUser, getUserByRelayId } = await import('../db/relay-server-db');
    const { pruneInactiveAccounts } = await import('../db/account-retention');

    // A few seconds younger than the cutoff — must survive. (Can't test the
    // exact boundary: the function computes its own Date.now()-based cutoff
    // at call time, a few ms after this setup runs, making exact equality racy.)
    const maxInactiveDays = 90;
    const justInsideCutoff = Date.now() - maxInactiveDays * DAY_MS + 10_000;
    await saveUser(makeUser('just-inside', { createdAt: justInsideCutoff, lastLogin: justInsideCutoff }));

    const result = await pruneInactiveAccounts(maxInactiveDays);
    expect(result.deletedRelayIds).toEqual([]);
    expect(await getUserByRelayId('just-inside')).not.toBeNull();
  });

  it('one user throwing on delete does not abort the sweep for the rest — lands in failedRelayIds', async () => {
    const { saveUser } = await import('../db/relay-server-db');
    const relayServerDb = await import('../db/relay-server-db');
    const { pruneInactiveAccounts } = await import('../db/account-retention');

    await saveUser(makeUser('bad-apple', { createdAt: Date.now() - 400 * DAY_MS, lastLogin: Date.now() - 400 * DAY_MS }));
    await saveUser(makeUser('good-apple', { createdAt: Date.now() - 400 * DAY_MS, lastLogin: Date.now() - 400 * DAY_MS }));

    const realDeleteUser = relayServerDb.deleteUser;
    const spy = vi.spyOn(relayServerDb, 'deleteUser').mockImplementation(async (id: string) => {
      if (id === 'bad-apple') throw new Error('simulated transient DB failure');
      return realDeleteUser(id);
    });

    try {
      const result = await pruneInactiveAccounts(90);
      expect(result.deletedRelayIds).toEqual(['good-apple']);
      expect(result.failedRelayIds).toEqual(['bad-apple']);
      expect(result.deletedCount).toBe(1);

      const { getUserByRelayId } = relayServerDb;
      expect(await getUserByRelayId('bad-apple')).not.toBeNull();
      expect(await getUserByRelayId('good-apple')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('also revokes sessions for deleted accounts', async () => {
    const { saveUser } = await import('../db/relay-server-db');
    const { pruneInactiveAccounts } = await import('../db/account-retention');
    const serverSession = await import('../db/server-session');
    const spy = vi.spyOn(serverSession, 'revokeAllSessions');

    await saveUser(makeUser('stale', { createdAt: Date.now() - 400 * DAY_MS, lastLogin: Date.now() - 400 * DAY_MS }));
    await pruneInactiveAccounts(90);

    expect(spy).toHaveBeenCalledWith('stale');
  });
});
