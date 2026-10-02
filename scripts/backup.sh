#!/usr/bin/env bash
# Standalone, steady-state backup of the app-data docker volume (sessions,
# users.db, etc.) — meant to be run on a schedule (cron/systemd timer), not
# just as a side effect of running update.sh.
#
# Without this, the only backup that ever happens is the one update.sh takes
# right before a deploy — if the host disk is lost on an ordinary day with no
# deploy in between, there is nothing to restore from. This script is the
# same safe, no-downtime tar-of-the-volume approach update.sh already uses,
# extracted so it can run independently and more often.
#
# Usage:
#   ./scripts/backup.sh                  # back up now, prune old backups
#   RELAY_BACKUP_RETAIN=30 ./scripts/backup.sh   # keep 30 most recent instead of the default 14
#
# Scheduling (see docs/DEPLOY.md's Backups section for full examples):
#   cron:     0 3 * * * cd /path/to/Relay && ./scripts/backup.sh >> /var/log/relay-backup.log 2>&1
#   systemd:  deploy/relay-backup.service + deploy/relay-backup.timer (provided in this repo)

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose"
BACKUP_DIR="./backups"
RETAIN="${RELAY_BACKUP_RETAIN:-14}"

log() { echo "[backup] $*"; }
err() { echo "[backup] ERROR: $*" >&2; }

command -v docker >/dev/null 2>&1 || { err "'docker' is required but not installed"; exit 1; }
command -v tar >/dev/null 2>&1 || { err "'tar' is required but not installed"; exit 1; }

# Don't guess the compose-generated volume name (it depends on the project
# name, which docker compose derives from the directory name with its own
# sanitization rules) — ask a running container what it's actually mounted
# to. Falls back to the app service, then relay. Same logic as update.sh's
# resolve_app_data_volume — kept in sync manually since these are two
# independently-invoked scripts, not a shared library.
resolve_app_data_volume() {
  local vol
  vol="$(docker inspect --format='{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' "$(${COMPOSE} ps -q app 2>/dev/null)" 2>/dev/null || true)"
  if [ -z "$vol" ]; then
    vol="$(docker inspect --format='{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' "$(${COMPOSE} ps -q relay 2>/dev/null)" 2>/dev/null || true)"
  fi
  echo "$vol"
}

mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
vol="$(resolve_app_data_volume)"

if [ -z "$vol" ]; then
  err "No running app-data volume found — is the stack up (docker compose ps)? Nothing to back up."
  exit 1
fi

out="$BACKUP_DIR/app-data-${ts}.tar.gz"
log "Backing up app-data volume ($vol) to $out"
docker run --rm \
  -v "${vol}:/data:ro" \
  -v "$(pwd)/$BACKUP_DIR:/backup" \
  alpine:latest \
  tar czf "/backup/app-data-${ts}.tar.gz" -C /data . \
  || { err "Backup failed"; exit 1; }
log "Backup complete: $out"

backup_count="$(find "$BACKUP_DIR" -maxdepth 1 -name 'app-data-*.tar.gz' | wc -l | tr -d ' ')"
if [ "$backup_count" -gt "$RETAIN" ]; then
  log "Pruning old backups (keeping the $RETAIN most recent)..."
  find "$BACKUP_DIR" -maxdepth 1 -name 'app-data-*.tar.gz' -print0 \
    | xargs -0 ls -1t \
    | tail -n "+$((RETAIN + 1))" \
    | xargs -r rm -f
fi

log "Done. $(find "$BACKUP_DIR" -maxdepth 1 -name 'app-data-*.tar.gz' | wc -l | tr -d ' ') backup(s) retained in $BACKUP_DIR."
