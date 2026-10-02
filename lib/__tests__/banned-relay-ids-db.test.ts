/**
 * @vitest-environment node
 *
 * Coverage for banned-relay-ids-db.ts — the tombstone that actually makes an
 * operator ban permanent. Without it, deleteUser() alone doesn't stop the
 * exact same signup request from being replayed to get the identical
 * relayId back (deterministic from the account's public key), fully
 * undoing a ban the Terms describe as "permanent."
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-banned-relay-ids-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('banRelayId / isRelayIdBanned', () => {
  it('a relayId is not banned until banRelayId is called', async () => {
    const { isRelayIdBanned } = await import('../db/banned-relay-ids-db');
    expect(await isRelayIdBanned('target-1')).toBe(false);
  });

  it('reports banned after banRelayId', async () => {
    const { banRelayId, isRelayIdBanned } = await import('../db/banned-relay-ids-db');
    await banRelayId('target-1');
    expect(await isRelayIdBanned('target-1')).toBe(true);
  });

  it('is idempotent — banning an already-banned relayId does not throw', async () => {
    const { banRelayId, isRelayIdBanned } = await import('../db/banned-relay-ids-db');
    await banRelayId('target-1');
    await expect(banRelayId('target-1')).resolves.toBeUndefined();
    expect(await isRelayIdBanned('target-1')).toBe(true);
  });

  it('does not affect other relayIds', async () => {
    const { banRelayId, isRelayIdBanned } = await import('../db/banned-relay-ids-db');
    await banRelayId('target-1');
    expect(await isRelayIdBanned('target-2')).toBe(false);
  });
});
