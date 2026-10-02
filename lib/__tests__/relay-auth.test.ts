import { describe, it, expect } from 'vitest';
import {
  generateRelayIdentity,
  deriveTOTPSecret,
  createTOTPFromKey,
  createTOTPFromSecret,
  verifyTOTPCode,
  createStoredIdentity,
  recoverIdentity,
  verifyPIN,
  hashDuressPin,
  verifyDuressPin,
} from '../crypto/relay-auth';

// PBKDF2 is deliberately 200k iterations (anti-bruteforce) — these tests are
// slow by design, not flaky. createStoredIdentity always uses the browser's
// ambient device fingerprint (getDeviceFingerprint(), backed by jsdom's
// localStorage in this test environment); recoverIdentity falls back to the
// same ambient fingerprint when no explicit override is passed, so the
// "happy path" round-trip below needs no fingerprint argument on either side.

describe('relay-auth: identity + PIN storage', () => {
  it('creates and recovers an identity round-trip with the correct PIN', async () => {
    const identity = await generateRelayIdentity();
    const stored = await createStoredIdentity(identity, '123456');
    const recovered = await recoverIdentity(stored, '123456');

    expect(Buffer.from(recovered.privateKey).equals(Buffer.from(identity.privateKey))).toBe(true);
    expect(recovered.relayId).toBe(identity.relayId);
  });

  it('fails to recover with the wrong PIN', async () => {
    const identity = await generateRelayIdentity();
    const stored = await createStoredIdentity(identity, '123456');
    await expect(recoverIdentity(stored, '999999')).rejects.toThrow();
  });

  it('fails to recover with the right PIN but wrong device fingerprint', async () => {
    const identity = await generateRelayIdentity();
    const stored = await createStoredIdentity(identity, '123456');
    // Explicit override forces a different fingerprint than the ambient one
    // createStoredIdentity actually used — the decrypt must fail.
    await expect(recoverIdentity(stored, '123456', 'a-completely-different-fingerprint')).rejects.toThrow();
  });

  it('verifyPIN returns true for the correct PIN and false for a wrong one', async () => {
    const identity = await generateRelayIdentity();
    const stored = await createStoredIdentity(identity, '246810');
    expect(await verifyPIN(stored, '246810')).toBe(true);
    expect(await verifyPIN(stored, '111111')).toBe(false);
  });

  it('round-trips the post-quantum (ML-KEM768) private key alongside the classical key', async () => {
    const identity = await generateRelayIdentity();
    expect(identity.pqPrivateKey).toBeDefined();
    const stored = await createStoredIdentity(identity, '135790');
    expect(stored.encryptedPqPrivateKey).toBeDefined();
    const recovered = await recoverIdentity(stored, '135790');
    expect(Buffer.from(recovered.pqPrivateKey!).equals(Buffer.from(identity.pqPrivateKey!))).toBe(true);
  });
});

describe('relay-auth: duress PIN', () => {
  it('verifies a matching duress PIN and rejects a non-matching one', async () => {
    const hash = await hashDuressPin('998877', 'fp-duress-1');
    expect(await verifyDuressPin('998877', 'fp-duress-1', hash)).toBe(true);
    expect(await verifyDuressPin('000000', 'fp-duress-1', hash)).toBe(false);
  });

  it('is device-fingerprint bound — same PIN, different device, does not match', async () => {
    const hash = await hashDuressPin('998877', 'fp-duress-2');
    expect(await verifyDuressPin('998877', 'fp-duress-other', hash)).toBe(false);
  });

  it('is domain-separated from the real PIN storage key — using the duress hash as a "PIN" cannot decrypt the real identity', async () => {
    const identity = await generateRelayIdentity();
    const stored = await createStoredIdentity(identity, '123456');
    const duressHash = await hashDuressPin('123456', 'fp-domain');
    await expect(recoverIdentity(stored, duressHash)).rejects.toThrow();
  });
});

describe('relay-auth: TOTP', () => {
  it('derives the same TOTP secret deterministically from the same private key', async () => {
    const identity = await generateRelayIdentity();
    const secretA = deriveTOTPSecret(identity.privateKey);
    const secretB = deriveTOTPSecret(identity.privateKey);
    expect(Buffer.from(secretA).equals(Buffer.from(secretB))).toBe(true);
  });

  it('derives different TOTP secrets for different private keys', async () => {
    const identityA = await generateRelayIdentity();
    const identityB = await generateRelayIdentity();
    const secretA = deriveTOTPSecret(identityA.privateKey);
    const secretB = deriveTOTPSecret(identityB.privateKey);
    expect(Buffer.from(secretA).equals(Buffer.from(secretB))).toBe(false);
  });

  it('accepts the current code and rejects an arbitrary wrong code', async () => {
    const identity = await generateRelayIdentity();
    const totp = createTOTPFromKey(identity.privateKey);
    const currentCode = totp.generate();
    const wrongCode = currentCode === '000000' ? '111111' : '000000';
    expect(verifyTOTPCode(totp, currentCode)).toBe(true);
    expect(verifyTOTPCode(totp, wrongCode)).toBe(false);
  });

  it('createTOTPFromSecret produces the same codes as createTOTPFromKey for the derived secret', async () => {
    const identity = await generateRelayIdentity();
    const secret = deriveTOTPSecret(identity.privateKey);
    const totpFromKey = createTOTPFromKey(identity.privateKey);
    const totpFromSecret = createTOTPFromSecret(secret);
    expect(totpFromSecret.generate()).toBe(totpFromKey.generate());
  });
});
