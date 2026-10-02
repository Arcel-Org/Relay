#!/usr/bin/env bash
#
# Relay — one-command Docker setup
#
# Generates a production-ready .env (secrets auto-generated with openssl,
# public URL asked once) and optionally brings the whole stack up with
# docker compose.
#
#   ./scripts/setup.sh                 # interactive: prompts for the URL
#   ./scripts/setup.sh --url https://relay.example.com   # non-interactive
#   ./scripts/setup.sh --up            # generate .env, then docker compose up -d --build
#   ./scripts/setup.sh --yes --url https://relay.example.com --up   # fully automated
#
# What it writes to .env (never overwrites your existing values, only fills
# gaps and re-derives the URL-derived keys):
#   RELAY_PUBLIC_URL        the canonical public URL you gave us
#   NEXT_PUBLIC_RELAY_URL   wss:// (or ws://) form of that host — baked into
#                           the client bundle at build time
#   WS_ALLOWED_ORIGINS      origin form — the relay refuses to start without it
#   WEBAUTHN_RP_ID          bare domain (no scheme/port) for passkeys
#   WEBAUTHN_ORIGIN         exact origin passkeys are bound to
#   SESSION_SECRET          generated with `openssl rand -hex 32` if unset
#   TOTP_ENCRYPTION_KEY     generated with `openssl rand -hex 32` if unset
#
set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────
ENV_FILE=".env"
AUTO_UP=0
ASSUME_YES=0
GIVEN_URL=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Options:"
  echo "  --url <URL>          Public URL (default: prompt, or reuse existing .env)"
  echo "  --env-file <path>    Write to this file instead of ./.env"
  echo "  --up                 Run 'docker compose up -d --build' after writing .env"
  echo "  --yes                Non-interactive (requires --url if .env has no usable URL)"
  echo "  --install-docker     Attempt to install Docker (Linux get.docker.com; mac brew)"
  echo "  -h, --help           Show this help"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)          GIVEN_URL="${2:?--url needs a value}"; shift 2 ;;
    --env-file)     ENV_FILE="${2:?--env-file needs a value}"; shift 2 ;;
    --up)           AUTO_UP=1; shift ;;
    --yes)          ASSUME_YES=1; shift ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    -h|--help)      usage ;;
    *)              echo "Unknown option: $1" >&2; usage ;;
  esac
done

# ── Prerequisites ───────────────────────────────────────────────────────────
if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl is required (used to generate SESSION_SECRET / TOTP_ENCRYPTION_KEY)." >&2
  echo "  Debian/Ubuntu:  apt-get install -y openssl" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  if [ "${INSTALL_DOCKER:-0}" = "1" ]; then
    echo ">> Installing Docker..."
    if command -v apt-get >/dev/null 2>&1; then
      # Debian/Ubuntu — official convenience script covers the rest of the
      # distro families too, but require sudo since we're not root-guaranteed.
      sudo sh -c 'curl -fsSL https://get.docker.com | sh' || { echo "ERROR: docker install failed." >&2; exit 1; }
    elif command -v brew >/dev/null 2>&1; then
      brew install --cask docker
    else
      echo "ERROR: unsupported platform for --install-docker. Install Docker manually, then re-run." >&2
      exit 1
    fi
  else
    echo "ERROR: docker is not installed." >&2
    echo "  Install it first (e.g. Debian/Ubuntu:  curl -fsSL https://get.docker.com | sh)" >&2
    echo "  or re-run with --install-docker." >&2
    exit 1
  fi
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' plugin not available. Install Docker Compose v2, then re-run." >&2
  exit 1
fi

# ── Read existing .env (if any) ─────────────────────────────────────────────
touch "$ENV_FILE"

get_env() { # get_env <key> -> echoes value (empty if unset/placeholder)
  local key="$1" v
  v="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')" || true
  printf '%s' "$v"
}

is_real() { # is_real <value> — non-empty and not a "replace-with-..." placeholder
  local v="$1"
  [ -n "$v" ] && ! [[ "$v" == *replace-with* ]] && ! [[ "$v" == *your-* ]]
}

# ── Secrets (auto-generated with openssl, never clobbered) ─────────────────
SESSION_SECRET="$(get_env SESSION_SECRET)"
if ! is_real "$SESSION_SECRET"; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  echo ">> Generated SESSION_SECRET"
fi

TOTP_ENCRYPTION_KEY="$(get_env TOTP_ENCRYPTION_KEY)"
if ! is_real "$TOTP_ENCRYPTION_KEY"; then
  TOTP_ENCRYPTION_KEY="$(openssl rand -hex 32)"
  echo ">> Generated TOTP_ENCRYPTION_KEY"
fi

# ── Public URL ──────────────────────────────────────────────────────────────
EXISTING_URL="$(get_env RELAY_PUBLIC_URL)"
if ! is_real "$EXISTING_URL"; then EXISTING_URL="$(get_env NEXT_PUBLIC_RELAY_URL)"; fi

URL="$GIVEN_URL"
if [ -z "$URL" ] && is_real "$EXISTING_URL"; then
  URL="$EXISTING_URL"
fi
if [ -z "$URL" ] && [ "$ASSUME_YES" = "1" ]; then
  echo "ERROR: --yes requires --url (or a RELAY_PUBLIC_URL already in $ENV_FILE)." >&2
  exit 1
fi
if [ -z "$URL" ]; then
  default_hint=""
  [ -n "$EXISTING_URL" ] && default_hint=" [${EXISTING_URL}]"
  read -r -p "Public URL Relay will be served at (e.g. https://relay.example.com)${default_hint}: " URL
  if [ -z "$URL" ] && [ -n "$EXISTING_URL" ]; then URL="$EXISTING_URL"; fi
  if [ -z "$URL" ]; then echo "ERROR: no URL given." >&2; exit 1; fi
fi

# Normalise: default to https:// when no scheme is provided.
[[ "$URL" == *://* ]] || URL="https://${URL}"
scheme="${URL%%://*}"
hostport="${URL#*://}"
hostport="${hostport%%/*}"   # drop any path — Relay is served at the origin
host="${hostport%%:*}"
if [ -z "$host" ]; then echo "ERROR: could not parse URL '${URL}'." >&2; exit 1; fi

# Canonical form for RELAY_PUBLIC_URL: scheme://host[:port], no path/slash.
URL="${scheme}://${hostport}"

relay_proto="ws"; [ "$scheme" = "https" ] && relay_proto="wss"
NEXT_PUBLIC_RELAY_URL="${relay_proto}://${hostport}"
WS_ALLOWED_ORIGINS="${scheme}://${hostport}"
WEBAUTHN_RP_ID="$host"
WEBAUTHN_ORIGIN="${scheme}://${hostport}"

echo ">> Configuring Relay for: $URL"
echo "   relay websocket:  $NEXT_PUBLIC_RELAY_URL"
echo "   allowed origins:  $WS_ALLOWED_ORIGINS"

# ── Write .env (upsert; preserves every other key the user has set) ────────
set_env() { # set_env <key> <value>
  local key="$1" val="$2"
  if grep -qE "^#?${key}=" "$ENV_FILE"; then
    sed -i -E "s|^#?${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

set_env RELAY_PUBLIC_URL      "$URL"
set_env NEXT_PUBLIC_RELAY_URL "$NEXT_PUBLIC_RELAY_URL"
set_env WS_ALLOWED_ORIGINS    "$WS_ALLOWED_ORIGINS"
set_env WEBAUTHN_RP_ID        "$WEBAUTHN_RP_ID"
set_env WEBAUTHN_ORIGIN       "$WEBAUTHN_ORIGIN"
set_env SESSION_SECRET        "$SESSION_SECRET"
set_env TOTP_ENCRYPTION_KEY   "$TOTP_ENCRYPTION_KEY"

echo ">> Wrote $ENV_FILE"

# ── Boot ────────────────────────────────────────────────────────────────────
if [ "$AUTO_UP" = "1" ]; then
  echo ">> Building and starting the stack (docker compose up -d --build)..."
  docker compose up -d --build
  echo ">> Done. Check status with:  docker compose ps"
fi
