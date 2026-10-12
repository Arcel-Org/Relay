#!/usr/bin/env bash
# Safe update for a single-server docker-compose deployment of Relay.
#
# What this does, in order:
#   1. Backs up the app-data volume (sessions.json, users.db, etc.) to
#      ./backups/ before touching anything.
#   2. Records the currently-running app/relay image IDs so a failed update
#      can be rolled back to exactly what was running before.
#   3. Builds the new images from the current working tree.
#   4. Recreates the app + relay containers from the new images.
#   5. Polls each service's healthcheck for up to 2 minutes.
#   6. On success: done. On failure: retags the old images back and
#      recreates the containers from them — auto-rollback.
#
# What this does NOT do:
#   - Zero-downtime WS: the relay container restart drops every live
#     WebSocket connection and any in-progress call. Clients already
#     reconnect automatically (heartbeat + reconnect logic in
#     lib/relay-websocket.ts) — expect a brief (seconds) reconnect blip for
#     every connected user, not an outage. There's no way to avoid this
#     with a single relay instance and no message queue in front of it;
#     doing so would need a second relay instance to drain onto, which is
#     a bigger architectural change than this script attempts.
#   - Sessions ARE preserved (lib/db/session-store.ts persists to disk
#     under the app-data volume) — users stay logged in across an update.
#
# Usage:
#   ./scripts/update.sh              # pull nothing, build+deploy the current working tree
#   ./scripts/update.sh --pull       # git pull first, then build+deploy
#   ./scripts/update.sh --rollback   # manually roll back to the last-saved images, skip build

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose"
PROJECT_DIR="$(basename "$(pwd)")"
BACKUP_DIR="./backups"
HEALTH_TIMEOUT_SEC=120
HEALTH_POLL_INTERVAL_SEC=3

log() { echo "[update] $*"; }
err() { echo "[update] ERROR: $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "'$1' is required but not installed"; exit 1; }
}

require_cmd docker
require_cmd tar

if [ ! -f .env ]; then
  err ".env not found — this script must be run from the Relay repo root with .env already configured (see docs/DEPLOY.md)."
  exit 1
fi

MODE="deploy"
DO_PULL=false
for arg in "$@"; do
  case "$arg" in
    --pull) DO_PULL=true ;;
    --rollback) MODE="rollback" ;;
    *) err "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ── Resolve actual image names docker compose is using for app/relay ──────
app_image() { $COMPOSE images app --format json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const rows=JSON.parse(d);const r=Array.isArray(rows)?rows[0]:rows;console.log(r?(r.Repository+':'+r.Tag):'');}catch{console.log('');}})"; }
relay_image() { $COMPOSE images relay --format json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const rows=JSON.parse(d);const r=Array.isArray(rows)?rows[0]:rows;console.log(r?(r.Repository+':'+r.Tag):'');}catch{console.log('');}})"; }

APP_IMAGE="$(app_image)"
RELAY_IMAGE="$(relay_image)"
if [ -z "$APP_IMAGE" ] || [ -z "$RELAY_IMAGE" ]; then
  # Either nothing is running yet (first deploy — expected), or the
  # `docker compose images --format json` output shape didn't match what
  # app_image()/relay_image() expect and the parse silently failed (NOT
  # expected — this would otherwise look identical to "first deploy" and
  # feed a guessed name into rollback tagging with no warning). Distinguish
  # the two: if a container IS actually running for either service, this is
  # a real parse failure, not a fresh deploy.
  if [ -n "$(${COMPOSE} ps -q app 2>/dev/null || true)" ] || [ -n "$(${COMPOSE} ps -q relay 2>/dev/null || true)" ]; then
    err "app/relay containers are running but their image tags could not be parsed from 'docker compose images --format json' — the output shape may differ from what this script expects (see docs/DEPLOY.md's 'Updating' section). Falling back to a guessed image name; verify \$ROLLBACK_APP_TAG/\$ROLLBACK_RELAY_TAG below actually correspond to what's running before trusting rollback."
  fi
  APP_IMAGE="${PROJECT_DIR}-app:latest"
  RELAY_IMAGE="${PROJECT_DIR}-relay:latest"
fi
# Strip only the FINAL :tag suffix — a naive greedy `%%:*` would strip
# everything from the FIRST colon instead, mangling any image reference
# that includes a registry host:port prefix (e.g.
# registry.example.com:5000/relay-app:latest) and could collapse the app
# and relay rollback tags onto the same name if they share a registry
# prefix. `%` (single, shortest-match-from-the-end) strips only the last
# `:...` segment.
ROLLBACK_APP_TAG="${APP_IMAGE%:*}:rollback"
ROLLBACK_RELAY_TAG="${RELAY_IMAGE%:*}:rollback"
if [ "$ROLLBACK_APP_TAG" = "$ROLLBACK_RELAY_TAG" ]; then
  err "Resolved app and relay images to the same rollback tag ($ROLLBACK_APP_TAG) — refusing to continue, this would silently overwrite one service's rollback image with the other's. Check APP_IMAGE ($APP_IMAGE) / RELAY_IMAGE ($RELAY_IMAGE) above."
  exit 1
fi

resolve_app_data_volume() {
  # Don't guess the compose-generated volume name (it depends on the
  # project name, which docker compose derives from the directory name
  # with its own sanitization rules) — ask a running container what it's
  # actually mounted to. Falls back to the app service, then relay.
  local vol
  vol="$(docker inspect --format='{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' "$(${COMPOSE} ps -q app 2>/dev/null)" 2>/dev/null || true)"
  if [ -z "$vol" ]; then
    vol="$(docker inspect --format='{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' "$(${COMPOSE} ps -q relay 2>/dev/null)" 2>/dev/null || true)"
  fi
  echo "$vol"
}

backup_data() {
  mkdir -p "$BACKUP_DIR"
  local ts vol
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  vol="$(resolve_app_data_volume)"
  if [ -z "$vol" ]; then
    log "No running app-data volume found (first deploy?) — skipping backup, nothing to back up yet."
    return 0
  fi
  local out="$BACKUP_DIR/app-data-${ts}.tar.gz"
  log "Backing up app-data volume ($vol) to $out"
  docker run --rm \
    -v "${vol}:/data:ro" \
    -v "$(pwd)/$BACKUP_DIR:/backup" \
    alpine:latest \
    tar czf "/backup/app-data-${ts}.tar.gz" -C /data . \
    || { err "Backup failed — aborting update."; exit 1; }
  log "Backup complete: $out"

  # Keep the last 10 backups only — otherwise these accumulate forever on a
  # regularly-updated server until disk fills, at which point this function
  # itself starts failing and blocks every future update.
  local backup_count
  backup_count="$(find "$BACKUP_DIR" -maxdepth 1 -name 'app-data-*.tar.gz' | wc -l | tr -d ' ')"
  if [ "$backup_count" -gt 10 ]; then
    log "Pruning old backups (keeping the 10 most recent)..."
    find "$BACKUP_DIR" -maxdepth 1 -name 'app-data-*.tar.gz' -print0 \
      | xargs -0 ls -t \
      | tail -n +11 \
      | xargs -r rm -f
  fi
}

save_rollback_images() {
  log "Recording current images for rollback: $ROLLBACK_APP_TAG, $ROLLBACK_RELAY_TAG"
  docker tag "$APP_IMAGE" "$ROLLBACK_APP_TAG" 2>/dev/null || log "  (no existing app image to tag — first deploy)"
  docker tag "$RELAY_IMAGE" "$ROLLBACK_RELAY_TAG" 2>/dev/null || log "  (no existing relay image to tag — first deploy)"
}

wait_for_health() {
  log "Waiting up to ${HEALTH_TIMEOUT_SEC}s for app + relay to report healthy..."
  local elapsed=0
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT_SEC" ]; do
    local app_status relay_status
    app_status="$(docker inspect --format='{{.State.Health.Status}}' "$(${COMPOSE} ps -q app)" 2>/dev/null || echo unknown)"
    relay_status="$(docker inspect --format='{{.State.Health.Status}}' "$(${COMPOSE} ps -q relay)" 2>/dev/null || echo unknown)"
    if [ "$app_status" = "healthy" ] && [ "$relay_status" = "healthy" ]; then
      log "Both services healthy."
      return 0
    fi
    if [ "$app_status" = "unhealthy" ] || [ "$relay_status" = "unhealthy" ]; then
      err "A service reported unhealthy (app=$app_status, relay=$relay_status) before the timeout — failing fast."
      return 1
    fi
    sleep "$HEALTH_POLL_INTERVAL_SEC"
    elapsed=$((elapsed + HEALTH_POLL_INTERVAL_SEC))
  done
  err "Timed out waiting for health (app=$app_status, relay=$relay_status)."
  return 1
}

rollback() {
  err "Rolling back to the previously-saved images."
  docker tag "$ROLLBACK_APP_TAG" "$APP_IMAGE" || { err "No rollback image available for app — manual recovery needed. Restore from $BACKUP_DIR if the data itself is suspect."; exit 1; }
  docker tag "$ROLLBACK_RELAY_TAG" "$RELAY_IMAGE" || { err "No rollback image available for relay — manual recovery needed."; exit 1; }
  # Guarded explicitly — under `set -e` a bare failing command here would
  # kill the script before ever reaching the health-check/diagnostic
  # messages below, which is exactly backwards for the worst-case path.
  if ! $COMPOSE up -d --force-recreate --no-build app relay; then
    err "docker compose up failed during rollback itself. This needs manual intervention — check 'docker compose logs app relay', and consider restoring the data backup in $BACKUP_DIR."
    exit 1
  fi
  if wait_for_health; then
    err "Rollback succeeded — the update did NOT go live. Investigate before retrying."
    exit 1
  else
    err "Rollback ALSO failed health checks. This needs manual intervention — check 'docker compose logs app relay', and consider restoring the data backup in $BACKUP_DIR."
    exit 1
  fi
}

if [ "$MODE" = "rollback" ]; then
  rollback
  # rollback() always exits (1) on every path, so this line is unreachable
  # today — intentionally kept so a future refactor that lets rollback return
  # can never fall through to the git-pull / backup steps below. (SC2317)
  # shellcheck disable=SC2317
  exit 0
fi

if [ "$DO_PULL" = true ]; then
  log "Pulling latest from git..."
  git pull --ff-only
fi

backup_data
save_rollback_images

log "Building new images..."
$COMPOSE build app relay

log "Deploying..."
# Guarded explicitly — under `set -e` a bare failing command here would
# exit the script immediately and skip the rollback path entirely,
# defeating the script's core safety promise (docker compose may have
# already stopped the old, working containers while trying to recreate
# them, leaving a broken deployment with no automatic recovery attempted).
if ! $COMPOSE up -d --no-deps app relay; then
  err "docker compose up failed during deploy — attempting rollback."
  rollback
fi

if wait_for_health; then
  log "Update deployed successfully."
  log "Previous images kept as $ROLLBACK_APP_TAG / $ROLLBACK_RELAY_TAG — run './scripts/update.sh --rollback' any time to revert to them."
  exit 0
else
  rollback
fi
