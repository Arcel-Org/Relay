# Arcel Deployment Guide

---

## Quick start (recommended)

The one-command path — generates secrets with `openssl`, asks for your public
URL, writes `.env`, and boots the stack:

```bash
./scripts/setup.sh --up          # or: setup.sh --url https://relay.example.com --up
```

See `README.md` §Running with Docker for the manual (step-by-step) path.

---

## 1. Prerequisites

- **Node.js 20** (LTS) -- the Dockerfile uses `node:20-alpine`
- **npm** (ships with Node.js)
- **ts-node** (dev dependency, used to run the relay server from TypeScript)
- **Docker and Docker Compose v2** (for containerized deployment — `setup.sh`
  checks for it and prints install instructions if missing)

---

## 2. Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Relay Server

| Variable                      | Default                   | Description                                                                 |
|-------------------------------|---------------------------|-----------------------------------------------------------------------------|
| `NEXT_PUBLIC_RELAY_URL`       | `ws://localhost:8080`     | WebSocket URL the frontend uses to connect to the relay. Use `wss://` in production. **In Docker, this is baked into the client bundle at `docker compose build` time, not read at container runtime** — Next.js inlines every `NEXT_PUBLIC_*` var via static substitution. `docker-compose.yml` passes it through as a build arg for exactly this reason. Set the real public `wss://` URL in `.env` *before* your first build, and re-run `docker compose build` (not just `restart`/`up`) any time you change it — a plain restart will keep serving the old baked-in value. |
| `RELAY_PORT`                  | `8080`                    | Port the relay WebSocket server listens on. In Docker, the relay reads `PORT` instead. |
| `PORT`                        | `3000` (app) / `8080` (relay) | Generic port variable. Used by both the Next.js app and the relay.        |
| `MESSAGE_TTL_MINUTES`         | `20`                      | How long undelivered messages are held in memory before being purged.       |
| `MAX_WS_CONNECTIONS`          | `10000`                   | Max concurrent WebSocket connections before new ones are rejected with "Server at capacity". |
| `RELAY_DEBUG_LOGS`            | `false` in production     | Enables verbose debug logs, including sender→recipient relayId pairs for every relayed message. Leave off in production — this is the social graph. |
| `WS_ALLOWED_ORIGINS`          | (unset — relay refuses to start) | Comma-separated origins allowed to open a WebSocket connection to the relay. **Must be set outside development/test** — the relay throws at startup otherwise, to prevent any other site opening cross-origin WebSocket connections to it. Example: `https://relay.arcel.org`. |

### TURN Server (Media Relay)

TURN is **optional**. Without it, calls fall back to public STUN + direct
peer-to-peer — functional, but each caller's real IP address is visible to
the other via ICE candidates. Enabling TURN routes all call media through it
instead, so neither party ever sees the other's IP.

Bring up the bundled coturn service with `docker compose -f docker-compose.yml -f docker-compose.turn.yml up -d`
(not started by the default `docker compose up`, since it requires a secret
most self-hosters won't have set yet). Unlike a prior design, there is no
long-lived client-exposed TURN credential — the app mints a fresh,
6-hour-lived HMAC credential per user via `app/api/turn-credentials`, using
`TURN_SECRET` (coturn's `--use-auth-secret` mechanism). Nothing about the
credential is stored server-side per-issue; coturn verifies the HMAC itself.

| Variable          | Default                          | Description                                                               |
|-------------------|-----------------------------------|---------------------------------------------------------------------------|
| `TURN_SECRET`      | (unset — TURN disabled)          | Shared HMAC secret between the app and coturn. Generate with `openssl rand -hex 32`. Must match on both sides — the `-f docker-compose.turn.yml` setup wires this automatically from one value. |
| `TURN_PUBLIC_HOST` | request `Host` header             | Hostname clients should connect to for TURN. Override if coturn isn't reachable at the same host as the app. |

### Session and Security

| Variable                      | Default                                          | Description                                              |
|-------------------------------|--------------------------------------------------|----------------------------------------------------------|
| `SESSION_SECRET`              | dev fallback (unsafe)                            | HMAC-SHA256 signing key for short-lived (15 min) WS connection tickets. **Must be at least 32 characters in production.** Generate with `openssl rand -hex 32`. The login session cookie itself is a random opaque token verified against a server-side session store, not an HMAC signature — a leaked `SESSION_SECRET` alone can no longer forge a login session for any relayId. |
| `SESSION_STORE_DIR`           | `<cwd>/.data`                                     | Directory where session records (`lib/db/session-store.ts`) are persisted. Same volume as the user store in the Docker Compose setup below. |
| `TOTP_ENCRYPTION_KEY`         | dev fallback (unsafe)                            | AES-256-GCM key encrypting the server-side TOTP secret at rest. **Must be exactly 64 hex characters (32 bytes) in production.** Generate with `openssl rand -hex 32`. Store separately from DB backups — a `users.json` leak alone must not be enough to forge a login. |
| `WEBAUTHN_RP_ID`              | `localhost`                                      | Bare domain (no scheme/port) for hardware-key (FIDO2/WebAuthn) support, e.g. `relay.arcel.org`. **Must be set in production** — WebAuthn is origin-bound by the browser itself, so leaving this at the dev default silently breaks all hardware-key registration/login once deployed. |
| `WEBAUTHN_ORIGIN`             | `http://localhost:3000`                          | Exact scheme+host+port the app is served from, e.g. `https://relay.arcel.org`. Must match what users' browsers actually load. |
| `NODE_ENV`                    | (unset)                                          | Set to `production` to enable secure cookies and enforce `SESSION_SECRET`/`TOTP_ENCRYPTION_KEY`. |

### Storage, Data Retention, and Admin Access

| Variable                        | Default          | Description |
|----------------------------------|------------------|-------------|
| `DATA_DIR`                       | `<cwd>/.data`    | Directory for the main SQLite database (`relay.db` — users, groups, abuse reports, warrant-canary confirmations and legal-request records) and the `canary-uploads/` subdirectory holding redacted legal-request PDFs (see below). This is the directory your backup needs to cover — see §5's Data Persistence & Backups and §6. |
| `DATABASE_URL` / `DATABASE_AUTH_TOKEN` | (unset — embedded file mode) | Point the database at a remote/embedded-replica primary (e.g. Turso) instead of the local file under `DATA_DIR`. Only needed if scaling beyond a single instance — see §5's "Scaling: single instance only, by design". |
| `ADMIN_RELAY_IDS`                 | (unset — admin surface unreachable) | Comma-separated Relay ID(s) allowed to reach the abuse-report admin dashboard (`/app/admin`), the warrant-canary admin dashboard (`/app/admin/canary`), and their APIs (`/api/admin/*`). Fails closed — this must be an operator's own Relay ID, not a username or display name. |
| `MAX_INACTIVE_DAYS` / `NEXT_PUBLIC_MAX_INACTIVE_DAYS` | (unset — disabled) | Enables a daily sweep (`lib/db/account-retention-scheduler.ts`) that deletes accounts inactive longer than this many days. Off by default; must be explicitly opted into. |
| `COVER_TRAFFIC_ENABLED`           | `true`           | The relay sends small dummy frames on a random cadence to connected-but-idle clients (dropped client-side before reaching app code) so traffic volume/timing alone can't distinguish "actively chatting" from "idle but connected". Set to `false` to disable, e.g. to reduce bandwidth on a constrained deployment. |

**Warrant canary / legal-request transparency**: `/app/admin/canary` (gated by `ADMIN_RELAY_IDS` above) lets an operator confirm the public `/legal/canary` page's statements are still true (stamping an exact timestamp) and publish redacted copies of any legal request received, shown on `/legal/transparency`. Both the confirmation log and legal-request records live in `relay.db`; uploaded PDFs live under `DATA_DIR/canary-uploads/` — both are already covered by the whole-directory backup described in §5 and §6, no separate backup step needed.

### Error Monitoring (Optional)

| Variable                      | Default   | Description                                                |
|-------------------------------|-----------|--------------------------------------------------------------|
| `SENTRY_DSN`                   | (unset)   | Opt-in server-side crash reporting via Sentry (or a self-hosted, Sentry-protocol-compatible alternative like GlitchTip — just point this at it). **Unset by default, and behavior is unchanged unless you set it.** |

Scoped deliberately to server-side only — the Next.js API routes' Node runtime (`lib/platform/error-monitoring.ts`, wired through `withErrorHandler`'s catch-all and `instrumentation.ts`) and the standalone WS relay process (`server/error-monitoring.ts`, wired through its `uncaughtException`/`unhandledRejection` handlers). There is **no client-side/browser error reporting** — this app has no accounts tying identity to email/phone, and end users' browsers must never phone home to a third party. Setting `SENTRY_DSN` only gives the *operator* visibility into their *own* server's exceptions.

`sendDefaultPii` is explicitly disabled and a `beforeSend` hook strips cookies, headers, and request bodies before an event would ever be sent — session tokens and API payloads (which can include PIN-derived material or encrypted key blobs) never leave the process. Tracing/performance sampling is off (`tracesSampleRate: 0`) — this is error reporting only, not a source of extra telemetry to review.

---

## 3. Running Locally (Development)

### Quick Start

```bash
npm install
npm run dev
```

This runs `dev-server.sh`, which:

1. Kills any stale process on port 8080.
2. Starts the relay server (`ts-node server/relay-node.ts`) in the background on port 8080.
3. Starts the custom Next.js dev server (`node server.js`) on port 3000 with a WebSocket proxy that tunnels relay traffic from `:3000` to `:8080`.

Both servers are stopped together with `Ctrl+C`.

### Running Components Individually

```bash
# Relay only
npm run dev:relay

# Next.js only (no WebSocket proxy)
npm run dev:next

# Relay standalone
npm run relay
```

### Accessing from Other Devices on LAN

The dev server binds to `0.0.0.0`. For microphone/camera access (required for calls), browsers require HTTPS. The server automatically enables HTTPS when TLS certificates are present:

```bash
mkdir -p dev-certs
openssl req -x509 -newkey rsa:2048 -keyout dev-certs/key.pem \
  -out dev-certs/cert.pem -days 365 -nodes -subj '/CN=localhost'
```

When `dev-certs/key.pem` and `dev-certs/cert.pem` exist, `server.js` starts in HTTPS mode. Accept the self-signed certificate warning in your browser once.

---

## 4. Docker Deployment

### Build

```bash
docker compose build
```

The Dockerfile uses a four-stage build:

1. **deps** -- Installs all dependencies (`npm ci`) for the Next.js build.
2. **prod-deps** -- Production-only install (`npm ci --omit=dev`) for the relay's own runtime `node_modules` (e.g. `ws`), since the relay isn't traced into Next's standalone output.
3. **build** -- Compiles the Next.js application (`npm run build`) and the relay server to plain JS (`npm run build:relay`) -- the runtime image has no `ts-node`/`typescript`, so the relay ships compiled, not run via `ts-node`.
4. **runtime** -- Slim `node:20-alpine` image with only production artifacts: the
   Next standalone output (its own `server.js` is the entrypoint). The repo's
   custom `server.js` (with the same-origin WS proxy) is deliberately NOT
   included — it needs the full `next` package (incl. `next/dist/compiled/webpack`)
   that standalone output doesn't ship, so including it crashed the container on
   boot. In the container, browsers reach the relay directly via the baked-in
   `NEXT_PUBLIC_RELAY_URL` instead. Two further container-only fixes are baked in:
   `ENV HOSTNAME=0.0.0.0` (Next's standalone server binds to `HOSTNAME`, which
   Docker otherwise injects as the container-id — the app would refuse the
   loopback healthcheck probe) and a relay-owned marker file in `/app/.data` so a
   fresh named volume initialises writable by the non-root `relay` user (an empty
   volume comes up root-owned and the relay user then can't create `relay.db`).

### Run

```bash
docker compose up -d --build
```

`--build` matters here, not just on first run — `NEXT_PUBLIC_RELAY_URL` (and any other `NEXT_PUBLIC_*` var) is baked into the client bundle at build time (see that variable's row above), so a plain `docker compose up -d` after editing `.env` will keep serving whatever was baked into the last-built image.

This starts two services:

| Service | Port | Command                                          | Description          |
|---------|------|--------------------------------------------------|----------------------|
| `app`   | 3000 | `node server.js` (Dockerfile `CMD`)             | Next.js frontend + WebSocket-upgrade proxy to `relay` |
| `relay` | 8080 | `node dist-server/server/relay-node.js`         | WebSocket relay, compiled ahead of time -- the runtime image has no `ts-node`/`typescript` |

Add `-f docker-compose.turn.yml` to also start the optional coturn service (see [TURN Server](#turn-server-media-relay) above):

```bash
docker compose -f docker-compose.yml -f docker-compose.turn.yml up -d
```

### Environment Variables in Compose

Both services load a `.env` file (`env_file: .env` in `docker-compose.yml`) —
copy `.env.example` to `.env` and fill in real values rather than editing the
compose file directly:

```bash
cp .env.example .env
# edit .env: SESSION_SECRET, TOTP_ENCRYPTION_KEY, TURN_SECRET (if using TURN), etc.
```

### Data Persistence

Both services share a named Docker volume (`app-data`) mounted at `/app/.data`. This is where `.data/relay.db` (libSQL/SQLite, WAL mode) lives — along with its `-wal`/`-shm` sidecar files, which must be backed up together with the main `.db` file for a consistent snapshot.

**Automated, steady-state backups**: `scripts/backup.sh` tars the whole `app-data` volume (via a read-only bind mount into a throwaway `alpine` container — no `sqlite3` needed on the host, and safe to run while the app is live) to `./backups/app-data-<timestamp>.tar.gz`, keeping the 14 most recent by default (`RELAY_BACKUP_RETAIN` to override). Previously the only backup that ever happened was the one `update.sh` takes right before a deploy — on an ordinary day with no deploy, losing the host disk meant no recovery at all. Schedule it with either:
- **Cron**: `0 3 * * * cd /path/to/Relay && ./scripts/backup.sh >> /var/log/relay-backup.log 2>&1`
- **systemd timer**: copy `deploy/relay-backup.service` + `deploy/relay-backup.timer` to `/etc/systemd/system/`, set `WorkingDirectory` in the service file to your repo root, then `systemctl enable --now relay-backup.timer`.

Ship the resulting `.tar.gz` files off-box (rsync/rclone to another host or object storage) — a backup that only ever lives on the same disk it's protecting against doesn't survive that disk failing.

**Further options, if you outgrow this:**
- **Litestream**: streams WAL changes continuously to S3/GCS/etc. for near-zero-RPO backups without stopping the server — worth adding once this holds real user data at scale.
- **`DATABASE_URL`/`DATABASE_AUTH_TOKEN`**: if you outgrow a single server, point these at a Turso (libSQL-hosted) database instead of a local file — no code change required, see `lib/db/sqlite-client.ts`.

One-time migration from the old JSON file store: `npm run migrate:sqlite` (reads `.data/users.json`/`.data/public-groups.json` if present, upserts into `.data/relay.db`, renames the JSON files to `*.migrated-backup`).

### Health Checks

Both services have built-in health checks:

| Service | Check                                                                        | Interval | Timeout | Retries | Start Period |
|---------|------------------------------------------------------------------------------|----------|---------|---------|--------------|
| `app`   | `wget -qO- http://127.0.0.1:3000/api/status | grep -q '"ok":true'`          | 30s      | 10s     | 3       | 15s          |
| `relay` | `nc -z 127.0.0.1 8080`                                                       | 30s      | 10s     | 3       | 10s          |

`127.0.0.1`, deliberately not `localhost`: inside the container `localhost`
resolves to `::1` first and the IPv4-only Next server refuses it. The app check
uses `/api/status` (not `/api/health`) so a broken DB or unreachable relay flips
it — `/api/health` only proves the process is up.

The `app` service depends on the `relay` service being healthy before starting.

### Verify the account-retention scheduler actually started

`instrumentation.ts` starts the account-retention scheduler
(`lib/db/account-retention-scheduler.ts`) via Next's `register()` hook. This
app uses a custom `server.js` rather than the plain `next start` CLI, and
whether Next still invokes `register()` under a custom server programmatically
calling `next()` varies across versions and hasn't been confirmed live against
this exact setup. **After your first deploy**, confirm it actually ran:

```bash
docker compose logs app | grep account-retention
```

You should see exactly one `[account-retention] enabled` (or `disabled`) line
per container start — not zero (hook never fired) and not more than one
(double-invocation). If it's missing, accounts past their retention window
will silently never get cleaned up.

### Scaling: single instance only, by design

`docker-compose.yml` runs exactly one `app` container and one `relay`
container. Do not scale either service to multiple replicas (`docker compose
up --scale relay=2`, a load balancer fronting two `relay` containers, running
`relay` in two regions, etc.) without changing the code first. Several things
that matter for correctness and security are process-local in-memory state,
not a shared store:

- `lib/security/rate-limit.ts` — the request-count buckets are a plain
  in-process `Map`. With two `app` replicas behind a load balancer, an
  attacker gets roughly 2x (or Nx) the intended request budget per window,
  since each replica enforces its limit independently against a fraction of
  the traffic.
- `server/relay-node.ts` — the connected-client registry (`clients`), pending
  offline-message queue (`pendingMessages`), and message-dedup set
  (`dedupKeys`) are all in-process `Map`s. Two `relay` replicas would each
  see only the WebSocket connections that happened to land on them, so a
  sender and recipient connected to different replicas could never reach
  each other, and dedup would stop catching duplicates delivered through the
  other replica.

None of this needs fixing for a normal single-VPS deployment — it's the
correct, simpler design when there's only one process. It only becomes a
real constraint if you later need horizontal scaling (multi-region for
latency, or redundancy across hosts): at that point both the rate limiter
and the relay's connection/dedup state need to move to a shared external
store (Redis is the natural fit for both) before adding a second replica of
either service. Until then, vertical scaling (a bigger VPS) is the only
supported way to add capacity.

---

## 5. PM2 Deployment (Bare Metal)

`ecosystem.config.js` is checked in at the repo root (`relay-app` runs `npm start`, `relay-relay` runs `npm run relay`) — no need to hand-author one.

### Install PM2

```bash
npm install -g pm2
```

### Raise the open-file-descriptor limit first

Each open WebSocket connection holds at least one file descriptor. `MAX_WS_CONNECTIONS` (default 10000, see the table above) is a real ceiling only if the OS actually allows that many open files for the process — most distros default a login shell to 1024, which PM2 (and everything it spawns) inherits. Past that limit, new connections fail with a silent `EMFILE` instead of the relay's intended, visible "Server at capacity" rejection.

To get a real data point on whether your actual deployment's ulimit is enough before real users hit it, `scripts/load-test-relay.ts` opens many concurrent WebSocket connections against a running relay and reports how many actually succeeded vs. failed, plus how many were rejected with "Server at capacity" (WS close code 1013) — see the script's own header comment for exactly what it does and doesn't test. Run it against a real deployment, not just local dev, since ulimit is a property of the OS process the relay actually runs under:

```bash
RELAY_URL=wss://relay.yourdomain.com CONNECTIONS=5000 npm run load-test:relay
```

Raise it for the current shell before starting PM2:

```bash
ulimit -n 65536
```

That only lasts for the current shell session. To make it stick across reboots/relogins, add to `/etc/security/limits.conf` (requires `pam_limits` to be enabled, the default on most distros):

```
your_deploy_user soft nofile 65536
your_deploy_user hard nofile 65536
```

Log out and back in (or reboot) for the limits.conf change to take effect, then confirm before starting PM2:

```bash
ulimit -n   # should print 65536, not 1024
```

### Build and Start

```bash
npm ci
npm run build

pm2 start ecosystem.config.js
pm2 save
pm2 startup   # enables auto-start on reboot
```

### Management

```bash
pm2 status           # view running processes
pm2 logs             # tail all logs
pm2 restart all      # restart both services
pm2 stop all         # stop all services
```

Both apps run in PM2's default fork mode (`instances: 1`, no `exec_mode: 'cluster'` — see "Scaling: single instance only, by design" above), so `pm2 reload` has no zero-downtime behavior here: it's functionally identical to `pm2 restart`, just under a more reassuring name. Zero-downtime reload requires cluster mode, which this deployment deliberately doesn't use (both services keep in-memory state — rate limits, connected WS clients — that a second instance wouldn't share). Use `pm2 restart all`; expect the same brief reconnect blip described for the Docker path's relay restart.

### Data Persistence & Backups

`.data/relay.db` (libSQL/SQLite, WAL mode) lives directly on disk here — no Docker volume indirection — along with its `-wal`/`-shm` sidecar files, which must be backed up together with the main `.db` file for a consistent snapshot. This path previously had **no backup mechanism at all**: `scripts/backup.sh` only works for the Docker deployment (it backs up a named Docker volume via a throwaway container), so losing this host's disk meant total, unrecoverable data loss.

`scripts/backup-bare-metal.sh` tars the whole data directory directly (no `docker` dependency) to `./backups/app-data-<timestamp>.tar.gz`, keeping the 14 most recent by default (`RELAY_BACKUP_RETAIN` to override; `DATA_DIR` to override the data directory path if you've set a non-default one). Schedule it with either:
- **Cron**: `0 3 * * * cd /path/to/Relay && ./scripts/backup-bare-metal.sh >> /var/log/relay-backup.log 2>&1`
- **systemd timer**: copy `deploy/relay-backup-bare-metal.service` + `deploy/relay-backup-bare-metal.timer` to `/etc/systemd/system/`, set `WorkingDirectory` in the service file to your repo root, then `systemctl enable --now relay-backup-bare-metal.timer`.

Ship the resulting `.tar.gz` files off-box (rsync/rclone to another host or object storage) — a backup that only ever lives on the same disk it's protecting against doesn't survive that disk failing. See the restore procedure below.

---

## 6. Restoring from a Backup

### Docker (primary path): `scripts/restore.sh`

`scripts/restore.sh` wraps the whole restore in one command — it verifies the
chosen backup contains `relay.db`, **safety-nets the current volume** (copies
it to `./backups/data-before-restore-<timestamp>` so a wrong backup never
destroys the only copy of your data), wipes + extracts the backup **preserving
the non-root relay user's file ownership** (otherwise the app/relay containers
can't write back to it), then starts the stack and waits for both services to
report healthy. The stack must be stopped first:

```bash
docker compose down
./scripts/restore.sh                                  # newest backup in ./backups/
./scripts/restore.sh backups/app-data-<timestamp>.tar.gz   # pick a specific one
```

On success it prints the next steps (`curl …/api/status`, then remove the
`data-before-restore-*` safety net once you've confirmed a known account is
present). The full backup → wipe → restore cycle was exercised against a live
stack (real account created, volume wiped, restored, stack healthy, account
still present) — the script is safe to use as-is, but do your own supervised
dry run before you rely on it in an incident.

### Manual / bare-metal (PM2) path

1. Stop the app so nothing writes to the data directory during restore:
   - Docker: `docker compose down`
   - PM2: `pm2 stop all`
2. Copy the current (possibly corrupted) data directory's contents out as a safety net before touching anything, in case the chosen backup turns out to be the wrong one:
   - Docker: `docker run --rm -v <app-data-volume>:/data -v $(pwd):/backup alpine cp -a /data /backup/data-before-restore` (find the volume name with `docker volume ls`, or reuse the project-name resolution from `scripts/restore.sh`)
   - PM2: `cp -a .data .data-before-restore`
3. Clear the data directory, then extract the chosen backup into it:
   - Docker: `docker run --rm -v <app-data-volume>:/data alpine sh -c 'rm -rf /data/* /data/.[!.]*' && docker run --rm -v <app-data-volume>:/data -v $(pwd)/backups:/backup alpine tar xzf /backup/app-data-<timestamp>.tar.gz -C /data`
   - PM2: `rm -rf .data/* .data/.[!.]* && tar xzf backups/app-data-<timestamp>.tar.gz -C .data`
4. Restart: `docker compose up -d` or `pm2 start ecosystem.config.js`.
5. Confirm the app comes up healthy (`docker compose ps`, or `pm2 status` + `curl localhost:3000/api/health`) and that a known account/conversation from before the incident is actually present, before deleting the `-before-restore` copy from step 2.

> Docker note: the manual `tar xzf` above runs as root but tar carries the
> backup's recorded `owner:group` through, so the restored `relay.db` keeps
> the relay user's (uid 100) ownership and stays writable by the non-root
> containers. If you ever see `SQLITE_CANTOPEN` after a restore, the
extracted files were left root-owned — `chown 100:101` them in a throwaway
container.

Restoring rolls back to the backup's point in time — any writes between that backup and the incident are gone. If that gap matters more than the cost of running it, add Litestream (mentioned in the Docker Data Persistence section above) for near-zero-RPO continuous backup instead of relying solely on the daily snapshot.

---

## 7. TLS / HTTPS Setup

The relay server itself runs plain WebSocket (`ws://`). TLS termination should be handled by a reverse proxy.

### Development

Place self-signed certificates in `dev-certs/`:

```
dev-certs/
  key.pem
  cert.pem
```

The custom `server.js` detects these files and starts in HTTPS mode automatically, serving both the Next.js app and proxying WebSocket connections over `wss://`.

### Production

Use a reverse proxy (nginx, Caddy, or Cloudflare) to terminate TLS. Example nginx configuration:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    # Next.js frontend
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket relay
    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
    }
}
```

---

## 8. Cloudflare Setup Notes

The codebase relies on Cloudflare for rate limiting and DDoS protection in production. Key considerations:

### Rate Limiting / Real Client IP

`lib/security/rate-limit.ts` prefers Cloudflare's `CF-Connecting-IP` header, then
`X-Real-IP` from a trusted nginx-style proxy, then falls back to a shared
`'direct'` bucket — **but only once you set `TRUST_PROXY_HEADERS=true`** in
`.env`. Neither header proves anything on its own: any request that reaches
the process directly (e.g. the app/relay ports published without a firewall
restricting them, or docker-compose ports not bound to loopback) can set
either header to whatever it wants, minting a fresh rate-limit bucket per
request. `TRUST_PROXY_HEADERS` is an explicit opt-in you should only set
after confirming the deployment topology genuinely enforces one of the
options below — with it unset (the safe default), all direct-connection
clients share one bucket, which is conservative but never spoofable. This
matters for two reasons:

- **Correctness**: without it, every visitor's connection would arrive at the
  origin from Cloudflare's edge IP, not the visitor's own IP — every user
  behind Cloudflare would share one rate-limit bucket and could lock each
  other out.
- **Security**: `X-Forwarded-For` is client-controlled and spoofable by
  anyone unless a proxy in front of the origin strips/overwrites it. The
  limiter deliberately does **not** trust a bare `X-Forwarded-For` on its
  own — it only trusts it once `X-Real-IP` (set by a proxy you control, e.g.
  nginx) confirms a trusted proxy is actually in front. `CF-Connecting-IP` is
  trusted directly because only Cloudflare's edge can set it once you've
  restricted origin access to Cloudflare's IP ranges (see below) — Cloudflare
  strips any client-supplied `CF-Connecting-IP` and overwrites it with the
  real connecting IP.
- Still ensure the origin server only accepts connections from
  [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/) (e.g.
  via firewall rules) — otherwise a request could bypass Cloudflare entirely
  and hit the origin directly with a forged `CF-Connecting-IP` header.

### WebSocket Proxying

Cloudflare supports WebSocket connections on all plans, but the **WebSockets
toggle must be ON** for the zone (Network tab in the dashboard) — it's on by
default, but confirm it wasn't disabled by an account-level setting.
Cloudflare (free/pro tiers) also silently closes a WS connection after ~100
seconds of no data in either direction.

The relay server now sends a WebSocket protocol-level `ping` every 30 seconds
to every connected client (`server/relay-node.ts`, `WS_HEARTBEAT_INTERVAL_MS`)
and terminates any connection that doesn't answer the previous ping — this
keeps connections alive through Cloudflare's idle timeout without any
client-side change (browsers answer WS pings with pongs automatically at the
protocol level). No dashboard configuration is needed for this; it's purely
an application-level fix. If you front the relay with something other than
Cloudflare that has an even shorter idle timeout, this 30s interval comfortably
covers timeouts down to ~60s; lower `WS_HEARTBEAT_INTERVAL_MS` further if needed.

### DNS Configuration

Point your domain's DNS to Cloudflare with the orange cloud (proxy) enabled:

| Record | Name           | Value                     | Proxy |
|--------|----------------|---------------------------|-------|
| A      | `@`            | `<origin-server-ip>`      | Yes   |
| A      | `relay`        | `<origin-server-ip>`      | Yes   |

### SSL/TLS Mode

Set the zone's SSL/TLS encryption mode to **Full** or **Full (strict)** — never
**Flexible**. Flexible mode terminates TLS at Cloudflare's edge and connects
to the origin over plain HTTP; combined with this app's `Secure` session
cookies (only sent over HTTPS) and HSTS header, a Flexible-mode setup can
end up serving the app over unencrypted Cloudflare-to-origin HTTP while the
browser still believes the whole connection is HTTPS, and depending on your
reverse proxy config may fail to set cookies at all. Full/Full (strict)
encrypts the Cloudflare-to-origin hop too (a self-signed cert is enough for
Full; a CA-signed one, e.g. via Cloudflare Origin CA, for Full strict) and is
the only mode that matches what this app assumes.

### Caching

API routes (`/api/*`) should never be cached by Cloudflare — a "Cache
Everything" Page Rule (or an overly broad Cache Rule) applied to the whole
zone would risk caching one user's authenticated response (login, session
data, profile) and serving it to a different visitor at the same URL.
`middleware.ts` now sets `Cache-Control: no-store` on every `/api/*` response
as a code-level guarantee, but if you use Cloudflare Cache Rules / Page
Rules for other parts of the site, explicitly scope them to static assets
(`/_next/static/*`, images, etc.) rather than the whole domain, or add an
explicit "Bypass Cache" rule for `/api/*` and the WS upgrade path (`/ws`) as
defense-in-depth.

### Security Headers

The Next.js config (`next.config.js`) already sets security headers:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`

These are also configurable in the Cloudflare dashboard if you prefer to manage them there.

---

## 9. Health Checks

### Docker

Health checks are defined in `docker-compose.yml` (see section 4).

### Manual Verification

**Next.js app:**

```bash
curl -f http://localhost:3000/api/health || echo "App is down"
```

**Relay server:**

```bash
# TCP check
nc -z localhost 8080 && echo "Relay is up" || echo "Relay is down"

# WebSocket check (requires wscat or similar)
echo '{"type":"hello","relayId":"00000000"}' | wscat -c ws://localhost:8080 -w 2
```

**TURN server (only if the `turn` profile is enabled):**

```bash
# UDP port check
nc -zu localhost 3478 && echo "TURN is up" || echo "TURN is down"
```

### Monitoring

For production monitoring, consider:

- **Docker health:** `docker compose ps` shows health status. (`pm2 monit` only applies to the bare-metal/PM2 deployment path in section 8, not the Docker deployment -- PM2 isn't part of the Docker image.)
- **External uptime:** Point an uptime monitor at `https://your-domain.com/api/health` (HTTP 200 check) and at the relay health check endpoint.

---

## 10. Updating

`./scripts/update.sh` automates a safe update of the docker-compose deployment:

```bash
./scripts/update.sh            # build + deploy the current working tree
./scripts/update.sh --pull     # git pull first, then build + deploy
./scripts/update.sh --rollback # manually revert to the last-saved images
```

What it does, in order:

1. **Backs up** the `app-data` volume (session store, user DB) to `./backups/` before touching anything.
2. **Records** the currently-running `app`/`relay` image tags (via `docker tag`, not immutable digests) so a failed update can be rolled back to what was running before.
3. **Builds** the new images from the current working tree.
4. **Deploys**: recreates the `app` and `relay` containers from the new images.
5. **Health-checks** both services for up to 2 minutes.
6. **On failure**, automatically retags the old images back and recreates the containers from them — no manual intervention needed for a bad build.

### What this does *not* solve

- **Live WebSocket connections drop on relay restart.** There's one relay process and no message queue in front of it — restarting it disconnects every connected client and drops any in-progress call. This is expected, not a bug: clients already reconnect automatically (heartbeat + reconnect logic in `lib/relay/relay-websocket.ts`), so users see a brief reconnect blip, not an outage. Avoiding this entirely would require running a second relay instance to drain traffic onto during the update — a bigger architectural change (and one that also needs a shared session/rate-limit store first, since both are currently in-memory per-process; see `TRUST_PROXY_HEADERS` and the session-store notes above).
- **User sessions are preserved.** `lib/db/session-store.ts` persists to disk under the `app-data` volume, so an app-container restart does not log anyone out.
- **Schema migrations run automatically** on the next `app`/`relay` start (`lib/db/sqlite-client.ts`'s migrations are additive — `CREATE TABLE IF NOT EXISTS` / guarded `ALTER TABLE` — so they're safe to re-run and don't need a separate migration step).

### Before running this against real production data

This script exercises real `docker`/`docker compose` primitives, but the exact `docker compose images --format json` output shape it parses to find your current image tags wasn't verifiable in the environment this was written in (no `docker compose` plugin available there — only the backup/tag/restore mechanics were individually tested against plain `docker` commands). **Do one supervised dry run** (`./scripts/update.sh` with no real changes queued) on your actual server before relying on it for a real update, and confirm the printed image tags/backup path look right before trusting the automatic rollback path in a real incident.

---

## 11. Platform: Web Only

Relay is a **web-only** messenger. The native desktop (Tauri) and Android
(Capacitor) clients were removed from the repo before open-sourcing — the
Docker deployment in this guide *is* the product, and the same web app it
serves is the only client. See the git history if the native shells are ever
needed again.

What this means in practice:

- **Browsers, not apps.** Users access Relay in any modern browser
  (Chrome/Edge, Firefox, Safari — desktop or mobile). There is no Play Store
  or desktop-download distribution.
- **Browser notifications.** Incoming-message notifications use the browser
  Notification API when the tab is hidden/blurred; users grant permission
  in Settings → Push notifications. Vibration uses `navigator.vibrate` on
  supporting mobile browsers.
- **No push infrastructure.** The old Android FCM push path was removed; it
  was a stub that never functioned without a native client. There is no
  Firebase dependency anywhere in the codebase, and no push token is stored
  server-side.
- **No signing keys, app-store review, or auto-update.** None of the native
  release machinery (Tauri signing, Android keystores, code-signing
  certificates) exists anymore. Releasing = deploying the Docker image.

## 12. Port Summary

| Service      | Default Port | Protocol     | Configurable Via        |
|--------------|--------------|--------------|-------------------------|
| Next.js app  | 3000         | HTTP(S)      | `PORT`                  |
| Relay server | 8080         | WebSocket    | `RELAY_PORT` or `PORT`  |
| TURN server (optional, `docker-compose.turn.yml`) | 3478 | UDP/TCP | fixed in `docker-compose.turn.yml` |

---

## 13. Deploying with Dokploy (+ Nginx Proxy Manager + Cloudflare)

[Dokploy](https://dokploy.com) is a self-hostable PaaS for deploying Docker
Compose apps — here it's used purely as the deployment mechanism (build +
run `docker-compose.yml`, redeploy on push, container-level monitoring),
**not** for its own Traefik/Domains features. TLS termination and routing
are handled by a separately-run **Nginx Proxy Manager (NPM)** container,
with Cloudflare (Tunnel or the orange-cloud proxy) in front of that.

**Environment variables**: set them via Dokploy's Environment tab for this
application rather than hand-editing the compose file. Dokploy writes what
you enter there to a `.env` file next to the compose file on the host,
which the existing `env_file: .env` on both the `app` and `relay` services
already picks up — no compose changes needed. Set the same variables §2
describes (`SESSION_SECRET`, `TOTP_ENCRYPTION_KEY`, `WEBAUTHN_RP_ID`,
`WEBAUTHN_ORIGIN`, `WS_ALLOWED_ORIGINS`, `NEXT_PUBLIC_RELAY_URL`, etc.),
pointed at your real public domain(s), not `localhost`. `NEXT_PUBLIC_RELAY_URL`
specifically must be the real public `wss://` URL (through NPM/Cloudflare,
not the internal `relay:8080` service name) and gets baked into the client
bundle at build time (see §2's table) — Dokploy's normal redeploy-on-push
rebuilds the image every time, so this works automatically as long as the
variable is set *before* triggering a deploy; it will not take effect on a
restart alone if you change it without redeploying.

### The one real wiring problem: NPM is its own container

`docker-compose.yml`'s `app`/`relay` services publish ports bound to
`127.0.0.1` — fine for a reverse proxy running directly on the host, but
**unreachable from a separate container**: a container's own `127.0.0.1` is
itself, not the host. NPM (its own container, per your setup) needs to
reach `app` and `relay` by Docker service name over a network they both
share, not through those loopback-bound ports at all.

`docker-compose.yml` already has what this needs: an `external` network
named `proxy-net` that the `app` and `relay` services join in addition to
their own default network. It's declared `external` rather than owned by
this compose file specifically because it has to survive independently of
both this stack's and NPM's own — neither one should be able to delete a
network the other depends on just by being torn down and recreated.

**One-time setup** (do this once, before first deploying either stack):

```bash
docker network create proxy-net
```

Then join NPM's own container to the same network — either add
`networks: [proxy-net]` to NPM's compose file (if you deployed it via
compose), or run:

```bash
docker network connect proxy-net <your-npm-container-name>
```

In NPM's admin UI, create a Proxy Host pointing at `app` (not `localhost`
or an IP) on port `3000` for the main app, and a second Proxy Host (or a
second location on the same host) at `relay` on port `8080` for the
WebSocket path — Docker's internal DNS resolves `app`/`relay` to the right
container automatically as long as both are on `proxy-net`. Make sure
**"Websockets Support"** is enabled on whichever Proxy Host handles the
relay path (NPM has a per-host toggle for this) — without it, NPM won't
upgrade the connection and every client will silently fail to connect.

### Cloudflare in front of NPM

Either Cloudflare Tunnel (`cloudflared`, no public inbound ports needed on
the VPS at all — it connects outbound to Cloudflare) or the traditional
orange-cloud proxy (DNS pointed at the VPS's public IP, ports 80/443 open)
work here; §8's Cloudflare setup notes (SSL/TLS mode, WebSocket support,
caching rules) apply the same way regardless of which one you pick — NPM
just sits between Cloudflare and the containers either way.

**`TRUST_PROXY_HEADERS`**: for `CF-Connecting-IP` to reach the app
correctly (see §8's explanation of why a bare `X-Forwarded-For` isn't
trusted), NPM must pass that header through unmodified rather than
stripping or overwriting it — nginx does this by default unless a Proxy
Host's Advanced config explicitly clears it, but it's worth confirming once
after setup (e.g. temporarily log `request.headers.get('cf-connecting-ip')`
server-side, or check via a browser dev-tools request) before relying on
`TRUST_PROXY_HEADERS=true` for real.

### Monitoring: Dokploy's built-in alerts are the practical answer here

Dokploy has its own monitoring (CPU/memory/network) and deployment health-
check tracking, with alerts to Discord, Slack, Telegram, email, and others
— including automatic rollback if a deploy's health check fails. Enabling
this (Server settings → Notifications) is the realistic way to get real
uptime alerting for a single-VPS deployment without standing up separate
infrastructure, and it complements rather than replaces the app's own
`/api/health` endpoint (§9) and Sentry-based error reporting (§2's Error
Monitoring section) — point an external uptime check at `/api/health` too
if you want alerting that survives Dokploy itself being down.

### Not yet verified: TURN (`docker-compose.turn.yml`) under Dokploy

The optional coturn service (§2's TURN Server section) uses
`network_mode: host` to work, which sits outside Docker Compose's normal
per-service networking entirely. Whether Dokploy's deployment model
tolerates a host-networked service in a Compose stack it manages hasn't
been tested. If enabling the `turn` profile under Dokploy doesn't come up
cleanly, calls still work via public STUN + direct peer-to-peer (§2's
documented fallback, just without the IP-hiding TURN provides) — that's a
degraded-but-functional state, not a broken one, while you investigate.
