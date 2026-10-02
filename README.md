<div align="center">

# Relay

**Private, end-to-end encrypted messaging for high-trust networks.**

Relay is a self-hosted messenger with post-quantum hybrid encryption. Every
message gets a unique ephemeral key, the relay holds nothing for longer than
20 minutes, and the only persistent copy is the encrypted store on your own
device. No cloud history. No social graph. No ads. No tracking.

<!--
  After publishing, add repo-dependent badges here, e.g.:
  [![CI](https://img.shields.io/github/actions/workflow/status/<owner>/<repo>/ci.yml?branch=master)](...)
  [![License: MIT / AGPL-3.0](https://img.shields.io/github/license/<owner>/<repo>)](...)
-->
[![Node](https://img.shields.io/badge/Node.js-20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![License](https://img.shields.io/badge/license-MIT%20%2F%20AGPL--3.0-blue)](#license)

</div>

---

## Why Relay

Most messengers make a trade you can't verify: *our servers are secure — trust
us.* Relay inverts that. The whole stack is open source, the cryptography is
documented, and the design gives the operator as little to abuse as physics
allows:

- **End-to-end encrypted** — messages are encrypted before they leave your
  device. The relay server is a dumb pipe: it forwards ciphertext and
  eventually deletes it.
- **Post-quantum from day one** — hybrid X25519 + ML-KEM768 key agreement
  defends against "harvest now, decrypt later."
- **No cloud history** — the relay purges messages after 20 minutes. The only
  persistent copy lives in your encrypted local store.
- **Self-hostable** — one command (`./scripts/setup.sh --up`) brings up the
  web app and relay server. You can run the whole product on hardware you
  control.
- **Verifiable** — every key, every format, every retention decision is in
  this repository. Security isn't a feature you're asked to believe in.

## Features

- **Hybrid post-quantum end-to-end encryption** — X25519 + ML-KEM768 key
  agreement with per-message key rotation, ChaCha20-Poly1305 (AEAD)
- **20-minute TTL** — relay-held messages auto-delete; local history persists
  encrypted under your private key
- **Relay ID identity** — a cryptographic identifier derived from your public
  key (`abcd-1234-...-ef90`, self-certifying, no server trusted to vouch for
  it), optionally paired with a claimed `@username`
- **Two-factor login** — TOTP + PIN; TOTP secrets stored encrypted at rest,
  recovery via BIP39 mnemonic
- **Passkeys / WebAuthn** — hardware-key login and 2FA
- **Encrypted local store** — IndexedDB, all values encrypted under an
  HKDF-derived key
- **Device sync** — QR-based session transfer; no server-held keys
- **Groups** — end-to-end encrypted group messaging with a public directory
- **Calls** — WebRTC voice/video with ephemeral TURN credentials
- **Vault** — encrypted notes and 2FA accounts locked behind your PIN
- **Privacy controls** — disappearing messages, read receipts, reactions,
  message editing, presence opt-out — all encrypted end to end
- **Compression before encryption** — client-side zlib with a shared chat
  dictionary shrinks payloads so no server sees them
- **Zero data retention** — minimal metadata, no message logging, no social
  graph

## Quickstart (Docker — recommended)

Relay ships as a Docker Compose deployment: the web app and the WebSocket
relay server run as two services from one `docker-compose.yml`, plus an
optional TURN server for call media relay.

**Requirements:** Docker **and Docker Compose v2** (the `docker compose`
plugin — not the legacy standalone `docker-compose`). 2 GB free RAM is plenty.

```bash
# 1. Clone
git clone <your-public-repo-url> relay
cd relay

# 2. One-command setup — generates secrets with openssl, asks for your
#    public URL, writes .env, and boots the stack
./scripts/setup.sh --up

#    Or explicitly:
#    ./scripts/setup.sh --url https://relay.example.com --up
```

What happens:

1. `setup.sh` checks for Docker + openssl.
2. It generates `SESSION_SECRET` and `TOTP_ENCRYPTION_KEY` with
   `openssl rand -hex 32` and asks for your public URL.
3. From that one URL it derives everything the stack needs:
   `NEXT_PUBLIC_RELAY_URL` (`wss://`), `WS_ALLOWED_ORIGINS`, and the
   `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` passkey values.
4. It writes `.env` **without ever overwriting an existing secret** —
   re-running it is safe.
5. `docker compose up -d --build` builds and starts **app** (`:3000`) and
   **relay** (`:8080`).

Verify it's live:

```bash
docker compose ps          # both should show "healthy"
curl http://127.0.0.1:3000/api/status
# {"ok":true,"relayReachable":true,"dbReachable":true,...}
```

Then put a TLS-terminating reverse proxy (nginx, Caddy, or Cloudflare) in
front — the app and relay bind to loopback only, and the `wss://` relay URL
needs real HTTPS to work in a browser. If you're behind a proxy, set
`TRUST_PROXY_HEADERS=true` in `.env` and rebuild. The full production guide
(TLS, backups, updates, TURN for calls, multi-region) is in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `docker compose ps` shows `unhealthy` or `starting` for a while | Give the app up to ~75s (it waits for the relay to be healthy before passing its own healthcheck). |
| Healthcheck uses `127.0.0.1`, never `localhost` | Inside the container `localhost` resolves to IPv6 `::1` first; the IPv4-only server refuses it. This is already handled in the compose file. |
| Fresh volume errors like `SQLITE_CANTOPEN` (err 14) | The app runs as a non-root user; an empty named volume is root-owned. The image ships a marker that fixes ownership on first mount — if you mount your own pre-existing volume, ensure it's writable by UID 1000. |
| `WS_ALLOWED_ORIGINS` missing | The relay refuses to start without it. `setup.sh` sets it from your URL; if writing `.env` by hand, it must list your production origin(s). |
| Dev `.env` values leak into the container | `PORT`, `RELAY_PORT`, and `RELAY_HOST` are pinned inside compose so a dev `.env` can't silently break the container. |

## How it works

```
        Browser (app)                          Your server (Docker compose)
┌──────────────────────────┐   HTTPS/WSS    ┌────────────────────────────────┐
│  Next.js web app         │  ────────────▶ │  reverse proxy (nginx/Caddy)   │
│  • key generation        │                │  ─── HTTPS termination ────────│
│  • encrypt/decrypt       │                │  ┌────────────┐   ┌─────────┐  │
│  • local encrypted store │  WSS (relay)   │  │  app :3000 │   │ relay   │  │
│    (IndexedDB, HKDF)     │  ────────────▶ │  │  Next.js   │   │ :8080   │  │
└──────────────────────────┘                │  │  server    │   │ WebSocket│  │
                                            │  └─────┬──────┘   └────┬────┘  │
                                            │        └──────┬─────────┘      │
                                            │               ▼               │
                                            │        ┌──────────────┐       │
                                            │        │ SQLite       │       │
                                            │        │ (sessions,   │       │
                                            │        │  keys, dirs) │       │
                                            │        └──────────────┘       │
                                            └────────────────────────────────┘
```

- Messages are encrypted in the browser and the relay forwards ciphertext —
  it never sees plaintext and cannot read history.
- The relay holds a message for **at most 20 minutes**, then purges it.
- Sessions, WebAuthn credentials, and the group directory live in SQLite;
  message history lives only in each participant's encrypted local store.
- Key exchange is **hybrid X25519 + ML-KEM768**, combined with HKDF-SHA256 —
  breaking the session requires breaking *both* a classical and a
  post-quantum algorithm. See [Security](#security) for the details.

## Security

### Post-quantum hybrid key exchange

Relay's key agreement is a **hybrid of classical and post-quantum
cryptography**, protecting against "harvest now, decrypt later" attacks:

- **Classical**: X25519 elliptic-curve Diffie–Hellman (ECDH)
- **Post-quantum**: ML-KEM768 (NIST FIPS 203)
- **Combination**: both shared secrets are mixed with HKDF-SHA256 into a
  single session key
- **Why hybrid**: quantum resistance *and* classical fallback — breaking the
  session requires breaking both algorithms; a flaw in either alone isn't
  enough. Clients without PQ keys fall back to X25519.

References: [NIST FIPS 203 (ML-KEM)](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.203.pdf),
[Signal PQXDH](https://signal.org/docs/specifications/pqxdh/),
[Apple PQ3](https://security.apple.com/pq3/).

### What the server never sees

- **Plaintext** — payloads are ChaCha20-Poly1305 AEAD, encrypted with
  per-message ephemeral keys
- **Your private key** — stored only as an HKDF-derived ciphertext under your
  PIN, never in plaintext, never sent
- **Message history** — relay TTL is 20 minutes; the only persistent copy is
  your encrypted local store
- **TOTP secrets** — encrypted at rest with a server-only key; recovery codes
  stored as BLAKE3 hashes

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the wire protocol and
[`docs/API.md`](docs/API.md) for the HTTP API. Vulnerabilities: see
[`SECURITY.md`](SECURITY.md).

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS — 9 selectable themes (default: crimson) |
| Cryptography | @noble/curves (X25519), @noble/post-quantum (ML-KEM768), @noble/ciphers (ChaCha20-Poly1305), @noble/hashes (HKDF-SHA256) |
| Auth | TOTP (otpauth), BIP39 mnemonics, WebAuthn/passkeys (@simplewebauthn) |
| Local storage | IndexedDB (idb-keyval) — all values encrypted |
| Server storage | @libsql/client (SQLite) — sessions, WebAuthn credentials, group directory |
| WebSocket | ws — relay server for message forwarding |
| Calls | WebRTC (voice/video) with ephemeral TURN credentials |
| State | Zustand · Animations · Framer Motion |

## Project structure

```
relay/
├── app/                    # Next.js app: pages, auth flows, legal, security, vault
│   ├── api/                #   API routes: auth, groups, profile, TURN, status, admin
│   ├── app/                #   The messenger (account, settings, admin)
│   ├── auth/               #   Signup / login / recovery
│   ├── setup/              #   Onboarding steps
│   └── legal/, security/   #   Transparency pages (canary, privacy, terms)
├── components/             # 40+ UI components
├── lib/
│   ├── crypto/             # Identity, key agreement, encryption, recovery
│   ├── messaging/          # Send/receive, key exchange, disappearing messages
│   ├── db/                 # IndexedDB (client) + SQLite (server)
│   ├── vault/              # Encrypted notes + 2FA, device sync
│   ├── calls/, webrtc/     # WebRTC signaling and negotiation
│   └── security/, platform/, ...
├── server/
│   ├── relay-node.ts       # Relay server (WebSocket, Node)
│   └── relay-schemas.ts    # Wire message schemas
├── scripts/                # setup.sh, update.sh, backup.sh, load-test-relay.ts
├── docs/                   # DEPLOY, PROTOCOL, API, crypto review
├── docker-compose.yml      # app + relay (+ optional TURN)
├── Dockerfile
└── .github/ .gitea/        # CI workflows (lint, type-check, test, build, secret scan)
```

## Development

```bash
npm install
npm run dev        # starts the relay (:8080) and the Next.js app (:3000) together
```

Or separately: `npm run dev:next` (frontend) and `npm run relay` (relay
server).

```bash
npm run lint       # eslint
npm test           # unit tests (vitest)
npm run build      # production build (app)
npm run build:relay
npm run test:e2e   # Playwright end-to-end (builds with a test relay first)
```

## Roadmap

Relay is a working product, not a prototype — the backend (WebSocket relay,
auth API, WebRTC calling, group directory, SQLite persistence) is live and
tested. Remaining work is tracked in [`FEATURES.md`](FEATURES.md):

- Link previews (Open Graph fetch)
- Message scheduling
- View-once media
- Persistent per-conversation drafts
- Desktop keyboard shortcuts

## License

Dual-licensed, matching where each part runs:

- **Client — the Next.js web app** (`app/`, `components/`, `lib/`): [MIT](LICENSE)
- **Relay server** (`server/`): [AGPL-3.0](server/LICENSE)

You may self-host and run the whole stack for any purpose. If you modify and
**operate the relay server as a network service**, AGPL requires you to
publish your modifications. The web client is freely usable under MIT.

## Contributing

Open an issue for bugs or questions, and see
[`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR. Found a security
issue? Please read [`SECURITY.md`](SECURITY.md) and disclose it privately to
`security@arcel.org` rather than in a public issue.
