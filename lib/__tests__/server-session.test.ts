import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHmac } from 'crypto';

// Point the session store at an isolated temp directory so tests never
// touch the real .data/ used by the app, and so each test file run gets a
// clean slate.
const TEST_DIR = path.join(os.tmpdir(), `relay-session-store-test-${process.pid}-${Date.now()}`);
process.env.SESSION_STORE_DIR = TEST_DIR;
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';

// Imported after the env vars above are set, since session-store.ts reads
// SESSION_STORE_DIR at module-load time.
const sessionStore = await import('../db/session-store');
const {
  createSession,
  verifySessionToken,
  revokeSession,
  revokeAllSessions,
  isSessionValidByHash,
  hashToken,
} = sessionStore;

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe('session-store', () => {
  describe('create / verify round trip', () => {
    it('creates a session and verifies it back to the same relayId', async () => {
      const relayId = 'relay:aaaaaaaaaaaaaaaa';
      const token = await createSession(relayId);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThanOrEqual(40); // 32 random bytes, base64url

      const verified = await verifySessionToken(token);
      expect(verified).toBe(relayId);
    });

    it('rejects a token that was never issued', async () => {
      const bogus = 'not-a-real-token-that-was-ever-created-1234567890';
      const verified = await verifySessionToken(bogus);
      expect(verified).toBeNull();
    });

    it('two sessions for the same relayId produce different tokens', async () => {
      const relayId = 'relay:bbbbbbbbbbbbbbbb';
      const t1 = await createSession(relayId);
      const t2 = await createSession(relayId);
      expect(t1).not.toBe(t2);
      expect(await verifySessionToken(t1)).toBe(relayId);
      expect(await verifySessionToken(t2)).toBe(relayId);
    });
  });

  describe('core regression: SESSION_SECRET alone cannot forge a session', () => {
    it('rejects a token forged purely from SESSION_SECRET + a relayId string (old HMAC scheme)', async () => {
      const targetRelayId = 'relay:0000000000000000'; // doesn't need to exist as a user at all
      const secret = process.env.SESSION_SECRET!;

      // Reconstruct exactly what the *old* stateless design would have
      // produced: base64url(`${relayId}:${issuedAt}`) signed with
      // HMAC-SHA256 under SESSION_SECRET.
      const payload = Buffer.from(`${targetRelayId}:${Date.now()}`).toString('base64url');
      const sig = createHmac('sha256', secret).update(payload).digest('base64url');
      const forgedToken = `${payload}.${sig}`;

      const verified = await verifySessionToken(forgedToken);
      expect(verified).toBeNull();
    });

    it('rejects a forged token even for a relayId that legitimately has an active session', async () => {
      const relayId = 'relay:cccccccccccccccc';
      const realToken = await createSession(relayId);
      expect(await verifySessionToken(realToken)).toBe(relayId);

      // Attacker knows SESSION_SECRET and the victim's relayId (both
      // public/leakable), but not the real per-session token.
      const secret = process.env.SESSION_SECRET!;
      const payload = Buffer.from(`${relayId}:${Date.now()}`).toString('base64url');
      const sig = createHmac('sha256', secret).update(payload).digest('base64url');
      const forgedToken = `${payload}.${sig}`;

      expect(forgedToken).not.toBe(realToken);
      const verified = await verifySessionToken(forgedToken);
      expect(verified).toBeNull();

      // The real, legitimately-issued session is unaffected.
      expect(await verifySessionToken(realToken)).toBe(relayId);
    });
  });

  describe('revocation', () => {
    it('revokeSession invalidates a previously-valid session', async () => {
      const relayId = 'relay:dddddddddddddddd';
      const token = await createSession(relayId);
      expect(await verifySessionToken(token)).toBe(relayId);

      await revokeSession(token);

      expect(await verifySessionToken(token)).toBeNull();
    });

    it('revokeAllSessions invalidates every session for a relayId but not others', async () => {
      const relayId = 'relay:eeeeeeeeeeeeeeee';
      const otherRelayId = 'relay:ffffffffffffffff';

      const t1 = await createSession(relayId);
      const t2 = await createSession(relayId);
      const otherToken = await createSession(otherRelayId);

      await revokeAllSessions(relayId);

      expect(await verifySessionToken(t1)).toBeNull();
      expect(await verifySessionToken(t2)).toBeNull();
      // Unrelated relayId's session must survive.
      expect(await verifySessionToken(otherToken)).toBe(otherRelayId);
    });

    it('revoking one session does not affect another session for the same relayId', async () => {
      const relayId = 'relay:1111111111111111';
      const t1 = await createSession(relayId);
      const t2 = await createSession(relayId);

      await revokeSession(t1);

      expect(await verifySessionToken(t1)).toBeNull();
      expect(await verifySessionToken(t2)).toBe(relayId);
    });
  });

  describe('isSessionValidByHash (used by WS ticket verification)', () => {
    it('confirms liveness of a hash matching a real, non-revoked session', async () => {
      const relayId = 'relay:2222222222222222';
      const token = await createSession(relayId);
      const hash = hashToken(token);

      expect(await isSessionValidByHash(hash, relayId)).toBe(true);
    });

    it('rejects a hash after the underlying session is revoked', async () => {
      const relayId = 'relay:3333333333333333';
      const token = await createSession(relayId);
      const hash = hashToken(token);

      expect(await isSessionValidByHash(hash, relayId)).toBe(true);
      await revokeSession(token);
      expect(await isSessionValidByHash(hash, relayId)).toBe(false);
    });

    it('rejects a hash that does not correspond to any created session', async () => {
      const fakeHash = createHmac('sha256', 'irrelevant').update('nonsense').digest('hex');
      expect(await isSessionValidByHash(fakeHash, 'relay:anything')).toBe(false);
    });

    it('rejects a hash bound to a different relayId', async () => {
      const relayId = 'relay:4444444444444444';
      const token = await createSession(relayId);
      const hash = hashToken(token);
      expect(await isSessionValidByHash(hash, 'relay:someone-else')).toBe(false);
    });
  });
});
