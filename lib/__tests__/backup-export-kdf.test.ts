import { describe, it, expect } from 'vitest';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { deriveExportKey } from '../db/relay-store';

// Regression coverage for the backup export-password KDF fix: v1 fed the raw
// export password straight into HKDF-Extract as the salt, which is a single
// HMAC — given the identity's privateKey (the threat model where this
// matters: attacker has the privateKey and the backup file, needs the
// password to decrypt contents), password guessing was as cheap as one HMAC
// per guess. v2 stretches the password through scrypt first. This does not
// exercise exportEncryptedBackup/importEncryptedBackup directly since they
// depend on IndexedDB (no fake-indexeddb polyfill in this repo) — it tests
// the KDF function they both call.
describe('backup export-password KDF (deriveExportKey)', () => {
  const privateKey = new Uint8Array(32).fill(9);
  const password = 'correct horse battery staple';

  it('v1 and v2 derive different keys for the same inputs (v2 actually stretches)', async () => {
    const v1Key = await deriveExportKey(privateKey, password, 1);
    const v2Key = await deriveExportKey(privateKey, password, 2);
    expect(Buffer.from(v1Key).toString('hex')).not.toBe(Buffer.from(v2Key).toString('hex'));
  });

  it('v2 is deterministic for the same privateKey+password', async () => {
    const a = await deriveExportKey(privateKey, password, 2);
    const b = await deriveExportKey(privateKey, password, 2);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  }, 20_000);

  it('v2 produces a different key for a different password (still a real KDF, not a no-op)', async () => {
    const a = await deriveExportKey(privateKey, password, 2);
    const b = await deriveExportKey(privateKey, 'wrong password', 2);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  }, 20_000);

  it('v2 key round-trips through the same AEAD scheme export/import use', async () => {
    const key = await deriveExportKey(privateKey, password, 2);
    const nonce = new Uint8Array(12).fill(1);
    const plaintext = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));

    const ciphertext = chacha20poly1305(key, nonce).encrypt(plaintext);
    const decrypted = chacha20poly1305(key, nonce).decrypt(ciphertext);
    expect(new TextDecoder().decode(decrypted!)).toBe('{"hello":"world"}');

    const wrongKey = await deriveExportKey(privateKey, 'wrong password', 2);
    expect(() => chacha20poly1305(wrongKey, nonce).decrypt(ciphertext)).toThrow();
  }, 20_000);
});
