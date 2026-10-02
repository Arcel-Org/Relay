#!/usr/bin/env bash
# Standalone, steady-state backup of the bare-metal/PM2 deployment's data
# directory (sessions, relay.db + its -wal/-shm sidecars) — meant to be run
# on a schedule (cron/systemd timer), not just before a manual update.
#
# This is the bare-metal counterpart to scripts/backup.sh, which only works
# for the Docker deployment (it backs up a named Docker volume via a
# throwaway container — there's no volume at all here, just a plain
# directory on disk). Without this, the bare-metal/PM2 path had NO backup
# mechanism whatsoever: a lost/corrupted disk meant total data loss with no
# recovery, unlike the Docker path.
#
# Usage:
#   ./scripts/backup-bare-metal.sh                  # back up now, prune old backups
#   RELAY_BACKUP_RETAIN=30 ./scripts/backup-bare-metal.sh   # keep 30 most recent instead of the default 14
#   DATA_DIR=/custom/path ./scripts/backup-bare-metal.sh    # match a non-default DATA_DIR
#
# Scheduling (see docs/DEPLOY.md's PM2 Backups section for full examples):
#   cron:     0 3 * * * cd /path/to/Relay && ./scripts/backup-bare-metal.sh >> /var/log/relay-backup.log 2>&1
#   systemd:  deploy/relay-backup-bare-metal.service + deploy/relay-backup-bare-metal.timer (provided in this repo)

set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="./backups"
RETAIN="${RELAY_BACKUP_RETAIN:-14}"
# Must match sqlite-client.ts's own DATA_DIR fallback (path.join(process.cwd(), '.data'))
DATA_DIR="${DATA_DIR:-.data}"

log() { echo "[backup] $*"; }
err() { echo "[backup] ERROR: $*" >&2; }

command -v tar >/dev/null 2>&1 || { err "'tar' is required but not installed"; exit 1; }

if [ ! -d "$DATA_DIR" ]; then
  err "Data directory '$DATA_DIR' does not exist — is the app running, or is DATA_DIR set correctly? Nothing to back up."
  exit 1
fi

mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/app-data-${ts}.tar.gz"

# Safe to run while the app is live, same trust model scripts/backup.sh
# already relies on for the Docker path: WAL mode's -wal/-shm sidecars are
# archived alongside relay.db in one tar invocation, so a reader restoring
# from this snapshot gets a self-consistent set of files rather than a torn
# read across the main file and an in-flight WAL. This is not a substitute
# for a hot/point-in-time backup tool (e.g. Litestream, mentioned in
# docs/DEPLOY.md) if you need a stronger RPO guarantee.
log "Backing up $DATA_DIR to $out"
tar czf "$out" -C "$DATA_DIR" . || { err "Backup failed"; exit 1; }
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
