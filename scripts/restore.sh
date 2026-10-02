#!/usr/bin/env bash
# Safe restore of the app-data docker volume from a backup produced by
# scripts/backup.sh (the same tar-of-the-volume the systemd timer / cron
# job writes to ./backups/).
#
# This turns the previously hand-run, easy-to-get-wrong sequence of `docker
# run` commands (docs/DEPLOY.md §6) into one idempotent, ownership-safe
# script:
#   1. Verifies the chosen backup exists and actually contains relay.db.
#   2. Safety-nets the CURRENT volume (cp -a to ./backups/data-before-restore-<ts>)
#      so a wrong backup never destroys the only copy of your data.
#   3. Wipes the volume and extracts the backup INTO it, preserving the
#      relay user's (uid 100) file ownership so the non-root app/relay
#      containers can keep writing to it (extract as root; tar carries the
#      owner:group through).
#   4. Starts the stack (docker compose up -d) and waits for both services
#      to report healthy.
#   5. Prints next steps (confirm a known account/conversation survived,
#      then remove the -before-restore safety net).
#
# Usage:
#   docker compose down        # REQUIRED first — never wipe under a live DB
#   ./scripts/restore.sh                       # restore the newest backup in ./backups/
#   ./scripts/restore.sh backups/app-data-exact.tar.gz   # pick a specific backup
#
# Restoring rolls back to the backup's point in time — any writes made after
# that backup are gone. Do a supervised dry run of the whole backup→restore
# cycle before you ever need it for real.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose"
BACKUP_DIR="./backups"

log() { echo "[restore] $*"; }
err() { echo "[restore] ERROR: $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "'$1' is required but not installed"; exit 1; }
}

require_cmd docker

# Refuse to wipe a volume under a running stack — the DB holds the files
# open and this would corrupt the very data we're trying to restore.
if [ -n "$(${COMPOSE} ps -q 2>/dev/null)" ]; then
  err "The stack is currently running. Stopping, then wiping, an app-data volume"
  err "under a live DB corrupts the restore. Stop it first and re-run:"
  echo "    docker compose down"
  exit 1
fi

# Resolve the app-data volume from the compose project name (docker compose
# names the volume <project>_app-data). This works with the stack STOPPED,
# unlike backup.sh's inspect-a-running-container approach — restore runs
# exactly when nothing is up. The project name is read from `docker compose
# config`, falling back to the directory name. Contrast with the actual
# name via `docker volume ls` on first use to be sure.
project="$(docker compose config --format json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).name)}catch{console.log('')}})" || true)"
[ -z "$project" ] && project="$(basename "$(pwd)")"
vol="${project}_app-data"

docker volume inspect "$vol" >/dev/null 2>&1 || {
  err "Volume '$vol' not found — the stack must be brought up at least once"
  err "(docker compose up -d then down) so the app-data volume exists."
  exit 1
}
log "App-data volume: $vol"

# ── Pick the backup file ────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
  BACKUP="$1"
else
  BACKUP="$(find "$BACKUP_DIR" -maxdepth 1 -name 'app-data-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)"
  if [ -z "$BACKUP" ]; then
    err "No backup found in $BACKUP_DIR — pass one explicitly: ./scripts/restore.sh <backup.tar.gz>"
    exit 1
  fi
fi

[ -f "$BACKUP" ] || { err "Backup file not found: $BACKUP"; exit 1; }
BACKUP="$(cd "$(dirname "$BACKUP")" && pwd)/$(basename "$BACKUP")" # absolute, for the bind mount

# ── Sanity-check the backup before wiping anything ──────────────────────
# NB: deliberately NOT `grep -q` — under `set -o pipefail` -q exits on the
# first match and closes the pipe, giving tar SIGPIPE and failing the
# pipeline even for a valid backup. Plain grep consumes the whole stream.
if ! tar tzf "$BACKUP" 2>/dev/null | grep -E '(^|/)relay\.db$' >/dev/null; then
  err "Backup '$BACKUP' does not look like an app-data backup (no relay.db inside)."
  err "Refusing to restore — nothing was changed."
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
safety="$BACKUP_DIR/data-before-restore-${ts}"
log "Wiping and restoring volume '$vol' from: $BACKUP"

# Safety-net the current volume first — the one copy that exists right now,
# in case the chosen backup is the wrong one.
log "Safety-netting current volume to $safety ..."
docker run --rm -v "$vol":/data -v "$(pwd)":/backup alpine cp -a /data "/backup/$safety"

log "Clearing volume and extracting backup ..."
docker run --rm -v "$vol":/data alpine sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null || true'
docker run --rm -v "$vol":/data -v "$(dirname "$BACKUP")":/backup alpine \
  tar xzf "/backup/$(basename "$BACKUP")" -C /data

# ── Restart and wait for health ─────────────────────────────────────────
log "Starting the stack ..."
$COMPOSE up -d 2>&1 | tail -2

log "Waiting up to 120s for app + relay to report healthy ..."
elapsed=0
while [ "$elapsed" -lt 120 ]; do
  a="$(docker inspect --format='{{.State.Health.Status}}' "$(${COMPOSE} ps -q app 2>/dev/null)" 2>/dev/null || echo unknown)"
  r="$(docker inspect --format='{{.State.Health.Status}}' "$(${COMPOSE} ps -q relay 2>/dev/null)" 2>/dev/null || echo unknown)"
  if [ "$a" = "healthy" ] && [ "$r" = "healthy" ]; then
    log "Both services healthy."
    log "Recovery-complete. NEXT STEPS:"
    echo "  1. Confirm a known account/conversation actually survived:"
    echo "     curl http://127.0.0.1:3000/api/status"
    echo "  2. Once verified, remove the safety net:"
    echo "     rm -rf backups/data-before-restore-${ts}"
    exit 0
  fi
  if [ "$a" = "unhealthy" ] || [ "$r" = "unhealthy" ]; then
    err "A service became unhealthy during restore (app=$a, relay=$r)."
    err "Your previous data is safe in ./$safety — inspect 'docker compose logs app relay'."
    exit 1
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done
err "Timed out waiting for health after restore (app=$a, relay=$r)."
err "Previous data is safe in ./$safety."
exit 1
