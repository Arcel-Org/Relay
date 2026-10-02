/**
 * @vitest-environment node
 *
 * Coverage for lib/db/webauthn-credentials-db.ts against a real throwaway
 * on-disk SQLite DB (same pattern as abuse-reports-db.test.ts) — previously
 * zero direct unit tests despite being the actual persistence layer for
 * hardware-key (FIDO2/WebAuthn) login, including its clone-detection and
 * concurrent-revoke race-safety guarantees.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

const RELAY_ID = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';
const OTHER_RELAY_ID = 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-webauthn-creds-test-'));
  process.env.DATA_DIR = tmpDir;
  vi.resetModules();

  // webauthn_credentials.relayId is a foreign key into users(relayId) —
  // seed both test users up front, matching admin-auth.test.ts's convention.
  const { saveUser } = await import('../db/relay-server-db');
  for (const relayId of [RELAY_ID, OTHER_RELAY_ID]) {
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
  }
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCred(overrides: Partial<{
  credentialId: string; relayId: string; publicKeyHex: string; counter: number; transports?: string[]; createdAt: number;
}> = {}) {
  return {
    credentialId: 'cred-1',
    relayId: RELAY_ID,
    publicKeyHex: 'ab'.repeat(32),
    counter: 0,
    transports: ['usb', 'nfc'],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('addCredential / getCredentialsByRelayId / getCredentialById', () => {
  it('round-trips a credential including its transports array', async () => {
    const { addCredential, getCredentialById, getCredentialsByRelayId } = await import('../db/webauthn-credentials-db');
    const cred = makeCred();
    await addCredential(cred);

    expect(await getCredentialById('cred-1')).toEqual(cred);
    expect(await getCredentialsByRelayId(RELAY_ID)).toEqual([cred]);
  });

  it('a credential with no transports round-trips with transports undefined, not an empty array', async () => {
    const { addCredential, getCredentialById } = await import('../db/webauthn-credentials-db');
    const cred = makeCred({ transports: undefined });
    await addCredential(cred);
    expect((await getCredentialById('cred-1'))?.transports).toBeUndefined();
  });

  it('getCredentialsByRelayId returns every credential for that relayId and none for another', async () => {
    const { addCredential, getCredentialsByRelayId } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred({ credentialId: 'cred-1' }));
    await addCredential(makeCred({ credentialId: 'cred-2' }));
    await addCredential(makeCred({ credentialId: 'cred-other-user', relayId: OTHER_RELAY_ID }));

    const mine = await getCredentialsByRelayId(RELAY_ID);
    expect(mine.map((c) => c.credentialId).sort()).toEqual(['cred-1', 'cred-2']);
    expect(await getCredentialsByRelayId(OTHER_RELAY_ID)).toHaveLength(1);
  });

  it('getCredentialById returns null for an unknown id', async () => {
    const { getCredentialById } = await import('../db/webauthn-credentials-db');
    expect(await getCredentialById('never-existed')).toBeNull();
  });
});

describe('updateCredentialCounter', () => {
  it('unconditionally overwrites the counter', async () => {
    const { addCredential, updateCredentialCounter, getCredentialById } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred({ counter: 5 }));
    await updateCredentialCounter('cred-1', 3); // even backwards — this function has no guard
    expect((await getCredentialById('cred-1'))?.counter).toBe(3);
  });
});

describe('updateCredentialCounterIfGreater — clone detection', () => {
  it('advances the counter and returns true when the new value is strictly greater', async () => {
    const { addCredential, updateCredentialCounterIfGreater, getCredentialById } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred({ counter: 5 }));

    const advanced = await updateCredentialCounterIfGreater('cred-1', 6);
    expect(advanced).toBe(true);
    expect((await getCredentialById('cred-1'))?.counter).toBe(6);
  });

  it('refuses (returns false) and leaves the counter untouched when the new value is not greater — the clone/replay signal', async () => {
    const { addCredential, updateCredentialCounterIfGreater, getCredentialById } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred({ counter: 5 }));

    expect(await updateCredentialCounterIfGreater('cred-1', 5)).toBe(false); // equal
    expect(await updateCredentialCounterIfGreater('cred-1', 3)).toBe(false); // lower
    expect((await getCredentialById('cred-1'))?.counter).toBe(5);
  });

  it('is race-free under two "concurrent" advances — only one wins the same target counter', async () => {
    const { addCredential, updateCredentialCounterIfGreater } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred({ counter: 5 }));

    const [a, b] = await Promise.all([
      updateCredentialCounterIfGreater('cred-1', 6),
      updateCredentialCounterIfGreater('cred-1', 6),
    ]);
    // Exactly one of the two identical concurrent advances should succeed —
    // the second one's WHERE clause (`counter < 6`) no longer matches once
    // the first has already written 6.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe('deleteCredential', () => {
  it('removes the credential', async () => {
    const { addCredential, deleteCredential, getCredentialById } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred());
    await deleteCredential('cred-1');
    expect(await getCredentialById('cred-1')).toBeNull();
  });
});

describe('deleteCredentialIfAllowed', () => {
  it('returns not_found for an unknown credential id', async () => {
    const { deleteCredentialIfAllowed } = await import('../db/webauthn-credentials-db');
    expect(await deleteCredentialIfAllowed('never-existed', RELAY_ID, false)).toBe('not_found');
  });

  it('returns not_found when the credential belongs to a different relayId', async () => {
    const { addCredential, deleteCredentialIfAllowed } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred());
    expect(await deleteCredentialIfAllowed('cred-1', OTHER_RELAY_ID, false)).toBe('not_found');
  });

  it('deletes normally when requireAtLeastOne is false, even if it is the only credential', async () => {
    const { addCredential, deleteCredentialIfAllowed, getCredentialById } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred());
    expect(await deleteCredentialIfAllowed('cred-1', RELAY_ID, false)).toBe('deleted');
    expect(await getCredentialById('cred-1')).toBeNull();
  });

  it('refuses to delete the last remaining credential when requireAtLeastOne is true', async () => {
    const { addCredential, deleteCredentialIfAllowed, getCredentialById } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred());
    expect(await deleteCredentialIfAllowed('cred-1', RELAY_ID, true)).toBe('last_remaining');
    expect(await getCredentialById('cred-1')).not.toBeNull();
  });

  it('allows deleting when a second credential remains, even with requireAtLeastOne true', async () => {
    const { addCredential, deleteCredentialIfAllowed, getCredentialById } = await import('../db/webauthn-credentials-db');
    await addCredential(makeCred({ credentialId: 'cred-1' }));
    await addCredential(makeCred({ credentialId: 'cred-2' }));

    expect(await deleteCredentialIfAllowed('cred-1', RELAY_ID, true)).toBe('deleted');
    expect(await getCredentialById('cred-1')).toBeNull();
    expect(await getCredentialById('cred-2')).not.toBeNull();
  });
});
