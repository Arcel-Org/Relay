# Arcel REST API Reference

Base URL: `https://<host>:3000/api`

All endpoints accept and return `application/json`. Error responses use a standardized format (see [Error Handling](#error-handling)).

---

## Authentication

Two authentication mechanisms are used:

1. **Unauthenticated** -- Public endpoints (signup, login, lookups) require no credentials.
2. **Session cookie** -- Mutating profile endpoints require an `relay_session` HttpOnly cookie, set automatically on successful login. The cookie value is an **opaque, high-entropy random token** (not a signed payload) — the server looks up a hash of it against a server-side session store on every request. A stolen/copied token can be individually revoked server-side; it cannot be forged from any secret alone. Expires after **24 hours** (or sooner, per the account's configured inactivity timeout).

---

## Rate Limiting

Rate limiting is applied per-IP using an in-memory sliding window. When a limit is exceeded, the server returns HTTP `429` with the following headers:

| Header                 | Description                                      |
|------------------------|--------------------------------------------------|
| `Retry-After`          | Seconds until the window resets                  |
| `X-RateLimit-Limit`    | Maximum requests allowed in the window           |
| `X-RateLimit-Remaining`| Remaining requests (always `0` when rate limited)|
| `X-RateLimit-Reset`    | Unix timestamp (seconds) when the window resets  |

**429 response body:**

```json
{
  "error": "Too many requests. Please try again later."
}
```

Client IP is determined from `X-Forwarded-For` (first value), then `X-Real-IP`, then falls back to `"unknown"`.

---

## Error Handling

All errors follow a consistent JSON shape:

```json
{
  "error": "<human-readable message>",
  "code": "<ERROR_CODE>"
}
```

### Error Codes

| Code               | HTTP Status | Description                                  |
|--------------------|-------------|----------------------------------------------|
| `VALIDATION_ERROR` | 400         | Missing or malformed request fields          |
| `UNAUTHORIZED`     | 401         | Invalid credentials or missing session       |
| `FORBIDDEN`        | 403         | Authenticated but not authorized for action  |
| `NOT_FOUND`        | 404         | Requested resource does not exist            |
| `CONFLICT`         | 409         | Resource conflict (e.g., username taken)     |
| `INTERNAL_ERROR`   | 500         | Unexpected server error                      |

Unhandled exceptions within `withErrorHandler`-wrapped routes are caught and returned as `INTERNAL_ERROR`.

---

## Endpoints

### POST /api/auth/signup

Create a new user account.

**Rate limit:** 3 requests per minute per IP.

**Authentication:** None.

**Request body:**

The **private key never leaves the client and is never sent to the server, in any form, at signup or login.** `relayId` is not client-supplied either -- it's derived server-side from `publicKeyHex` (`sha256(publicKey)`, truncated and hex-grouped; see `lib/crypto/relay-id.ts`), so a client cannot register a relayId for a keypair it doesn't hold.

```json
{
  "id": "uuid-v4",
  "publicKeyHex": "64-hex-chars (32-byte X25519 public key)",
  "pqPublicKeyHex": "2368-hex-chars (1184-byte ML-KEM768 public key, optional)",
  "encryptedTOTPSecret": "40-hex-chars -- raw TOTP secret, HTTPS-only, encrypted at rest server-side before storage",
  "encryptedTOTPSecretForRecovery": "hex-encoded TOTP secret encrypted under the recovery code (optional)",
  "recoveryCodeHash": "64-hex-chars (optional)",
  "twoFactorMethod": "'totp' (default) or 'webauthn'",
  "webauthnTicket": "short-lived signed ticket from /api/auth/webauthn/pre-register-verify -- required if twoFactorMethod is 'webauthn'"
}
```

| Field                            | Type   | Required            | Validation                                    |
|-----------------------------------|--------|----------------------|------------------------------------------------|
| `id`                              | string | yes                  | Non-empty (client-generated account UUID)     |
| `publicKeyHex`                    | string | yes                  | Must match `^[a-f0-9]{64}$`                  |
| `pqPublicKeyHex`                  | string | no                   | Must match `^[a-f0-9]{2368}$` if present     |
| `encryptedTOTPSecret`             | string | yes                  | Must match `^[a-f0-9]{40}$`                  |
| `encryptedTOTPSecretForRecovery`  | string | no                   | --                                              |
| `recoveryCodeHash`                | string | no                   | Must match `^[a-f0-9]{64}$` if present       |
| `twoFactorMethod`                 | string | no (defaults `totp`) | `'totp'` or `'webauthn'`                      |
| `webauthnTicket`                  | string | only if webauthn     | Verified against the ticket issued by pre-register-verify |

**Success response (200):**

```json
{
  "success": true,
  "relayId": "a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6",
  "avatarEmoji": "...",
  "avatarColor": "#RRGGBB",
  "publicKeyHex": "...",
  "pqPublicKeyHex": "... or null"
}
```

The server assigns a random avatar (emoji + color) at signup. Avatars are immutable after creation. The response also sets the `relay_session` cookie -- signup logs the account in immediately.

**Errors:**

| Code               | Status | Condition                                          |
|--------------------|--------|-----------------------------------------------------|
| `VALIDATION_ERROR` | 400    | Missing required fields                            |
| `VALIDATION_ERROR` | 400    | Invalid `id`/`publicKeyHex`/`pqPublicKeyHex`/`encryptedTOTPSecret` format |
| `VALIDATION_ERROR` | 400    | Invalid or expired `webauthnTicket`                |
| `CONFLICT`         | 409    | `relayId` (derived from `publicKeyHex`) already registered |

---

### POST /api/auth/login

Authenticate an existing account with a live second factor (TOTP or WebAuthn). **The PIN is never sent to the server** -- it only decrypts the identity locally on the client; the server has no knowledge of it at all. What the server verifies is the account's configured second factor.

**Rate limit:** 15 requests per minute per IP. (This is a secondary speed bump against credential-stuffing sprays across many accounts from one IP -- the real per-account brute-force defense is a 10-failed-attempt / 15-minute lockout keyed on `relayId`, independent of source IP.)

**Authentication:** None.

**Request body (TOTP account):**

```json
{
  "relayId": "a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6",
  "totpCode": "789012"
}
```

**Request body (WebAuthn account):**

```json
{
  "relayId": "a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6",
  "webauthnAssertion": { "...": "output of navigator.credentials.get(), see /api/auth/webauthn/login-options" }
}
```

| Field               | Type   | Required                          | Validation                          |
|----------------------|--------|-------------------------------------|--------------------------------------|
| `relayId`           | string | yes                                | Must match the canonical relayId format |
| `totpCode`          | string | if the account uses TOTP          | Exactly 6 digits                    |
| `webauthnAssertion` | object | if the account uses WebAuthn      | Verified server-side against the stored credential |

**Server behavior:**

1. Looks up the user by `relayId`.
2. Rejects with `423` if the account is currently locked out (10 failed attempts within 15 minutes).
3. Verifies the TOTP code (rejecting replays within the same ~60s window) or the WebAuthn assertion, depending on the account's configured method.
4. On success, sets an `relay_session` HttpOnly cookie and resets the failed-attempt counter.
5. On failure, records a failed attempt (which may trigger the lockout above).

**Success response (200):**

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "relayId": "a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6",
    "createdAt": 1700000000000,
    "username": "alice",
    "displayName": "Alice"
  }
}
```

No key material of any kind is ever returned -- the client already has its own private key locally; the server never held it and never sends it.

**Set-Cookie:** `relay_session=<opaque random token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`

**Errors:**

| Code               | Status | Condition                                              |
|--------------------|--------|----------------------------------------------------------|
| `VALIDATION_ERROR` | 400    | Missing fields, invalid `relayId` format, or malformed TOTP code |
| `UNAUTHORIZED`     | 401    | Invalid credentials (user not found, wrong TOTP/WebAuthn -- deliberately identical response to avoid leaking which) |
| `UNAUTHORIZED`     | 423    | Account temporarily locked from repeated failed attempts |

---

### POST /api/auth/recovery-login

Authenticate using a recovery code plus a live TOTP code -- used when the PIN/local identity is unavailable (e.g., after clearing site data). Both the recovery code and the TOTP code must be valid; neither alone is sufficient.

**Rate limit:** 3 requests per minute per IP (stricter than `/api/auth/login` -- this endpoint is a second, independent path to full account access).

**Authentication:** None.

**Request body:**

```json
{
  "relayId": "a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6",
  "recoveryCode": "the recovery code shown once at signup",
  "totpCode": "789012"
}
```

| Field          | Type   | Required | Validation                          |
|----------------|--------|----------|---------------------------------------|
| `relayId`      | string | yes      | Must match the canonical relayId format |
| `recoveryCode` | string | yes      | Non-empty                            |
| `totpCode`     | string | yes      | Exactly 6 digits                     |

**Server behavior:**

1. Looks up the user by `relayId`; shares the same 10-attempt / 15-minute lockout as `/api/auth/login`.
2. Verifies the recovery code against its stored hash.
3. Rejects a TOTP code already used within its validity window (replay protection, same as `/api/auth/login`).
4. Decrypts the TOTP secret using the recovery code and verifies the TOTP code against it.
5. On success, sets an `relay_session` HttpOnly cookie.

**Success response (200):**

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "relayId": "a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6",
    "createdAt": 1700000000000
  },
  "publicKeyHex": "hex-encoded -- public, not secret; the private key is never returned"
}
```

**Errors:**

| Code               | Status | Condition                                          |
|--------------------|--------|-------------------------------------------------------|
| `VALIDATION_ERROR` | 400    | Missing required fields or invalid `relayId`/TOTP format |
| `VALIDATION_ERROR` | 400    | Recovery not available for this account (no recovery code was ever set up) |
| `UNAUTHORIZED`     | 401    | Invalid credentials (user not found, wrong recovery code, replayed or wrong TOTP code -- deliberately identical response) |
| `UNAUTHORIZED`     | 423    | Account temporarily locked from repeated failed attempts |

---

### POST /api/auth/username-lookup

Resolve a username or relay ID to a relay ID. Returns minimal data to preserve privacy.

**Rate limit:** None (application-level).

**Authentication:** None.

**Request body:**

```json
{
  "input": "@alice"
}
```

| Field   | Type   | Required | Description                                          |
|---------|--------|----------|------------------------------------------------------|
| `input` | string | yes      | A username (optionally prefixed with `@`) or a relay ID (`...`) |

**Server behavior:**

- If input starts with ``, it is treated as a relay ID lookup (must match `^[a-f0-9]{8}$`).
- Otherwise, it is treated as a username lookup. A leading `@` is stripped. The username is lowercased.
- Username must match `^[a-z0-9_]+$`.

**Success response (200):**

```json
{
  "relayId": "a1b2c3d4"
}
```

**Errors:**

| Code               | Status | Condition                        |
|--------------------|--------|----------------------------------|
| `VALIDATION_ERROR` | 400    | Missing or invalid input         |
| `VALIDATION_ERROR` | 400    | Invalid relay ID format          |
| `VALIDATION_ERROR` | 400    | Invalid username format          |
| `NOT_FOUND`        | 404    | User not found                   |

---

### POST /api/auth/regenerate-recovery-code

Regenerate the account's recovery code. Requires re-proving the account's live second factor (TOTP or WebAuthn) first -- a valid session cookie alone is not enough, since that would let a stolen session cookie silently overwrite the account's recovery path.

The recovery code itself is generated and hashed **client-side** (pure crypto, no server secret involved) so the new hash and the TOTP secret re-encrypted under it are submitted together, atomically, in one request -- there is no separate follow-up call. (An earlier two-step design, where the server generated the code and the client uploaded the re-encrypted TOTP secret in a second call, could permanently break recovery for an account if that second call never arrived; this route no longer exists.)

**Rate limit:** 3 requests per minute per IP.

**Authentication:** Session cookie required; the authenticated session's `relayId` must match the `relayId` in the body.

**Request body:**

```json
{
  "relayId": "a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6",
  "recoveryCodeHash": "32-128 hex chars -- hash of the new client-generated recovery code",
  "encryptedTOTPSecretForRecovery": "1-512 hex chars -- the TOTP secret re-encrypted under the new recovery code",
  "totpCode": "789012 -- required if the account uses TOTP",
  "webauthnAssertion": "required if the account uses WebAuthn"
}
```

| Field                            | Type   | Required                     |
|-----------------------------------|--------|---------------------------------|
| `relayId`                        | string | yes                             |
| `recoveryCodeHash`                | string | yes                             |
| `encryptedTOTPSecretForRecovery`  | string | yes                             |
| `totpCode`                        | string | if the account uses TOTP       |
| `webauthnAssertion`               | object | if the account uses WebAuthn   |

**Server behavior:**

1. Requires a valid session, owned by the same `relayId` being modified.
2. Rejects with `423` if the account is currently locked out (shares the same lockout as `/api/auth/login`).
3. Verifies the live TOTP code or WebAuthn assertion.
4. Atomically stores the new `recoveryCodeHash` and `encryptedTOTPSecretForRecovery`.
5. Revokes every other live session for the account (a captured old recovery code could have come from a compromised device that also stole a session cookie), then re-mints a fresh session for this response so the caller isn't logged out by their own action.

**Success response (200):**

```json
{
  "success": true
}
```

**Errors:**

| Code               | Status | Condition                                          |
|--------------------|--------|-------------------------------------------------------|
| `VALIDATION_ERROR` | 400    | Missing/malformed fields, or no second factor provided |
| `FORBIDDEN`        | 403    | Session `relayId` does not match the body's `relayId` |
| `NOT_FOUND`        | 404    | User not found                                       |
| `UNAUTHORIZED`     | 401    | Invalid credentials (wrong TOTP/WebAuthn)             |
| `UNAUTHORIZED`     | 423    | Account temporarily locked from repeated failed attempts |

---

### GET /api/profile/lookup

Look up a user's public profile by username or relay ID. Lazily assigns an avatar to legacy accounts that predate the avatar feature.

**Rate limit:** None (application-level).

**Authentication:** None.

**Query parameters:**

| Parameter  | Type   | Required           | Description                    |
|------------|--------|--------------------|--------------------------------|
| `username` | string | one of the two     | Case-insensitive username      |
| `relayId`  | string | one of the two     | Relay ID (`XXXXXXXX`)       |

At least one of `username` or `relayId` must be provided. If both are provided, `username` takes precedence.

**Success response (200):**

```json
{
  "relayId": "a1b2c3d4",
  "displayName": "Alice",
  "username": "alice",
  "bio": "Hello, world!",
  "isUnlisted": false,
  "avatarEmoji": "...",
  "avatarColor": "#RRGGBB"
}
```

**Errors:**

| Code               | Status | Condition                                |
|--------------------|--------|------------------------------------------|
| `VALIDATION_ERROR` | 400    | Missing both `username` and `relayId`    |
| `VALIDATION_ERROR` | 400    | Empty username                           |
| `VALIDATION_ERROR` | 400    | Invalid relay ID parameter               |
| `NOT_FOUND`        | 404    | User not found                           |

---

### POST /api/profile/update

Update the authenticated user's profile. Requires a valid session cookie.

**Rate limit:** None (application-level).

**Authentication:** Required. The `relay_session` cookie must be present and valid. The session's `relayId` must match the `relayId` in the request body.

**Request body:**

```json
{
  "relayId": "a1b2c3d4",
  "displayName": "Alice",
  "username": "alice",
  "bio": "Updated bio",
  "isUnlisted": false
}
```

| Field         | Type    | Required | Description                                |
|---------------|---------|----------|--------------------------------------------|
| `relayId`     | string  | yes      | Must match the session's relay ID          |
| `displayName` | string  | no       | Display name                               |
| `username`    | string  | no       | 1-20 chars, `[a-z0-9_]`, case-insensitive |
| `bio`         | string  | no       | Free-text bio                              |
| `isUnlisted`  | boolean | no       | Whether the profile is hidden from search  |

Note: `avatarEmoji` and `avatarColor` are intentionally excluded -- they are immutable after signup.

**Username validation:**

- Must match `^[a-z0-9_]{1,20}$`.
- Must not already be taken by another user.

**Success response (200):**

```json
{
  "success": true,
  "profile": {
    "relayId": "a1b2c3d4",
    "displayName": "Alice",
    "username": "alice",
    "bio": "Updated bio",
    "isUnlisted": false
  }
}
```

**Errors:**

| Code               | Status | Condition                                     |
|--------------------|--------|-----------------------------------------------|
| (none)             | 401    | Missing or invalid session cookie             |
| `VALIDATION_ERROR` | 400    | Missing `relayId`                             |
| `FORBIDDEN`        | 403    | Session relay ID does not match request       |
| `NOT_FOUND`        | 404    | User not found                                |
| `VALIDATION_ERROR` | 400    | Invalid username format                       |
| `CONFLICT`         | 409    | Username already taken by another user        |
