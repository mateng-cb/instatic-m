#!/usr/bin/env sh
# backup-site.sh — consistent backup of one deployed site (SQLite + uploads).
#
# Backs up, for a given deploy/<site>/ directory:
#   1. data/cms.db    via SQLite's online backup API (`VACUUM INTO`) — safe to
#                     run while the app is running, no locking or downtime.
#   2. uploads/       tar.gz of all uploaded media.
#
# Retention: snapshots older than RETAIN_DAYS days are deleted.
#
# Usage (install this script in /opt/sites/, where each site is a subdir):
#   /opt/sites/backup-site.sh ditexpo              # → /opt/sites/backups/ditexpo/
#   /opt/sites/backup-site.sh ditexpo /backup/dir  # custom output dir
#
# Cron (nightly 03:17):
#   17 3 * * * /opt/sites/backup-site.sh ditexpo >> /opt/sites/backup.log 2>&1
#
# Docs: docs/deployment/backup-restore.md, docs/deployment/multi-site.md

set -eu

SITE_DIR="${1:?usage: backup-site.sh <site-dir> [backup-dir]}"
BACKUP_DIR="${2:-$(dirname "$0")/backups/$(basename "$SITE_DIR")}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

DB="${SITE_DIR%/}/data/cms.db"
UPLOADS="${SITE_DIR%/}/uploads"

[ -f "$DB" ] || { echo "backup-site.sh: no database at $DB" >&2; exit 1; }
[ -d "$UPLOADS" ] || { echo "backup-site.sh: no uploads dir at $UPLOADS" >&2; exit 1; }

STAMP="$(date +%F)"
mkdir -p "$BACKUP_DIR"

# 1. Database snapshot — VACUUM INTO writes a fully consistent copy to a new
#    file; safe while the CMS is live.
sqlite3 "$DB" ".backup '$BACKUP_DIR/cms-$STAMP.db'"

# 2. Uploaded media.
tar czf "$BACKUP_DIR/uploads-$STAMP.tgz" -C "$UPLOADS" .

# 3. Retention.
find "$BACKUP_DIR" -type f \( -name 'cms-*.db' -o -name 'uploads-*.tgz' \) \
  -mtime "+$RETAIN_DAYS" -delete

echo "backup-site.sh: wrote $BACKUP_DIR/cms-$STAMP.db and $BACKUP_DIR/uploads-$STAMP.tgz"
