/**
 * @vitest-environment node
 *
 * Direct coverage for the opt-in short-code functions in relay-server-db.ts
 * (getUserByShortCode, generateAndAssignShortCode, clearShortCode) — new,
 * non-trivial server logic (transactional uniqueness, retry-on-collision)
 * with no coverage otherwise. Runs against a real throwaway on-disk SQLite
 * DB, same pattern as sqlite-client.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-shortcode-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeUser(relayId: string, id = relayId) {
  return {
    id,
    relayId,
    publicKeyHex: 'ab'.repeat(32),
    encryptedTOTPSecret: 'cd'.repeat(20),
    encryptedTOTPSecretForRecovery: '',
    createdAt: Date.now(),
  };
}

describe('short codes: generate, resolve, clear', () => {
  it('generateAndAssignShortCode assigns a validly-shaped, persisted code', async () => {
    const { saveUser, generateAndAssignShortCode, getUserByRelayId } = await import('../db/relay-server-db');
    await saveUser(makeUser('alice-relay-id'));

    const code = await generateAndAssignShortCode('alice-relay-id');
    expect(code).toMatch(/^[a-z]{4}-[0-9]{4}$/);

    const user = await getUserByRelayId('alice-relay-id');
    expect(user?.shortCode).toBe(code);
  });

  it('getUserByShortCode resolves a generated code back to the right user, case-insensitively', async () => {
    const { saveUser, generateAndAssignShortCode, getUserByShortCode } = await import('../db/relay-server-db');
    await saveUser(makeUser('bob-relay-id'));
    const code = await generateAndAssignShortCode('bob-relay-id');

    const found = await getUserByShortCode(code);
    expect(found?.relayId).toBe('bob-relay-id');

    const foundUpper = await getUserByShortCode(code.toUpperCase());
    expect(foundUpper?.relayId).toBe('bob-relay-id');
  });

  it('getUserByShortCode returns null for an unassigned code', async () => {
    const { getUserByShortCode } = await import('../db/relay-server-db');
    expect(await getUserByShortCode('zzzz-0000')).toBeNull();
  });

  it('two different users each get their own distinct short code', async () => {
    const { saveUser, generateAndAssignShortCode } = await import('../db/relay-server-db');
    await saveUser(makeUser('alice-relay-id'));
    await saveUser(makeUser('bob-relay-id'));

    const aliceCode = await generateAndAssignShortCode('alice-relay-id');
    const bobCode = await generateAndAssignShortCode('bob-relay-id');
    expect(aliceCode).not.toBe(bobCode);
  });

  it('regenerating overwrites the previous code — the old one no longer resolves', async () => {
    const { saveUser, generateAndAssignShortCode, getUserByShortCode } = await import('../db/relay-server-db');
    await saveUser(makeUser('alice-relay-id'));
    const first = await generateAndAssignShortCode('alice-relay-id');
    const second = await generateAndAssignShortCode('alice-relay-id');

    expect(await getUserByShortCode(first)).toBeNull();
    const found = await getUserByShortCode(second);
    expect(found?.relayId).toBe('alice-relay-id');
  });

  it('clearShortCode removes it — the code no longer resolves to anyone', async () => {
    const { saveUser, generateAndAssignShortCode, clearShortCode, getUserByShortCode, getUserByRelayId } = await import('../db/relay-server-db');
    await saveUser(makeUser('alice-relay-id'));
    const code = await generateAndAssignShortCode('alice-relay-id');

    await clearShortCode('alice-relay-id');

    expect(await getUserByShortCode(code)).toBeNull();
    const user = await getUserByRelayId('alice-relay-id');
    expect(user?.shortCode).toBeUndefined();
  });

  it('generateAndAssignShortCode throws for a relayId with no matching user', async () => {
    const { generateAndAssignShortCode } = await import('../db/relay-server-db');
    await expect(generateAndAssignShortCode('nobody-relay-id')).rejects.toThrow();
  });

  it('retries on collision instead of assigning a duplicate short code (real transactional uniqueness check)', async () => {
    const { saveUser, generateAndAssignShortCode } = await import('../db/relay-server-db');
    await saveUser(makeUser('alice-relay-id'));
    await saveUser(makeUser('bob-relay-id'));

    // Force the FIRST candidate generateShortCode() produces to collide with
    // Alice's already-assigned code, so Bob's assignment must retry with a
    // second, different candidate rather than failing or double-assigning.
    const aliceCode = await generateAndAssignShortCode('alice-relay-id');
    const relayIdModule = await import('../crypto/relay-id');
    const realGenerate = relayIdModule.generateShortCode;
    let calls = 0;
    const spy = vi.spyOn(relayIdModule, 'generateShortCode').mockImplementation(() => {
      calls++;
      return calls === 1 ? aliceCode : realGenerate();
    });

    try {
      const bobCode = await generateAndAssignShortCode('bob-relay-id');
      expect(bobCode).not.toBe(aliceCode);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });
});
