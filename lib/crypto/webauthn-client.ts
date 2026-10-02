/**
 * FIDO2/WebAuthn hardware-key ceremony logic (client side, browser only).
 */
'use client';

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { log } from '@/lib/platform/logger';

/**
 * Runs the pre-account registration ceremony during signup: fetches a
 * challenge, prompts the hardware key via the browser, and returns a signed
 * ticket the signup route can redeem. Throws with a user-displayable message
 * on failure (challenge fetch, browser/hardware rejection, or verify-side error).
 */
export async function registerHardwareKeyForSignup(relayId: string): Promise<string> {
  const optionsRes = await fetch('/api/auth/webauthn/pre-register-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relayId }),
  });
  if (!optionsRes.ok) {
    const err = await optionsRes.json().catch(() => ({}));
    throw new Error(err.error || 'Could not start hardware key registration');
  }
  const { options } = await optionsRes.json();

  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    log.warn('[WebAuthn] Registration ceremony cancelled or failed:', err);
    throw new Error('Hardware key registration was cancelled or failed. Try again.');
  }

  const verifyRes = await fetch('/api/auth/webauthn/pre-register-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relayId, response }),
  });
  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(err.error || 'Hardware key verification failed');
  }
  const { ticket } = await verifyRes.json();
  return ticket as string;
}

/**
 * Runs the login ceremony for an account with twoFactorMethod === 'webauthn'.
 * Returns the assertion to send to /api/auth/login as `webauthnAssertion`.
 */
export async function authenticateWithHardwareKey(relayId: string): Promise<unknown> {
  const optionsRes = await fetch('/api/auth/webauthn/login-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relayId }),
  });
  if (!optionsRes.ok) {
    const err = await optionsRes.json().catch(() => ({}));
    throw new Error(err.error || 'Could not start hardware key login');
  }
  const { options } = await optionsRes.json();

  try {
    return await startAuthentication({ optionsJSON: options });
  } catch (err) {
    log.warn('[WebAuthn] Authentication ceremony cancelled or failed:', err);
    throw new Error('Hardware key tap was cancelled or failed. Try again.');
  }
}

export interface RegisteredKeySummary {
  credentialId: string;
  transports?: string[];
  createdAt: number;
}

/** Lists the current (session-authenticated) user's registered hardware keys. */
export async function listHardwareKeys(): Promise<{ twoFactorMethod: 'totp' | 'webauthn'; credentials: RegisteredKeySummary[] }> {
  const res = await fetch('/api/auth/webauthn/credentials');
  if (!res.ok) throw new Error('Could not load hardware keys');
  return res.json();
}

/**
 * Registers an additional hardware key for the current (session-
 * authenticated) account. Step-up: the server now requires proof of an
 * EXISTING credential (a fresh login-style assertion) before accepting the
 * new one — see register-verify/route.ts's doc comment for why — so this
 * runs a full login-ceremony tap first, same as regenerate-recovery-code's
 * webauthn path already does.
 */
export async function addHardwareKey(relayId: string): Promise<void> {
  const webauthnAssertion = await authenticateWithHardwareKey(relayId);

  const optionsRes = await fetch('/api/auth/webauthn/register-options', { method: 'POST' });
  if (!optionsRes.ok) {
    const err = await optionsRes.json().catch(() => ({}));
    throw new Error(err.error || 'Could not start hardware key registration');
  }
  const { options } = await optionsRes.json();

  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    log.warn('[WebAuthn] Registration ceremony cancelled or failed:', err);
    throw new Error('Hardware key registration was cancelled or failed. Try again.');
  }

  const verifyRes = await fetch('/api/auth/webauthn/register-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response, webauthnAssertion }),
  });
  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(err.error || 'Hardware key verification failed');
  }
}

/** Revokes a registered hardware key for the current (session-authenticated) account. */
export async function revokeHardwareKey(credentialId: string): Promise<void> {
  const res = await fetch('/api/auth/webauthn/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentialId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Could not revoke hardware key');
  }
}
