/**
 * @vitest-environment node
 *
 * Coverage for lib/security/admin-auth.ts's requireAdmin — the single gate
 * in front of the entire abuse-report admin surface. The whole point of
 * this module is that it fails CLOSED: an unset/empty/malformed
 * ADMIN_RELAY_IDS must reject everyone, never accidentally admit a caller.
 * Traced by hand during review; pinned here as a real test instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;
const RELAY_ID_A = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';
const RELAY_ID_B = 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-admin-auth-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_STORE_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.SESSION_STORE_DIR;
  delete process.env.ADMIN_RELAY_IDS;
  // A leaked async DB/journal flush can drop a file into tmpDir right as we
  // remove it, racing rmdir -> ENOTEMPTY under parallel CI load. Retry the
  // rm a few times with a short backoff before giving up.
  for (let i = 0; i < 6; i++) {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); break; }
    catch (err) { if (i === 5) throw err; await new Promise((r) => setTimeout(r, 100)); }
  }
});

async function makeSessionRequest(relayId: string): Promise<NextRequest> {
  const { saveUser } = await import('../db/relay-server-db');
  const { createSessionToken } = await import('../db/server-session');
  await saveUser({
    id: `user-${relayId}`,
    relayId,
    publicKeyHex: 'ab'.repeat(32),
    encryptedTOTPSecret: 'enc',
    encryptedTOTPSecretForRecovery: 'enc-recovery',
    createdAt: Date.now(),
    failedLoginAttempts: 0,
    twoFactorMethod: 'totp',
  });
  const token = await createSessionToken(relayId);
  return new NextRequest('http://localhost/api/admin/reports', {
    headers: { cookie: `relay_session=${token}` },
  });
}

describe('requireAdmin — fails closed', () => {
  it('rejects every caller when ADMIN_RELAY_IDS is unset', async () => {
    delete process.env.ADMIN_RELAY_IDS;
    const { requireAdmin } = await import('../security/admin-auth');
    const req = await makeSessionRequest(RELAY_ID_A);

    const result = await requireAdmin(req);
    expect(result.relayId).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(403);
  });

  it('rejects every caller when ADMIN_RELAY_IDS is an empty string', async () => {
    process.env.ADMIN_RELAY_IDS = '';
    const { requireAdmin } = await import('../security/admin-auth');
    const req = await makeSessionRequest(RELAY_ID_A);

    const result = await requireAdmin(req);
    expect(result.error!.status).toBe(403);
  });

  it('rejects a caller with no session at all, regardless of ADMIN_RELAY_IDS', async () => {
    process.env.ADMIN_RELAY_IDS = RELAY_ID_A;
    const { requireAdmin } = await import('../security/admin-auth');
    const req = new NextRequest('http://localhost/api/admin/reports');

    const result = await requireAdmin(req);
    expect(result.error!.status).toBe(401);
  });

  it('rejects a caller whose relayId is not in ADMIN_RELAY_IDS', async () => {
    process.env.ADMIN_RELAY_IDS = RELAY_ID_A;
    const { requireAdmin } = await import('../security/admin-auth');
    const req = await makeSessionRequest(RELAY_ID_B);

    const result = await requireAdmin(req);
    expect(result.error!.status).toBe(403);
  });

  it('malformed/garbage entries in ADMIN_RELAY_IDS are silently dropped, not treated as wildcards', async () => {
    process.env.ADMIN_RELAY_IDS = 'not-a-relay-id, , *, admin';
    const { requireAdmin } = await import('../security/admin-auth');
    const req = await makeSessionRequest(RELAY_ID_A);

    const result = await requireAdmin(req);
    expect(result.error!.status).toBe(403);
  });
});

describe('requireAdmin — admits the configured operator', () => {
  it('succeeds for a relayId listed in ADMIN_RELAY_IDS', async () => {
    process.env.ADMIN_RELAY_IDS = RELAY_ID_A;
    const { requireAdmin } = await import('../security/admin-auth');
    const req = await makeSessionRequest(RELAY_ID_A);

    const result = await requireAdmin(req);
    expect(result.error).toBeUndefined();
    expect(result.relayId).toBe(RELAY_ID_A);
  });

  it('matches case-insensitively and trims whitespace, mirroring normalizeRelayId', async () => {
    process.env.ADMIN_RELAY_IDS = `  ${RELAY_ID_A.toUpperCase()}  , ${RELAY_ID_B}`;
    const { requireAdmin } = await import('../security/admin-auth');
    const req = await makeSessionRequest(RELAY_ID_A);

    const result = await requireAdmin(req);
    expect(result.relayId).toBe(RELAY_ID_A);
  });

  it('a multi-admin list admits any listed relayId, not just the first', async () => {
    process.env.ADMIN_RELAY_IDS = `${RELAY_ID_A},${RELAY_ID_B}`;
    const { requireAdmin } = await import('../security/admin-auth');
    const req = await makeSessionRequest(RELAY_ID_B);

    const result = await requireAdmin(req);
    expect(result.relayId).toBe(RELAY_ID_B);
  });
});
