import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptServerSecret, decryptServerSecret } from '../crypto/totp-server-encryption';

describe('totp-server-encryption', () => {
  const originalEnv = process.env.TOTP_ENCRYPTION_KEY;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.TOTP_ENCRYPTION_KEY = originalEnv;
    (process.env as { NODE_ENV?: string }).NODE_ENV = originalNodeEnv;
  });

  it('round-trips a 20-byte TOTP secret', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);
    const secret = new Uint8Array(20).map((_, i) => i);
    const encrypted = encryptServerSecret(secret);
    expect(encrypted).not.toBe(Buffer.from(secret).toString('hex'));
    const decrypted = decryptServerSecret(encrypted);
    expect(Buffer.from(decrypted).equals(Buffer.from(secret))).toBe(true);
  });

  it('produces different ciphertext for the same input each time (random IV)', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'b'.repeat(64);
    const secret = new Uint8Array(20).fill(7);
    const a = encryptServerSecret(secret);
    const b = encryptServerSecret(secret);
    expect(a).not.toBe(b);
    expect(Buffer.from(decryptServerSecret(a)).equals(Buffer.from(secret))).toBe(true);
    expect(Buffer.from(decryptServerSecret(b)).equals(Buffer.from(secret))).toBe(true);
  });

  it('fails to decrypt with the wrong key', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'c'.repeat(64);
    const secret = new Uint8Array(20).fill(1);
    const encrypted = encryptServerSecret(secret);

    process.env.TOTP_ENCRYPTION_KEY = 'd'.repeat(64);
    expect(() => decryptServerSecret(encrypted)).toThrow();
  });

  it('throws in production if TOTP_ENCRYPTION_KEY is unset', () => {
    (process.env as { NODE_ENV: string }).NODE_ENV = 'production';
    delete process.env.TOTP_ENCRYPTION_KEY;
    expect(() => encryptServerSecret(new Uint8Array(20))).toThrow(/TOTP_ENCRYPTION_KEY/);
  });

  it('falls back to a dev key outside production', () => {
    (process.env as { NODE_ENV: string }).NODE_ENV = 'development';
    delete process.env.TOTP_ENCRYPTION_KEY;
    const secret = new Uint8Array(20).fill(9);
    const encrypted = encryptServerSecret(secret);
    expect(Buffer.from(decryptServerSecret(encrypted)).equals(Buffer.from(secret))).toBe(true);
  });
});
