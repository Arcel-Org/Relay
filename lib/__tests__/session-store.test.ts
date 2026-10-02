/**
 * @vitest-environment node
 *
 * Coverage for lib/db/session-store.ts — previously zero direct unit tests
 * despite being the actual server-side session-verification/revocation
 * layer every authenticated request and WS message goes through.
 *
 * Fresh tmp SESSION_STORE_DIR + vi.resetModules() per test, matching this
 * session's established convention for module-level-singleton state
 * (index/relayIdIndex here are plain module-level Maps with no reset hook).
 * Uses fake timers throughout since SESSION_LIFETIME_MS is a real 24h
 * constant — expiry/idle-timeout behavior can't be exercised otherwise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-session-store-test-'));
  process.env.SESSION_STORE_DIR = tmpDir;
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.SESSION_STORE_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const RELAY_ID = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';
const OTHER_RELAY_ID = 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('createSession / verifySessionToken', () => {
  it('a freshly created session verifies to its relayId', async () => {
    const { createSession, verifySessionToken } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    expect(await verifySessionToken(token)).toBe(RELAY_ID);
  });

  it('an unknown token does not verify', async () => {
    const { verifySessionToken } = await import('../db/session-store');
    expect(await verifySessionToken('not-a-real-token')).toBeNull();
  });

  it('the raw token is never persisted to disk — only its hash', async () => {
    const { createSession } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    const raw = await fs.readFile(path.join(tmpDir, 'sessions.json'), 'utf-8');
    expect(raw).not.toContain(token);
  });

  it('expires after SESSION_LIFETIME_MS (24h)', async () => {
    const { createSession, verifySessionToken } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);

    vi.setSystemTime(new Date(Date.now() + DAY_MS - 1000));
    expect(await verifySessionToken(token)).toBe(RELAY_ID);

    vi.setSystemTime(new Date(Date.now() + 2000));
    expect(await verifySessionToken(token)).toBeNull();
  });
});

describe('isSessionValidByHash', () => {
  it('validates a live session by its hash + relayId', async () => {
    const { createSession, hashToken, isSessionValidByHash } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    expect(await isSessionValidByHash(hashToken(token), RELAY_ID)).toBe(true);
  });

  it('rejects when the hash belongs to a DIFFERENT relayId than claimed', async () => {
    const { createSession, hashToken, isSessionValidByHash } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    expect(await isSessionValidByHash(hashToken(token), OTHER_RELAY_ID)).toBe(false);
  });

  it('rejects an unknown hash', async () => {
    const { hashToken, isSessionValidByHash } = await import('../db/session-store');
    expect(await isSessionValidByHash(hashToken('never-issued'), RELAY_ID)).toBe(false);
  });
});

describe('revokeSession', () => {
  it('a revoked session no longer verifies', async () => {
    const { createSession, verifySessionToken, revokeSession } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    await revokeSession(token);
    expect(await verifySessionToken(token)).toBeNull();
  });

  it('revoking an unknown token is a harmless no-op', async () => {
    const { revokeSession } = await import('../db/session-store');
    await expect(revokeSession('never-issued')).resolves.toBeUndefined();
  });

  it('revoking an already-revoked token is a harmless no-op', async () => {
    const { createSession, revokeSession } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    await revokeSession(token);
    await expect(revokeSession(token)).resolves.toBeUndefined();
  });
});

describe('revokeAllSessions', () => {
  it('revokes every session for a relayId, and none belonging to a different relayId', async () => {
    const { createSession, verifySessionToken, revokeAllSessions } = await import('../db/session-store');
    const tokenA1 = await createSession(RELAY_ID);
    const tokenA2 = await createSession(RELAY_ID);
    const tokenB = await createSession(OTHER_RELAY_ID);

    await revokeAllSessions(RELAY_ID);

    expect(await verifySessionToken(tokenA1)).toBeNull();
    expect(await verifySessionToken(tokenA2)).toBeNull();
    expect(await verifySessionToken(tokenB)).toBe(OTHER_RELAY_ID);
  });

  it('revoking for a relayId with no sessions at all is a harmless no-op', async () => {
    const { revokeAllSessions } = await import('../db/session-store');
    await expect(revokeAllSessions('never-had-a-session')).resolves.toBeUndefined();
  });
});

describe('setInactivityTimeout / touchSessionActivity — idle enforcement', () => {
  it('a session with no inactivity timeout configured never idle-expires', async () => {
    const { createSession, verifySessionToken } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    vi.setSystemTime(new Date(Date.now() + DAY_MS - 1000)); // just under the hard 24h expiry
    expect(await verifySessionToken(token)).toBe(RELAY_ID);
  });

  it('a session idle longer than its configured timeout stops verifying', async () => {
    const { createSession, setInactivityTimeout, verifySessionToken } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    await setInactivityTimeout(token, 60_000); // 1 minute

    vi.advanceTimersByTime(30_000);
    expect(await verifySessionToken(token)).toBe(RELAY_ID); // still within threshold

    vi.advanceTimersByTime(31_000); // now 61s idle
    expect(await verifySessionToken(token)).toBeNull();
  });

  it('touchSessionActivity resets the idle clock, keeping the session alive', async () => {
    const { createSession, setInactivityTimeout, touchSessionActivity, hashToken, verifySessionToken } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    await setInactivityTimeout(token, 60_000);

    vi.advanceTimersByTime(45_000);
    await touchSessionActivity(hashToken(token)); // resets lastActivityAt to "now"

    vi.advanceTimersByTime(45_000); // would have been 90s idle without the touch
    expect(await verifySessionToken(token)).toBe(RELAY_ID);
  });

  it('setInactivityTimeout(null) clears a previously-configured idle limit', async () => {
    const { createSession, setInactivityTimeout, verifySessionToken } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    await setInactivityTimeout(token, 1000);
    await setInactivityTimeout(token, null);

    vi.advanceTimersByTime(5000); // would have idle-expired under the old 1s limit
    expect(await verifySessionToken(token)).toBe(RELAY_ID);
  });

  it('touchSessionActivity on an unknown or revoked token is a harmless no-op', async () => {
    const { createSession, revokeSession, touchSessionActivity, hashToken } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    await revokeSession(token);
    await expect(touchSessionActivity(hashToken(token))).resolves.toBeUndefined();
    await expect(touchSessionActivity(hashToken('never-issued'))).resolves.toBeUndefined();
  });
});

describe('persistence — survives a simulated process restart', () => {
  it('a live session created before "restart" still verifies after re-importing the module fresh', async () => {
    const { createSession } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);

    vi.resetModules(); // simulates a fresh process re-importing the module
    const { verifySessionToken } = await import('../db/session-store');
    expect(await verifySessionToken(token)).toBe(RELAY_ID);
  });

  it('a revoked session stays revoked after a simulated restart', async () => {
    const { createSession, revokeSession } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    await revokeSession(token);

    vi.resetModules();
    const { verifySessionToken } = await import('../db/session-store');
    expect(await verifySessionToken(token)).toBeNull();
  });

  it('an expired session does not resurrect after a simulated restart (pruned on load)', async () => {
    const { createSession } = await import('../db/session-store');
    const token = await createSession(RELAY_ID);
    vi.setSystemTime(new Date(Date.now() + DAY_MS + 1000));

    vi.resetModules();
    const { verifySessionToken } = await import('../db/session-store');
    expect(await verifySessionToken(token)).toBeNull();
  });
});
