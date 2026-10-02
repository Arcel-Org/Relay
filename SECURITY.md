# Security Policy

Relay is an end-to-end encrypted messenger. Security is the product, so we
treat reports seriously and respond accordingly.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.** Please
report privately to the maintainers at:

- **Email:** `security@arcel.org`
- **PGP:** (to be published — see below)

If you prefer, you may also open a *draft* security advisory on the repository
(GitHub: Security → Advisories → New draft advisory), which is only visible to
maintainers.

You should receive an acknowledgement within 48 hours. If you don't, escalate
by reaching out again — we would rather be over-contacted than miss a report.

### What we ask

- Give us a reasonable window to fix and release before you disclose publicly
  (90 days is our target).
- Include, when you have them: a minimal reproduction, the affected
  versions, and the impact you observed.
- We will credit you in the advisory unless you prefer to stay anonymous.

## Scope

In scope — anything that undermines the product's stated security properties:

- Breaks or weakens end-to-end encryption (see `docs/PROTOCOL.md` /
  `docs/CRYPTO_REVIEW_RESYNC_AND_GROUP_KEYS.md` for the design).
- Leaks message content, keys, or account identity to the server or a third
  party (the server is **not** a trusted party; "server can read X" is a
  vulnerability, not a feature).
- Authentication / session / 2FA bypass, key-theft, or PIN bypass.
- Server-side issues in `server/` or the Next.js API routes: auth bypass,
  rate-limit bypass, data exposure, privilege escalation, abuse-report or
  warrant-canary manipulation.
- Client-side issues in `app/` / `components/` / `lib/`: XSS, CSRF, injection
  into the encrypted store, or failure of local-store encryption.

Out of scope (by design, documented in the codebase):

- Physical compromise of a user's device.
- Malware already running as the user on their own machine.
- A compromised server deliberately lying about relay/forwarding behaviour —
  E2E encryption protects message content, not delivery metadata.
- Features marked as explicitly absent (e.g. no push notifications, no
  native apps) are not vulnerabilities.

## Process

1. Triage and confirmation of impact.
2. Fix + regression test, shipped in the next release.
3. Public advisory with credit once users have had a chance to update.

## Security design

Relay's claims are backed by code, and the code is open for review:

- Hybrid X25519 + ML-KEM768 key agreement, per-message key rotation,
  ChaCha20-Poly1305 AEAD, HKDF-SHA256 — see `README.md` §Security.
- The relay server holds messages for at most 20 minutes then purges; there
  is no server-side logging of message contents.
- All local persistence is encrypted; private keys are never stored in
  plaintext.

We recommend running `npm audit --omit=dev` and `docker compose build`
against the latest tag, and pinning the digest-pinned base image in the
Dockerfile when you upgrade.
