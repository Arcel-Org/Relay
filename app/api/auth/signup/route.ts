import { NextRequest, NextResponse } from 'next/server';
import { LibsqlError } from '@libsql/client';
import { saveUser, getUserByRelayId, deleteUser } from '@/lib/db/relay-server-db';
import { isRelayIdBanned } from '@/lib/db/banned-relay-ids-db';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { generateAvatar } from '@/lib/avatar-constants';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { relayIdFromPublicKeyHex, isValidRelayId } from '@/lib/crypto/relay-id';
import { encryptServerSecret } from '@/lib/crypto/totp-server-encryption';
import { verifyRegistrationTicket } from '@/lib/crypto/webauthn-server';
import { addCredential, getCredentialById } from '@/lib/db/webauthn-credentials-db';
import { setSessionCookie } from '@/lib/db/server-session';
import { log } from '@/lib/platform/logger';

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Rate limit: 3 signups per minute per IP
  const rateLimited = checkRateLimit(request, 'auth:signup', { maxRequests: 3, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const body = await request.json();

  // Validate required fields
  if (!body.id || !body.publicKeyHex || !body.encryptedTOTPSecret) {
    return apiError('VALIDATION_ERROR', 'Missing required user fields', 400);
  }

  // id is always the account's Relay ID (relay-auth-store-v2.ts sets
  // userId = signupIdentity.relayId) — validate against the one real format
  // instead of a hand-duplicated regex.
  if (typeof body.id !== 'string' || !isValidRelayId(body.id)) {
    return apiError('VALIDATION_ERROR', 'Invalid id format', 400);
  }

  // Validate publicKeyHex: must be 64 hex chars (32 bytes X25519)
  if (typeof body.publicKeyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(body.publicKeyHex)) {
    return apiError('VALIDATION_ERROR', 'Invalid public key format', 400);
  }

  // Validate pqPublicKeyHex if provided: must be 2368 hex chars (1184 bytes ML-KEM768 public key)
  if (body.pqPublicKeyHex !== undefined && body.pqPublicKeyHex !== null) {
    if (typeof body.pqPublicKeyHex !== 'string' || !/^[a-f0-9]{2368}$/i.test(body.pqPublicKeyHex)) {
      return apiError('VALIDATION_ERROR', 'Invalid PQ public key format', 400);
    }
  }

  // The client sends the raw TOTP secret (20 bytes = 40 hex chars) over HTTPS
  // at signup only; the server encrypts it below before it ever touches disk.
  if (typeof body.encryptedTOTPSecret !== 'string' || !/^[a-f0-9]{40}$/i.test(body.encryptedTOTPSecret)) {
    return apiError('VALIDATION_ERROR', 'Invalid encryptedTOTPSecret', 400);
  }
  if (body.encryptedTOTPSecretForRecovery !== undefined && typeof body.encryptedTOTPSecretForRecovery !== 'string') {
    return apiError('VALIDATION_ERROR', 'Invalid encryptedTOTPSecretForRecovery', 400);
  }

  // recoveryCodeHash is a BLAKE3/SHA-256 digest (lib/crypto/recovery-code.ts)
  // — 64 hex chars, same as every other hash/key field validated above.
  if (body.recoveryCodeHash !== undefined && (typeof body.recoveryCodeHash !== 'string' || !/^[a-f0-9]{64}$/i.test(body.recoveryCodeHash))) {
    return apiError('VALIDATION_ERROR', 'Invalid recoveryCodeHash', 400);
  }

  const twoFactorMethod: 'totp' | 'webauthn' = body.twoFactorMethod === 'webauthn' ? 'webauthn' : 'totp';
  if (twoFactorMethod === 'webauthn' && typeof body.webauthnTicket !== 'string') {
    return apiError('VALIDATION_ERROR', 'Missing webauthnTicket', 400);
  }

  // Derive the relayId server-side from the public key. Never trust a
  // client-submitted relayId — doing so would let an attacker register one
  // keypair under a different user's ID.
  const derivedRelayId = relayIdFromPublicKeyHex(body.publicKeyHex.toLowerCase());
  if (!isValidRelayId(derivedRelayId)) {
    return apiError('VALIDATION_ERROR', 'Failed to derive relayId', 400);
  }
  if (typeof body.relayId === 'string' && body.relayId !== derivedRelayId) {
    return apiError('VALIDATION_ERROR', 'relayId does not match public key', 400);
  }

  // A banned relayId must never be re-creatable — it's deterministic from
  // the public key, and the client's local keypair survives a server-side
  // ban untouched, so without this check the exact same signup request
  // could simply be replayed to undo an operator's ban.
  if (await isRelayIdBanned(derivedRelayId)) {
    log.warn(`[Signup] Rejected signup attempt for permanently banned relayId "${derivedRelayId}"`);
    return apiError('FORBIDDEN', 'This Relay ID has been permanently banned', 403);
  }

  // Uniqueness: a different account must not already own this relayId.
  // (Same relayId + same id is an idempotent retry and is allowed.)
  const existing = await getUserByRelayId(derivedRelayId);
  if (existing && existing.id !== body.id) {
    log.error(`[Signup] relayId conflict: "${derivedRelayId}" already registered under a different id`);
    return apiError('CONFLICT', 'relayId already registered', 409);
  }

  // Validate the WebAuthn ticket up front, before touching the DB — the
  // ticket encapsulates a credential the user already proved possession of
  // during the pre-register ceremony (see webauthn-server.ts).
  let webauthnCredential: ReturnType<typeof verifyRegistrationTicket> = null;
  if (twoFactorMethod === 'webauthn') {
    webauthnCredential = verifyRegistrationTicket(body.webauthnTicket as string, derivedRelayId);
    if (!webauthnCredential) {
      log.error(`[Signup] Invalid or expired webauthnTicket for relayId "${derivedRelayId}"`);
      return apiError('VALIDATION_ERROR', 'Invalid or expired webauthnTicket — please retry hardware key registration', 400);
    }
  }

  // Assign avatar — generated server-side, immutable after this point
  const avatar = generateAvatar();

  // Construct a clean user object with only known fields — never persist
  // arbitrary client-supplied keys (could inject lockedUntil, recoveryCodeHash, etc.)
  const user = {
    id: body.id as string,
    relayId: derivedRelayId,
    publicKeyHex: body.publicKeyHex.toLowerCase() as string,
    // Encrypted at rest with a server-only key (TOTP_ENCRYPTION_KEY) —
    // a DB leak alone no longer yields a usable TOTP secret.
    encryptedTOTPSecret: encryptServerSecret(Buffer.from(body.encryptedTOTPSecret as string, 'hex')),
    encryptedTOTPSecretForRecovery: (body.encryptedTOTPSecretForRecovery as string) ?? '',
    createdAt: Date.now(),
    pqPublicKeyHex: body.pqPublicKeyHex as string | undefined,
    recoveryCodeHash: body.recoveryCodeHash as string | undefined,
    avatarEmoji: avatar.emoji,
    avatarColor: avatar.color,
    twoFactorMethod,
  };

  try {
    await saveUser(user);
  } catch (err) {
    // saveUser's INSERT upserts on conflict(id) only — a second concurrent
    // signup deriving the same relayId (the pre-check above is TOCTOU-racy)
    // trips the relayId UNIQUE constraint instead, which the ON CONFLICT
    // clause doesn't absorb. Map that to the same 409 the non-racy path
    // above already returns, instead of a bare 500.
    if (err instanceof LibsqlError && err.code === 'SQLITE_CONSTRAINT') {
      return apiError('CONFLICT', 'relayId already registered', 409);
    }
    throw err;
  }

  if (webauthnCredential) {
    // verifyRegistrationTicket is stateless (HMAC + expiry, never marked
    // consumed) — a retried/double-submitted signup request re-verifies the
    // same ticket successfully and reaches here a second time. Check for
    // that idempotent-retry case (the credential this exact request would
    // insert already exists for this account) BEFORE inserting, so a
    // primary-key-violation on retry is never mistaken for "signup failed"
    // and used to delete the account the first request just created.
    const alreadyStored = await getCredentialById(webauthnCredential.credentialId);
    if (alreadyStored) {
      if (alreadyStored.relayId !== derivedRelayId) {
        // A different account already owns this exact credential — this
        // request cannot proceed under this relayId, but it's not this
        // brand-new account's fault, so don't delete it either.
        log.error(`[Signup] Hardware key already registered to a different account (relayId "${derivedRelayId}")`);
        return apiError('CONFLICT', 'This hardware key is already registered to a different account', 409);
      }
      // Same credential, same account — the earlier request already
      // succeeded; nothing left to do.
    } else {
      try {
        await addCredential({
          credentialId: webauthnCredential.credentialId,
          relayId: derivedRelayId,
          publicKeyHex: webauthnCredential.publicKeyHex,
          counter: webauthnCredential.counter,
          transports: webauthnCredential.transports,
          createdAt: Date.now(),
        });
      } catch (err) {
        // Roll back — an account with twoFactorMethod='webauthn' and no
        // credential can never log in. Only reachable now for a genuine
        // insert failure, not an idempotent retry (handled above).
        log.error(`[Signup] Failed to store hardware key credential for relayId "${derivedRelayId}", rolling back:`, err);
        await deleteUser(user.id);
        return apiError('SERVER_ERROR', 'Failed to store hardware key credential — please retry signup', 500);
      }
    }
  }

  const successResponse = NextResponse.json(
    {
      success: true,
      relayId: user.relayId,
      avatarEmoji: user.avatarEmoji,
      avatarColor: user.avatarColor,
      publicKeyHex: user.publicKeyHex,
      pqPublicKeyHex: user.pqPublicKeyHex || null,
    },
    { status: 200 }
  );

  // Establish the session immediately — same trust level as login (the
  // relayId is cryptographically derived from the submitted public key, not
  // client-asserted). Without this, the client lands "authenticated" locally
  // but has no cookie, so the first WS connection's ws-ticket fetch 401s.
  await setSessionCookie(successResponse, user.relayId);
  return successResponse;
});
