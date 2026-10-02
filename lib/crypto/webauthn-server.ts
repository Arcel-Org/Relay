/**
 * FIDO2/WebAuthn hardware-key ceremony logic (server side).
 *
 * Two flows:
 * 1. Pre-account registration (signup): the ceremony's verified result is
 *    encapsulated in a short-lived signed ticket rather than persisted to
 *    disk, so an abandoned signup leaves no server-side trace. The signup
 *    route verifies the ticket and inserts the credential atomically with
 *    the new user row.
 * 2. Login (existing account): a normal challenge/response against
 *    already-stored credentials in webauthn_credentials.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getCredentialsByRelayId, getCredentialById, updateCredentialCounterIfGreater } from '@/lib/db/webauthn-credentials-db';
import { isDevLikeEnv } from '@/lib/platform/env';

const TICKET_LIFETIME_MS = 15 * 60 * 1000; // 15 minutes — enough for one signup session
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes

function getRpId(): string {
  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) {
    if (!isDevLikeEnv()) {
      throw new Error('WEBAUTHN_RP_ID environment variable is required (only development/test may use the localhost fallback)');
    }
    return 'localhost';
  }
  return rpId;
}

function getOrigin(): string {
  const origin = process.env.WEBAUTHN_ORIGIN;
  if (!origin) {
    if (!isDevLikeEnv()) {
      throw new Error('WEBAUTHN_ORIGIN environment variable is required (only development/test may use the localhost fallback)');
    }
    return 'http://localhost:3000';
  }
  return origin;
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (!isDevLikeEnv()) {
      throw new Error('SESSION_SECRET environment variable is required and must be at least 32 characters (only development/test may use the insecure dev fallback)');
    }
    return 'dev-only-session-secret-change-me-in-production!!';
  }
  return secret;
}

function sign(payload: string): string {
  return Buffer.from(createHmac('sha256', getSecret()).update(payload).digest()).toString('base64url');
}

function verifySignature(payload: string, sig: string): boolean {
  const expected = sign(payload);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

// ── In-memory challenge store (single-server deployment; see relay-server-db.ts) ──
const pendingChallenges = new Map<string, { challenge: string; expiresAt: number }>();

// Prevent unbounded growth from abandoned ceremonies (pre-auth endpoints are
// reachable without a session, so entries can accumulate faster than they're consumed).
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60 * 1000;
function sweepExpiredChallenges(): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, entry] of pendingChallenges) {
    if (entry.expiresAt < now) pendingChallenges.delete(key);
  }
}

function storeChallenge(key: string, challenge: string): void {
  sweepExpiredChallenges();
  pendingChallenges.set(key, { challenge, expiresAt: Date.now() + CHALLENGE_LIFETIME_MS });
}

function takeChallenge(key: string): string | null {
  const entry = pendingChallenges.get(key);
  pendingChallenges.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

// ── Registration (pre-account, used during signup) ──

export async function generatePreRegistrationOptions(relayId: string) {
  const options = await generateRegistrationOptions({
    rpName: 'Relay',
    rpID: getRpId(),
    userName: relayId,
    userID: new TextEncoder().encode(relayId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  storeChallenge(`reg:${relayId}`, options.challenge);
  return options;
}

export interface RegisteredCredentialData {
  credentialId: string;
  publicKeyHex: string;
  counter: number;
  transports?: string[];
}

/**
 * Verifies a registration ceremony and returns a signed ticket encapsulating
 * the credential data. Nothing is written to the DB here — the caller
 * (signup route) does that atomically with the user row.
 */
export async function verifyPreRegistrationAndIssueTicket(
  relayId: string,
  response: RegistrationResponseJSON
): Promise<{ ticket: string } | { error: string }> {
  const challenge = takeChallenge(`reg:${relayId}`);
  if (!challenge) return { error: 'Registration challenge expired or not found — please retry' };

  let result: VerifiedRegistrationResponse;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: getOrigin(),
      expectedRPID: getRpId(),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Verification failed' };
  }
  if (!result.verified || !result.registrationInfo) return { error: 'Registration could not be verified' };

  const { credential } = result.registrationInfo;
  const data: RegisteredCredentialData = {
    credentialId: credential.id,
    publicKeyHex: bytesToHex(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
  };

  const payloadObj = { relayId, data, expiresAt: Date.now() + TICKET_LIFETIME_MS };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = sign(payload);
  return { ticket: `${payload}.${sig}` };
}

/** Validates a registration ticket produced above. Returns the credential data if valid for relayId. */
export function verifyRegistrationTicket(ticket: string, expectedRelayId: string): RegisteredCredentialData | null {
  const dot = ticket.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (!verifySignature(payload, sig)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      relayId: string;
      data: RegisteredCredentialData;
      expiresAt: number;
    };
    if (decoded.relayId !== expectedRelayId) return null;
    if (Date.now() > decoded.expiresAt) return null;
    return decoded.data;
  } catch {
    return null;
  }
}

// ── Add a key to an already-authenticated existing account (settings page) ──

export async function generateAdditionalKeyOptions(relayId: string) {
  const existing = await getCredentialsByRelayId(relayId);
  const options = await generateRegistrationOptions({
    rpName: 'Relay',
    rpID: getRpId(),
    userName: relayId,
    userID: new TextEncoder().encode(relayId),
    attestationType: 'none',
    // Prevent re-registering a key the account already has.
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as any })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  storeChallenge(`addkey:${relayId}`, options.challenge);
  return options;
}

/**
 * Verifies and immediately persists a new credential for an already-existing,
 * already-authenticated account. Unlike the pre-account signup flow, there's
 * no ticket step — the caller already has a valid session.
 */
export async function verifyAndStoreAdditionalKey(
  relayId: string,
  response: RegistrationResponseJSON
): Promise<{ success: true } | { success: false; error: string }> {
  const challenge = takeChallenge(`addkey:${relayId}`);
  if (!challenge) return { success: false, error: 'Registration challenge expired or not found — please retry' };

  let result: VerifiedRegistrationResponse;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: getOrigin(),
      expectedRPID: getRpId(),
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Verification failed' };
  }
  if (!result.verified || !result.registrationInfo) return { success: false, error: 'Registration could not be verified' };

  const { credential } = result.registrationInfo;
  const { addCredential } = await import('@/lib/db/webauthn-credentials-db');
  await addCredential({
    credentialId: credential.id,
    relayId,
    publicKeyHex: bytesToHex(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    createdAt: Date.now(),
  });
  return { success: true };
}

// ── Login (existing account) ──

export async function generateLoginOptions(relayId: string): Promise<{ options: unknown } | { error: string }> {
  const creds = await getCredentialsByRelayId(relayId);
  if (!creds.length) return { error: 'No hardware key registered for this account' };

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: c.transports as any,
    })),
    userVerification: 'preferred',
  });
  // Keyed by relayId+challenge, not just relayId: a single-slot store here
  // means a second login-options request for the same account (two open
  // tabs, or a client retry before the first ceremony resolves) silently
  // discards the first ceremony's challenge. When the user then completes
  // the FIRST tap, verification fails with a spurious "expired" error even
  // though they're well inside the TTL — the store just no longer has it.
  // Multiple concurrent slots per account let either ceremony complete.
  storeChallenge(`login:${relayId}:${options.challenge}`, options.challenge);
  return { options };
}

function decodeClientDataChallenge(clientDataJSONBase64Url: string): string | null {
  try {
    const json = Buffer.from(clientDataJSONBase64Url, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json);
    return typeof parsed.challenge === 'string' ? parsed.challenge : null;
  } catch {
    return null;
  }
}

export async function verifyLoginResponse(
  relayId: string,
  response: AuthenticationResponseJSON
): Promise<{ verified: true } | { verified: false; error: string }> {
  // Recover which of this account's (possibly several) concurrent pending
  // challenges this assertion was actually made against, rather than
  // assuming a single shared slot — see the comment in generateLoginOptions.
  const clientChallenge = decodeClientDataChallenge(response.response?.clientDataJSON);
  if (!clientChallenge) return { verified: false, error: 'Malformed authentication response' };

  const challenge = takeChallenge(`login:${relayId}:${clientChallenge}`);
  if (!challenge) return { verified: false, error: 'Login challenge expired or not found — please retry' };

  const stored = await getCredentialById(response.id);
  if (!stored || stored.relayId !== relayId) return { verified: false, error: 'Unknown credential' };

  const credential: WebAuthnCredential = {
    id: stored.credentialId,
    publicKey: hexToBytes(stored.publicKeyHex) as Uint8Array<ArrayBuffer>,
    counter: stored.counter,
    transports: stored.transports as any,
  };

  let result: VerifiedAuthenticationResponse;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: getOrigin(),
      expectedRPID: getRpId(),
      credential,
    });
  } catch (err) {
    return { verified: false, error: err instanceof Error ? err.message : 'Verification failed' };
  }
  if (!result.verified) return { verified: false, error: 'Could not be verified' };

  // Counter must strictly increase (0 means the authenticator doesn't support
  // counters at all, e.g. some platform authenticators — allow that case).
  // The advance is a single atomic UPDATE (WHERE counter < newCounter) rather
  // than this check followed by a separate write, so two concurrent logins
  // replaying the same assertion can't both pass the check before either
  // one's write lands.
  if (result.authenticationInfo.newCounter !== 0) {
    const advanced = await updateCredentialCounterIfGreater(stored.credentialId, result.authenticationInfo.newCounter);
    if (!advanced) {
      return { verified: false, error: 'Possible cloned authenticator detected (counter did not advance)' };
    }
  }

  return { verified: true };
}
