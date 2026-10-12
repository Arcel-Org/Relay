#!/usr/bin/env bash
#
# Relay — clone-free, one-command installer.
#
# Fetches just the Compose files + env template, generates your secrets, and
# brings the whole stack up from the PREBUILT image. No git clone of the repo,
# no Node.js, no local compilation.
#
#   curl -fsSL -o quickstart.sh https://raw.githubusercontent.com/Arcel-Org/Relay/master/scripts/quickstart.sh
#   bash quickstart.sh
#   bash quickstart.sh --url https://relay.example.com --yes   # fully automated
#
# What it does:
#   1. Fetches docker-compose.yml, docker-compose.release.yml and .env.example
#   2. Asks for (or takes) the public URL, derives the relay wss URL, the
#      allowed origin, and the WebAuthn RP values from it
#   3. Generates SESSION_SECRET and TOTP_ENCRYPTION_KEY if not already set
#   4. Creates the shared proxy-net network if missing
#   5. Pulls the image and starts the stack (see docker-compose.release.yml —
#      that override swaps `build` for the GHCR image)
#
# To update later:  bash quickstart.sh --yes --url https://relay.example.com
# (this re-fetches the compose files, pulls the latest image, and re-ups).
set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────
SOURCE_VERSION="${SOURCE_VERSION:-master}"
SOURCE_BASE="${SOURCE_BASE:-https://raw.githubusercontent.com/Arcel-Org/Relay/${SOURCE_VERSION}}"
RELAY_IMAGE="${RELAY_IMAGE:-ghcr.io/arcel-org/relay:latest}"
DIR="$(pwd)/relay"
GIVEN_URL=""
ASSUME_YES=0
AUTO_UP=1

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Options:"
  echo "  --url <URL>      Public URL the app is served at, e.g. https://relay.example.com"
  echo "  --dir <path>     Where to keep compose files + .env (default: ./relay)"
  echo "  --yes            Non-interactive (then --url is required if not already in .env)"
  echo "  --no-up          Generate files/env but do not start the stack"
  echo "  -h, --help       Show this help"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)   GIVEN_URL="${2:?--url needs a value}"; shift 2 ;;
    --dir)   DIR="${2:?--dir needs a value}"; shift 2 ;;
    --yes)   ASSUME_YES=1; shift ;;
    --no-up) AUTO_UP=0; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

# ── Prerequisites ─────────────────────────────────────────────────────────
for tool in docker curl openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: '$tool' is required but not installed." >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose (v2 plugin) is required — 'docker compose version' failed." >&2
  exit 1
fi

# ── Fetch the minimal files (never the whole repo) ─────────────────────────
mkdir -p "$DIR"
log() { printf '\n>> %s\n' "$*"; }
log "Fetching compose files from $SOURCE_BASE"
for f in docker-compose.yml docker-compose.release.yml .env.example; do
  if ! curl -fsSL -o "$DIR/$f" "$SOURCE_BASE/$f"; then
    echo "ERROR: could not fetch $f from $SOURCE_BASE (is the release URL reachable?)." >&2
    exit 1
  fi
  echo "   fetched $DIR/$f"
done

ENV_FILE="$DIR/.env"
[ -f "$ENV_FILE" ] || cp "$DIR/.env.example" "$ENV_FILE"

# Note: we must not fetch the relay image at URL-first time; NEXT_PUBLIC_RELAY_URL
# must be in .env because the base compose file requires it ({:?}). We derive
# it below from the public URL (mirrors scripts/setup.sh).

# ── Resolve the public URL ────────────────────────────────────────────────
get_env() { grep -E "^#?${1}=" "$ENV_FILE" 2>/dev/null | head -1 | sed -E 's/^#?[^=]*=//' | tr -d '"' || true; }
set_env() { # set_env <key> <value>
  local key="$1" val="$2"
  if grep -qE "^#?${key}=" "$ENV_FILE"; then
    sed -i -E "s|^#?${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

EXISTING_URL="$(get_env RELAY_PUBLIC_URL)"
[ -z "$EXISTING_URL" ] && EXISTING_URL="$(get_env NEXT_PUBLIC_RELAY_URL)"
URL="$GIVEN_URL"
if [ -z "$URL" ] && [ -n "$EXISTING_URL" ]; then URL="$EXISTING_URL"; fi
if [ -z "$URL" ] && [ "$ASSUME_YES" = "1" ]; then
  echo "ERROR: --yes requires --url (or a RELAY_PUBLIC_URL already in $ENV_FILE)." >&2
  exit 1
fi
if [ -z "$URL" ]; then
  hint=""; [ -n "$EXISTING_URL" ] && hint=" [${EXISTING_URL}]"
  read -r -p "Public URL Relay will be served at (e.g. https://relay.example.com)${hint}: " URL
  if [ -z "$URL" ] && [ -n "$EXISTING_URL" ]; then URL="$EXISTING_URL"; fi
  if [ -z "$URL" ]; then echo "ERROR: no URL given." >&2; exit 1; fi
fi

# Normalise + derive (mirrors scripts/setup.sh).
[[ "$URL" == *://* ]] || URL="https://${URL}"
scheme="${URL%%://*}"; hostport="${URL#*://}"; hostport="${hostport%%/*}"
host="${hostport%%:*}"
if [ -z "$host" ]; then echo "ERROR: could not parse URL '${URL}'." >&2; exit 1; fi
URL="${scheme}://${hostport}"
relay_proto="ws"; [ "$scheme" = "https" ] && relay_proto="wss"
NEXT_PUBLIC_RELAY_URL="${relay_proto}://${hostport}"

# ── Secrets (never overwrite valid existing values) ────────────────────────
SESSION_SECRET="$(get_env SESSION_SECRET)"
if [ -z "$SESSION_SECRET" ] || [ "${#SESSION_SECRET}" -lt 32 ]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
fi
TOTP_ENCRYPTION_KEY="$(get_env TOTP_ENCRYPTION_KEY)"
if [ -z "$TOTP_ENCRYPTION_KEY" ] || [ "${#TOTP_ENCRYPTION_KEY}" -ne 64 ] || ! [[ "$TOTP_ENCRYPTION_KEY" =~ ^[0-9a-f]{64}$ ]]; then
  TOTP_ENCRYPTION_KEY="$(openssl rand -hex 32)"
fi

set_env RELAY_PUBLIC_URL      "$URL"
set_env NEXT_PUBLIC_RELAY_URL "$NEXT_PUBLIC_RELAY_URL"
set_env WS_ALLOWED_ORIGINS    "${scheme}://${hostport}"
set_env WEBAUTHN_RP_ID        "$host"
set_env WEBAUTHN_ORIGIN       "${scheme}://${hostport}"
set_env SESSION_SECRET        "$SESSION_SECRET"
set_env TOTP_ENCRYPTION_KEY   "$TOTP_ENCRYPTION_KEY"

log "Configured for $URL (relay wss: $NEXT_PUBLIC_RELAY_URL)"

[ "$AUTO_UP" = "0" ] && { echo "Files written to $DIR. Start with:"; echo "  (cd $DIR && docker compose -f docker-compose.yml -f docker-compose.release.yml pull && docker compose -f docker-compose.yml -f docker-compose.release.yml up -d)"; exit 0; }

# ── Ensure the shared network exists (compose requires it) ────────────────
if ! docker network inspect proxy-net >/dev/null 2>&1; then
  docker network create proxy-net >/dev/null 2>&1 && log "created shared network 'proxy-net'"
fi

# ── Pull + start ───────────────────────────────────────────────────────────
cd "$DIR"
log "Pulling image ${RELAY_IMAGE}"
docker compose -f docker-compose.yml -f docker-compose.release.yml pull
log "Starting the stack (give the app up to ~75s for its healthcheck)"
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d
docker compose ps

cat <<'EOF'

Relay is provisioning. Point a TLS-terminating reverse proxy (nginx / Caddy /
Cloudflare) at it, then confirm:
  docker compose ps                 # both app and relay should be 'healthy'
  curl http://127.0.0.1:3000/api/status   # {"ok":true,"relayReachable":true,...}

Docs, backup/update/restore and the full production guide:
  https://github.com/Arcel-Org/Relay/blob/master/docs/DEPLOY.md
EOF
